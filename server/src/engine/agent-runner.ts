// Bucle de un agente: LLM → (herramientas → LLM)* → respuesta final.
import { ZERO_USAGE, type Agent, type RunEventType, type Settings, type Usage } from '../../../shared/types';
import type { Store } from '../db/store';
import { ConfigError, LimitError, LlmError, ToolError } from '../errors';
import type { ChatMessage, LlmFactory, ToolSchema } from '../llm/types';
import type { ToolRegistry } from '../tools/registry';
import { addUsage, errorMessage, stringifyResult, truncate } from '../util';

export const MAX_DELEGATION_DEPTH = 2;
const MAX_TOOL_RESULT_CHARS = 12_000;

/** Presupuesto de llamadas LLM compartido por todos los agentes de una ejecución. */
export interface Budget {
  llmCalls: number;
  readonly maxLlmCalls: number;
}

export interface AgentRunContext {
  store: Store;
  tools: ToolRegistry;
  llm: LlmFactory;
  settings: Settings;
  workspaceDir: string;
  runId: string;
  nodeId: string;
  signal: AbortSignal;
  memory: Map<string, string>;
  budget: Budget;
  emit: (type: RunEventType, data: Record<string, any>, transient?: boolean) => void;
  /** Se invoca con cada incremento de uso (también de sub-agentes), para no perderlo si el agente falla. */
  onUsage?: (delta: Usage) => void;
}

export interface AgentRunResult {
  output: string;
  usage: Usage;
}

function buildSystemPrompt(agent: Agent, hasTools: boolean): string {
  const parts = [`Eres «${agent.name}»${agent.role ? `, ${agent.role}` : ''}.`];
  if (agent.systemPrompt.trim()) parts.push(agent.systemPrompt.trim());
  if (hasTools) {
    parts.push(
      'Dispones de herramientas. Úsalas cuando necesites datos reales o realizar acciones; nunca inventes sus resultados. Cuando tengas lo necesario, da tu respuesta final.',
    );
  }
  return parts.join('\n\n');
}

export async function runAgent(agent: Agent, input: string, ctx: AgentRunContext, depth = 0): Promise<AgentRunResult> {
  const provider = ctx.store.getProviderWithSecret(agent.providerId);
  if (!provider) throw new ConfigError(`El agente «${agent.name}» usa un proveedor que ya no existe.`);
  if (!provider.enabled) throw new ConfigError(`El proveedor «${provider.name}» está desactivado.`);
  if (!agent.model.trim()) throw new ConfigError(`El agente «${agent.name}» no tiene modelo configurado.`);
  const client = ctx.llm.create(provider);

  // Solo se ofrecen al modelo las herramientas del agente que existen y están activas.
  const schemas: ToolSchema[] = [];
  for (const name of agent.tools) {
    const tool = ctx.tools.get(name);
    if (!tool) continue;
    if (name === 'delegate_task') {
      if (depth >= MAX_DELEGATION_DEPTH) continue;
      const others = ctx.store.listAgents().filter((a) => a.id !== agent.id);
      if (!others.length) continue;
      const roster = others.map((a) => `- ${a.name}: ${a.role || a.description || 'sin descripción'}`).join('\n');
      schemas.push({ name, description: `${tool.description}\nAgentes disponibles:\n${roster}`, parameters: tool.parameters });
    } else {
      schemas.push({ name, description: tool.description, parameters: tool.parameters });
    }
  }
  const allowed = new Set(schemas.map((s) => s.name));

  let usage: Usage = { ...ZERO_USAGE };
  const track = (delta: Partial<Usage>) => {
    usage = addUsage(usage, delta);
    ctx.onUsage?.(addUsage(ZERO_USAGE, delta));
  };
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(agent, schemas.length > 0) },
    { role: 'user', content: input },
  ];
  const maxIterations = Math.max(1, agent.maxIterations);
  // Llamadas que ya fallaron (nombre+argumentos): si el modelo las repite idénticas no se vuelven a ejecutar.
  const failedCalls = new Set<string>();
  const meta = { agent: agent.name, agentId: agent.id, depth };

  for (let iteration = 1; ; iteration++) {
    // Tras agotar las iteraciones se hace una última llamada sin herramientas para forzar la respuesta final.
    const finalTurn = iteration > maxIterations;
    if (ctx.signal.aborted) throw ctx.signal.reason;
    if (ctx.budget.llmCalls >= ctx.budget.maxLlmCalls) {
      throw new LimitError(`Se alcanzó el límite de ${ctx.budget.maxLlmCalls} llamadas al modelo para esta ejecución.`);
    }
    ctx.budget.llmCalls++;
    ctx.emit('llm.start', { ...meta, iteration, model: agent.model });

    const res = await client.chat({
      model: agent.model,
      messages,
      tools: finalTurn || !schemas.length ? undefined : schemas,
      temperature: agent.temperature,
      maxTokens: agent.maxTokens,
      think: agent.thinking,
      signal: ctx.signal,
      onDelta: (text) => ctx.emit('llm.delta', { ...meta, text }, true),
      onThinking: (text) => ctx.emit('llm.thinking', { ...meta, text }, true),
    });
    track({ ...res.usage, llmCalls: 1 });
    const toolCalls = finalTurn ? [] : res.toolCalls;
    ctx.emit('llm.message', {
      ...meta,
      iteration,
      content: res.content,
      thinking: res.thinking ? truncate(res.thinking, 8000) : undefined,
      toolCalls: toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
      usage: res.usage,
      // La respuesta se cortó por el límite de tokens de salida: lo que sigue puede estar incompleto.
      ...(res.finishReason === 'length' ? { truncated: true } : {}),
    });

    if (!toolCalls.length) {
      if (!res.content.trim()) {
        throw new LlmError(`El modelo ${agent.model} devolvió una respuesta vacía.`, { retryable: true });
      }
      return { output: res.content.trim(), usage };
    }

    messages.push({ role: 'assistant', content: res.content, toolCalls });
    for (const call of toolCalls) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      ctx.emit('tool.call', { ...meta, id: call.id, name: call.name, arguments: call.arguments });
      track({ toolCalls: 1 });
      const started = Date.now();
      const signature = `${call.name}:${JSON.stringify(call.arguments)}`;
      let ok = true;
      let resultText: string;
      try {
        if (failedCalls.has(signature)) {
          throw new ToolError("Ya hiciste esta misma llamada y falló. No la repitas: prueba con otros argumentos o responde con lo que sabes.");
        }
        if (!allowed.has(call.name)) {
          throw new ToolError(`La herramienta "${call.name}" no está disponible. Disponibles: ${[...allowed].join(', ') || 'ninguna'}.`);
        }
        if (call.invalidArguments !== undefined) {
          // No se ejecuta una herramienta con argumentos a medias: se le dice al modelo para que los repita bien.
          throw new ToolError(
            `Los argumentos de "${call.name}" no son JSON válido${res.finishReason === 'length' ? ' (la respuesta se cortó por el límite de tokens)' : ''}: ${truncate(call.invalidArguments, 200)}. Repite la llamada con un objeto JSON completo.`,
          );
        }
        const result = await ctx.tools.invoke(call.name, call.arguments, {
          runId: ctx.runId,
          nodeId: ctx.nodeId,
          signal: ctx.signal,
          workspaceDir: ctx.workspaceDir,
          settings: ctx.settings,
          memory: ctx.memory,
          agentName: agent.name,
          delegate: async (target, task) => {
            const wanted = target.trim().toLowerCase();
            const other = ctx.store.listAgents().find((a) => a.id === target || a.name.trim().toLowerCase() === wanted);
            if (!other) throw new ToolError(`No existe ningún agente llamado "${target}".`);
            if (other.id === agent.id) throw new ToolError('Un agente no puede delegar en sí mismo.');
            // El uso del sub-agente se notifica por ctx.onUsage; aquí solo se suma al total devuelto.
            const sub = await runAgent(other, task, ctx, depth + 1);
            usage = addUsage(usage, sub.usage);
            return sub.output;
          },
        });
        resultText = truncate(stringifyResult(result), MAX_TOOL_RESULT_CHARS);
      } catch (err) {
        // La cancelación y los límites se propagan; el resto de errores se devuelven al modelo para que reaccione.
        if (ctx.signal.aborted) throw ctx.signal.reason;
        if (err instanceof LimitError) throw err;
        ok = false;
        failedCalls.add(signature);
        resultText = `Error: ${errorMessage(err)}`;
      }
      ctx.emit('tool.result', { ...meta, id: call.id, name: call.name, ok, result: resultText, durationMs: Date.now() - started });
      messages.push({ role: 'tool', content: resultText, toolCallId: call.id, name: call.name });
    }

    if (iteration === maxIterations) {
      messages.push({
        role: 'user',
        content:
          'Has alcanzado el límite de pasos con herramientas. Da ahora tu respuesta final con la información que ya tienes.',
      });
    }
  }
}
