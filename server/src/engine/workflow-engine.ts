// Planificador de workflows: ejecuta un DAG de nodos respetando dependencias, con paralelismo,
// ramas condicionales, reintentos, timeouts, límites y cancelación.
import { topologicalOrder } from '../../../shared/graph';
import { parseList } from '../../../shared/list';
import { renderTemplate } from '../../../shared/template';
import {
  DEFAULT_WORKFLOW_SETTINGS,
  FOREACH_DEFAULTS,
  ZERO_USAGE,
  type Run,
  type RunEventType,
  type RunStatus,
  type Settings,
  type StepStatus,
  type Usage,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowSettings,
} from '../../../shared/types';
import type { Store } from '../db/store';
import { ConfigError, isRetryable } from '../errors';
import type { LlmFactory } from '../llm/types';
import type { ToolRegistry } from '../tools/registry';
import { addUsage, errorMessage, localDate, nowIso, raceAbort, sleep, stringifyResult, truncate } from '../util';
import { runAgent, type Budget } from './agent-runner';
import { regexTest } from './regex';

const MAX_OUTPUT_CHARS = 200_000;
/** Tope del tiempo máximo de un nodo: 6 horas (AbortSignal.timeout no admite valores de 2^31 ms o más). */
export const MAX_NODE_TIMEOUT_MS = 6 * 3_600_000;

/** Interpreta un número escrito con coma o punto decimal y, si los hay, separadores de miles («1.234,5», «1,234.5»). */
function parseNumber(text: string): number {
  let t = text.trim().replace(/\s+/g, '');
  if (!t) return NaN;
  const comma = t.lastIndexOf(',');
  const dot = t.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    // El separador que aparece el último es el decimal; el otro, el de miles.
    t = comma > dot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (comma >= 0) {
    t = t.indexOf(',') === comma ? t.replace(',', '.') : t.replace(/,/g, '');
  }
  return Number(t);
}

export type EmitFn = (type: RunEventType, nodeId: string | null, data: Record<string, any>, transient?: boolean) => void;

export interface EngineDeps {
  store: Store;
  tools: ToolRegistry;
  llm: LlmFactory;
  settings: Settings;
  workspaceDir: string;
  emit: EmitFn;
  /** Retardo base de reintento (ms). Configurable para que los tests no esperen. */
  retryBaseDelayMs?: number;
}

export interface ExecutionResult {
  status: RunStatus;
  output: string | null;
  error: string | null;
  usage: Usage;
}

export async function evaluateCondition(left: string, operator: string, right: string, signal?: AbortSignal): Promise<boolean> {
  const l = left.trim();
  const r = right.trim();
  switch (operator) {
    case 'contains':
      return l.toLowerCase().includes(r.toLowerCase());
    case 'not_contains':
      return !l.toLowerCase().includes(r.toLowerCase());
    case 'equals':
      return l.toLowerCase() === r.toLowerCase();
    case 'not_equals':
      return l.toLowerCase() !== r.toLowerCase();
    case 'matches':
      // En un hilo aparte y con límite de tiempo: una expresión maliciosa o torpe no puede congelar el servidor.
      return regexTest(right, left, { signal });
    case 'gt':
    case 'lt': {
      const a = parseNumber(l);
      const b = parseNumber(r);
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        throw new ConfigError(`La condición numérica necesita números; se recibió "${truncate(l, 40)}" y "${truncate(r, 40)}".`);
      }
      return operator === 'gt' ? a > b : a < b;
    }
    case 'is_empty':
      return l === '';
    case 'not_empty':
      return l !== '';
    default:
      throw new ConfigError(`Operador de condición desconocido: ${operator}`);
  }
}

export class WorkflowExecution {
  private readonly nodes: WorkflowNode[];
  private readonly nodeById = new Map<string, WorkflowNode>();
  private readonly incoming = new Map<string, WorkflowEdge[]>();
  private readonly settings: WorkflowSettings;
  private readonly status = new Map<string, StepStatus>();
  private readonly outputs = new Map<string, string>();
  private readonly errors = new Map<string, string>();
  private readonly memory = new Map<string, string>();
  private readonly budget: Budget;
  private readonly deadline: AbortSignal;
  private readonly failFast = new AbortController();
  private readonly signal: AbortSignal;
  private usage: Usage = { ...ZERO_USAGE };

  constructor(
    private readonly deps: EngineDeps,
    private readonly run: Run,
    private readonly external: AbortSignal,
    /** Salidas reutilizadas de una ejecución anterior (reintento desde el fallo). */
    seeded: Map<string, string> = new Map(),
  ) {
    const wf = run.snapshot.workflow;
    this.nodes = wf.nodes;
    this.settings = { ...DEFAULT_WORKFLOW_SETTINGS, ...wf.settings };
    for (const n of this.nodes) {
      this.nodeById.set(n.id, n);
      this.incoming.set(n.id, []);
      this.status.set(n.id, 'pending');
    }
    for (const e of wf.edges) this.incoming.get(e.target)?.push(e);
    for (const [nodeId, output] of seeded) {
      if (!this.nodeById.has(nodeId)) continue;
      this.status.set(nodeId, 'completed');
      this.outputs.set(nodeId, output);
    }
    this.budget = { llmCalls: 0, maxLlmCalls: this.settings.maxLlmCalls };
    this.deadline = AbortSignal.timeout(this.settings.maxDurationMs);
    this.signal = AbortSignal.any([external, this.deadline, this.failFast.signal]);
  }

  async execute(): Promise<ExecutionResult> {
    const order = topologicalOrder(this.nodes, this.run.snapshot.workflow.edges);
    if (!order) return { status: 'failed', output: null, error: 'El workflow contiene un ciclo.', usage: this.usage };

    const running = new Map<string, Promise<void>>();
    const maxConcurrency = Math.max(1, this.settings.maxConcurrency);

    try {
      await this.schedule(order, running, maxConcurrency);
    } finally {
      // Pase lo que pase (también un error inesperado del propio motor), ningún nodo sigue trabajando por su
      // cuenta después de que la ejecución haya terminado: se abortan y se espera a que acaben.
      if (running.size) this.failFast.abort(new Error('La ejecución ha terminado.'));
      await Promise.allSettled(running.values());
    }

    // Lo que no llegó a ejecutarse queda cancelado.
    for (const id of order) {
      if (this.status.get(id) === 'pending') {
        this.status.set(id, 'cancelled');
        this.deps.store.updateStep(this.run.id, id, { status: 'cancelled', finishedAt: nowIso() });
        this.deps.emit('step.finished', id, { status: 'cancelled' });
      }
    }
    return this.buildResult(order);
  }

  /** Bucle del planificador: salta, lanza y espera hasta que no queda nada por hacer o se aborta la ejecución. */
  private async schedule(order: string[], running: Map<string, Promise<void>>, maxConcurrency: number): Promise<void> {
    while (!this.signal.aborted) {
      // 1) Propagar saltos: ramas no tomadas y dependencias fallidas (puede encadenarse).
      for (let changed = true; changed; ) {
        changed = false;
        for (const id of order) {
          if (this.status.get(id) === 'pending' && this.decide(id) === 'skip') {
            this.skip(id);
            changed = true;
          }
        }
      }
      // 2) Lanzar en paralelo los nodos listos, hasta el límite de concurrencia.
      for (const id of order) {
        if (running.size >= maxConcurrency) break;
        if (this.status.get(id) !== 'pending' || this.decide(id) !== 'run') continue;
        this.status.set(id, 'running');
        const node = this.nodeById.get(id)!;
        running.set(
          id,
          this.executeNode(node).finally(() => running.delete(id)),
        );
      }
      if (running.size === 0) break;
      // 3) Esperar a que termine cualquiera y volver a planificar.
      await Promise.race(running.values());
      if (this.settings.onError === 'fail' && [...this.status.values()].includes('failed')) {
        this.failFast.abort(new Error('Otro nodo ha fallado.'));
      }
    }
  }

  /** Decide si un nodo pendiente puede ejecutarse ya, debe esperar o debe saltarse. */
  private decide(nodeId: string): 'run' | 'wait' | 'skip' {
    const edges = this.incoming.get(nodeId)!;
    if (!edges.length) return 'run';
    let active = 0;
    let parentFailed = false;
    for (const e of edges) {
      const st = this.status.get(e.source);
      if (st === 'pending' || st === 'running') return 'wait';
      if (st === 'failed' || st === 'cancelled') parentFailed = true;
      else if (st === 'completed') {
        const src = this.nodeById.get(e.source)!;
        // Una arista que sale de una condición solo está activa si coincide con su resultado.
        if (src.type !== 'condition' || (e.sourceHandle ?? 'true') === this.outputs.get(e.source)) active++;
      }
    }
    return parentFailed || active === 0 ? 'skip' : 'run';
  }

  private skip(nodeId: string): void {
    this.status.set(nodeId, 'skipped');
    const parentFailed = this.incoming
      .get(nodeId)!
      .some((e) => ['failed', 'cancelled'].includes(this.status.get(e.source)!));
    this.deps.store.updateStep(this.run.id, nodeId, { status: 'skipped', finishedAt: nowIso() });
    this.deps.emit('step.skipped', nodeId, { reason: parentFailed ? 'Una dependencia ha fallado.' : 'Rama no tomada.' });
  }

  /** Ejecuta un nodo. Nunca rechaza: cualquier fallo, también uno inesperado, deja el paso cerrado como fallido. */
  private async executeNode(node: WorkflowNode): Promise<void> {
    try {
      await this.attemptNode(node);
    } catch (err) {
      const message = `Error interno al ejecutar el nodo: ${errorMessage(err)}`;
      this.status.set(node.id, 'failed');
      this.errors.set(node.id, message);
      try {
        this.deps.store.updateStep(this.run.id, node.id, { status: 'failed', error: message, finishedAt: nowIso() });
        this.deps.emit('step.finished', node.id, { status: 'failed', error: message });
      } catch {
        /* si ni siquiera se puede escribir, el gestor de ejecuciones cierra los pasos que queden abiertos */
      }
    }
  }

  private async attemptNode(node: WorkflowNode): Promise<void> {
    const { store, emit } = this.deps;
    // En «para cada» los reintentos se aplican a cada elemento, no al nodo entero (ver runForeach).
    const retriable = node.type === 'agent' || node.type === 'tool';
    const retries = retriable ? Math.min(Math.max(Number(node.config?.retries ?? this.settings.defaultRetries) || 0, 0), 5) : 0;
    const timeoutMs = retriable || node.type === 'foreach' ? Math.min(Math.max(Math.round(Number(node.config?.timeoutMs) || 0), 0), MAX_NODE_TIMEOUT_MS) : 0;
    const startedAt = nowIso();
    const startMs = Date.now();
    let stepUsage: Usage = { ...ZERO_USAGE };
    const trackUsage = (u: Usage) => {
      stepUsage = addUsage(stepUsage, u);
      this.usage = addUsage(this.usage, u);
    };

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      store.updateStep(this.run.id, node.id, { status: 'running', attempt, startedAt, error: null });
      emit('step.started', node.id, { attempt, maxAttempts: retries + 1 });
      const nodeTimeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
      const signal = nodeTimeout ? AbortSignal.any([this.signal, nodeTimeout]) : this.signal;

      try {
        // En carrera con la señal: una herramienta que ignore la cancelación no puede retener la ejecución.
        const output = truncate(await raceAbort(this.runNodeBody(node, signal, trackUsage), signal), MAX_OUTPUT_CHARS);
        this.outputs.set(node.id, output);
        this.status.set(node.id, 'completed');
        store.updateStep(this.run.id, node.id, { status: 'completed', output, usage: stepUsage, finishedAt: nowIso() });
        store.updateRun(this.run.id, { usage: this.usage });
        emit('step.finished', node.id, { status: 'completed', output, usage: stepUsage, durationMs: Date.now() - startMs });
        return;
      } catch (err) {
        // ¿Se ha abortado la ejecución entera (cancelación, límite de duración u otro nodo fallido)?
        if (this.signal.aborted) {
          this.status.set(node.id, 'cancelled');
          store.updateStep(this.run.id, node.id, { status: 'cancelled', usage: stepUsage, finishedAt: nowIso() });
          emit('step.finished', node.id, { status: 'cancelled', usage: stepUsage, durationMs: Date.now() - startMs });
          return;
        }
        const timedOut = Boolean(nodeTimeout?.aborted);
        const message = timedOut ? `El nodo superó su tiempo máximo (${timeoutMs} ms).` : errorMessage(err);
        if (attempt <= retries && (timedOut || isRetryable(err))) {
          const delayMs = (this.deps.retryBaseDelayMs ?? 1000) * 2 ** (attempt - 1);
          emit('step.retry', node.id, { attempt, error: message, delayMs });
          try {
            await sleep(delayMs, this.signal);
          } catch {
            /* abortado durante la espera: la siguiente vuelta lo detecta */
          }
          if (!this.signal.aborted) continue;
          this.status.set(node.id, 'cancelled');
          store.updateStep(this.run.id, node.id, { status: 'cancelled', usage: stepUsage, finishedAt: nowIso() });
          emit('step.finished', node.id, { status: 'cancelled', usage: stepUsage, durationMs: Date.now() - startMs });
          return;
        }
        this.status.set(node.id, 'failed');
        this.errors.set(node.id, message);
        store.updateStep(this.run.id, node.id, { status: 'failed', error: message, usage: stepUsage, finishedAt: nowIso() });
        store.updateRun(this.run.id, { usage: this.usage });
        emit('step.finished', node.id, { status: 'failed', error: message, usage: stepUsage, durationMs: Date.now() - startMs });
        return;
      }
    }
  }

  private async runNodeBody(node: WorkflowNode, signal: AbortSignal, trackUsage: (u: Usage) => void): Promise<string> {
    const cfg = node.config ?? {};
    const { store } = this.deps;
    switch (node.type) {
      case 'input':
        return this.run.input || String(cfg.defaultValue ?? '');

      case 'agent': {
        const agent = this.run.snapshot.agents[cfg.agentId];
        if (!agent) throw new ConfigError(`El nodo "${node.label || node.id}" no tiene un agente válido.`);
        const prompt = this.render(String(cfg.prompt || '{{upstream}}'), node);
        if (!prompt.trim()) throw new ConfigError(`El nodo "${node.label || node.id}" generó un prompt vacío.`);
        store.updateStep(this.run.id, node.id, { input: prompt });
        const result = await runAgent(agent, prompt, {
          store,
          tools: this.deps.tools,
          llm: this.deps.llm,
          settings: this.deps.settings,
          workspaceDir: this.deps.workspaceDir,
          runId: this.run.id,
          nodeId: node.id,
          signal,
          memory: this.memory,
          budget: this.budget,
          emit: (type, data, transient) => this.deps.emit(type, node.id, data, transient),
          onUsage: trackUsage,
        });
        return result.output;
      }

      case 'tool': {
        const args = this.renderDeep(cfg.args ?? {}, node) as Record<string, unknown>;
        store.updateStep(this.run.id, node.id, { input: JSON.stringify(args, null, 2) });
        this.deps.emit('tool.call', node.id, { id: node.id, name: cfg.tool, arguments: args });
        trackUsage({ ...ZERO_USAGE, toolCalls: 1 });
        const started = Date.now();
        try {
          const result = stringifyResult(
            await this.deps.tools.invoke(String(cfg.tool), args, {
              runId: this.run.id,
              nodeId: node.id,
              signal,
              workspaceDir: this.deps.workspaceDir,
              settings: this.deps.settings,
              memory: this.memory,
            }),
          );
          this.deps.emit('tool.result', node.id, {
            id: node.id,
            name: cfg.tool,
            ok: true,
            result: truncate(result, 12_000),
            durationMs: Date.now() - started,
          });
          return result;
        } catch (err) {
          if (!signal.aborted) {
            this.deps.emit('tool.result', node.id, {
              id: node.id,
              name: cfg.tool,
              ok: false,
              result: `Error: ${errorMessage(err)}`,
              durationMs: Date.now() - started,
            });
          }
          throw err;
        }
      }

      case 'condition': {
        const left = this.render(String(cfg.left || '{{upstream}}'), node);
        const right = this.render(String(cfg.right ?? ''), node);
        store.updateStep(this.run.id, node.id, { input: `${truncate(left, 2000)}\n${cfg.operator} ${right}` });
        return String(await evaluateCondition(left, String(cfg.operator), right, signal));
      }

      case 'transform':
        return this.render(String(cfg.template ?? ''), node);

      case 'foreach':
        return this.runForeach(node, signal, trackUsage);

      case 'output':
        return this.render(String(cfg.template || '{{upstream}}'), node);

      default:
        throw new ConfigError(`Tipo de nodo desconocido: ${String(node.type)}`);
    }
  }

  /**
   * Nodo «para cada»: ejecuta el agente una vez por elemento de la lista, con concurrencia limitada.
   * Los reintentos se aplican por elemento; si uno falla definitivamente, se detienen los demás y falla el nodo.
   */
  private async runForeach(node: WorkflowNode, signal: AbortSignal, trackUsage: (u: Usage) => void): Promise<string> {
    const cfg = node.config ?? {};
    const { store, emit } = this.deps;
    const name = node.label || node.id;
    const agent = this.run.snapshot.agents[cfg.agentId];
    if (!agent) throw new ConfigError(`El nodo "${name}" no tiene un agente válido.`);

    const clamp = (value: unknown, fallback: number, max: number) => Math.min(Math.max(Math.round(Number(value) || fallback), 1), max);
    const concurrency = clamp(cfg.concurrency, FOREACH_DEFAULTS.concurrency, FOREACH_DEFAULTS.maxConcurrency);
    const maxItems = clamp(cfg.maxItems, FOREACH_DEFAULTS.maxItems, FOREACH_DEFAULTS.hardMaxItems);
    const retries = Math.min(Math.max(Number(cfg.retries ?? this.settings.defaultRetries) || 0, 0), 5);

    const items = parseList(this.render(String(cfg.items || '{{upstream}}'), node));
    store.updateStep(this.run.id, node.id, { input: JSON.stringify(items, null, 2) });
    if (items.length > maxItems) {
      throw new ConfigError(`"${name}" recibió ${items.length} elementos y su máximo es ${maxItems}. Reduce la lista o sube el límite del nodo.`);
    }
    const total = items.length;
    const results = new Array<string>(total);
    const states = new Array<'pending' | 'running' | 'done'>(total).fill('pending');
    // Resumen en vivo para el monitor (transitorio: no se guarda).
    const progress = () => {
      const done = states.filter((s) => s === 'done').length;
      const lines = items.map((item, i) => `${states[i] === 'done' ? '✓' : states[i] === 'running' ? '⏳' : '·'} ${i + 1}. ${truncate(item, 80)}`);
      emit('llm.snapshot', node.id, { text: `**${done} de ${total} elementos completados**\n\n${lines.join('  \n')}` }, true);
    };

    const siblings = new AbortController();
    const itemSignal = AbortSignal.any([signal, siblings.signal]);
    let failure: unknown = null;
    let next = 0;

    const runItem = async (index: number): Promise<void> => {
      const item = items[index];
      const prompt = this.render(String(cfg.prompt || '{{item}}'), node, { item, index: String(index + 1), total: String(total) });
      if (!prompt.trim()) throw new ConfigError(`El nodo "${name}" generó una tarea vacía para el elemento ${index + 1}.`);
      for (let attempt = 1; ; attempt++) {
        states[index] = 'running';
        emit('foreach.item', node.id, { index, total, item: truncate(item, 300), status: 'started', attempt });
        progress();
        const started = Date.now();
        try {
          const result = await runAgent(agent, prompt, {
            store,
            tools: this.deps.tools,
            llm: this.deps.llm,
            settings: this.deps.settings,
            workspaceDir: this.deps.workspaceDir,
            runId: this.run.id,
            nodeId: node.id,
            signal: itemSignal,
            memory: this.memory,
            budget: this.budget,
            // La actividad de cada elemento se anida un nivel (como la de un agente delegado) y sus llamadas a
            // herramientas se etiquetan con el índice, para que no se mezclen entre elementos en paralelo.
            emit: (type, data, transient) =>
              emit(type, node.id, { ...data, depth: (data.depth ?? 0) + 1, item: index, ...(data.id !== undefined ? { id: `${index}:${data.id}` } : {}) }, transient),
            onUsage: trackUsage,
          });
          results[index] = result.output;
          states[index] = 'done';
          emit('foreach.item', node.id, { index, total, item: truncate(item, 300), status: 'completed', durationMs: Date.now() - started });
          progress();
          return;
        } catch (err) {
          if (itemSignal.aborted) throw err;
          const message = errorMessage(err);
          if (attempt <= retries && isRetryable(err)) {
            const delayMs = (this.deps.retryBaseDelayMs ?? 1000) * 2 ** (attempt - 1);
            emit('foreach.item', node.id, { index, total, item: truncate(item, 300), status: 'retry', attempt, error: message, delayMs });
            await sleep(delayMs, itemSignal);
            continue;
          }
          emit('foreach.item', node.id, { index, total, item: truncate(item, 300), status: 'failed', error: message });
          throw new ConfigError(`Elemento ${index + 1} de ${total} («${truncate(item, 60)}»): ${message}`);
        }
      }
    };

    const worker = async (): Promise<void> => {
      while (!itemSignal.aborted && next < total) {
        const index = next++;
        try {
          await runItem(index);
        } catch (err) {
          failure ??= err;
          siblings.abort(new Error('Otro elemento ha fallado.'));
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
    if (signal.aborted) throw signal.reason ?? new Error('Cancelado');
    if (failure) throw failure;

    if (cfg.format === 'json') return JSON.stringify(results, null, 2);
    return items.map((item, i) => `### ${i + 1}. ${truncate(item, 120)}\n\n${results[i]}`).join('\n\n');
  }

  /** Sustituye las referencias {{...}} de una plantilla con los resultados disponibles. */
  private render(template: string, node: WorkflowNode, extra: Record<string, string> = {}): string {
    return renderTemplate(template, (ref) => {
      if (Object.hasOwn(extra, ref)) return extra[ref];
      if (ref === 'input') return this.run.input;
      // Fecha local del servidor: con la fecha UTC, un workflow lanzado poco después de medianoche recibía la de ayer.
      if (ref === 'date') return localDate();
      if (ref === 'upstream') return this.upstreamText(node);
      const id = ref.endsWith('.output') ? ref.slice(0, -7) : ref;
      return this.outputs.get(id);
    });
  }

  private renderDeep(value: unknown, node: WorkflowNode): unknown {
    if (typeof value === 'string') return this.render(value, node);
    if (Array.isArray(value)) return value.map((v) => this.renderDeep(v, node));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.renderDeep(v, node)]));
    }
    return value;
  }

  /** Texto combinado de los padres directos completados (las condiciones no aportan contenido). */
  private upstreamText(node: WorkflowNode): string {
    const parents = this.incoming
      .get(node.id)!
      .map((e) => this.nodeById.get(e.source)!)
      .filter((p, i, arr) => arr.indexOf(p) === i)
      .filter((p) => p.type !== 'condition' && this.status.get(p.id) === 'completed');
    if (parents.length === 1) return this.outputs.get(parents[0].id) ?? '';
    return parents.map((p) => `### ${p.label || p.id}\n${this.outputs.get(p.id) ?? ''}`).join('\n\n');
  }

  private buildResult(order: string[]): ExecutionResult {
    const completed = (id: string) => this.status.get(id) === 'completed';
    const outputNodes = order.filter((id) => this.nodeById.get(id)!.type === 'output');
    // Sin nodos de salida explícitos, el resultado son las hojas del grafo.
    const hasChildren = new Set(this.run.snapshot.workflow.edges.map((e) => e.source));
    const terminals = outputNodes.length ? outputNodes : order.filter((id) => !hasChildren.has(id));
    const produced = terminals.filter(completed);
    const output = produced.length ? produced.map((id) => this.outputs.get(id) ?? '').join('\n\n') : null;

    if (this.external.aborted) {
      return { status: 'cancelled', output, error: 'Ejecución cancelada por el usuario.', usage: this.usage };
    }
    if (this.deadline.aborted) {
      const secs = Math.round(this.settings.maxDurationMs / 1000);
      return { status: 'failed', output, error: `Se superó la duración máxima de la ejecución (${secs} s).`, usage: this.usage };
    }
    const failed = order.filter((id) => this.status.get(id) === 'failed');
    if (failed.length && (this.settings.onError === 'fail' || !produced.length)) {
      const first = this.nodeById.get(failed[0])!;
      return {
        status: 'failed',
        output,
        error: `El nodo "${first.label || first.id}" falló: ${this.errors.get(first.id)}`,
        usage: this.usage,
      };
    }
    if (!produced.length) {
      return { status: 'failed', output: null, error: 'Ningún nodo de salida llegó a ejecutarse.', usage: this.usage };
    }
    return { status: 'completed', output, error: null, usage: this.usage };
  }
}
