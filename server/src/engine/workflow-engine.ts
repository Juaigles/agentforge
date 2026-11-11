// Planificador de workflows: ejecuta un DAG de nodos respetando dependencias, con paralelismo,
// ramas condicionales, reintentos, timeouts, límites y cancelación.
import { foreachBody, isBranchingNode, topologicalOrder } from '../../../shared/graph';
import { parseList } from '../../../shared/list';
import { renderTemplate } from '../../../shared/template';
import {
  DEFAULT_WORKFLOW_SETTINGS,
  FOREACH_DEFAULTS,
  ZERO_USAGE,
  type Run,
  type RunEventType,
  type RunStatus,
  type RunStepItem,
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
  /**
   * Lanza otro workflow como parte de esta ejecución y espera a que termine. Lo aporta el gestor de
   * ejecuciones, que crea la subejecución (visible en el historial y enlazada con esta).
   */
  runSubworkflow?: (opts: { nodeId: string; workflowId: string; input: string; signal: AbortSignal }) => Promise<ExecutionResult & { runId: string }>;
  /** Pide una aprobación humana y espera la decisión. */
  requestApproval?: (opts: { nodeId: string; message: string; signal: AbortSignal }) => Promise<{ approved: boolean; comment: string }>;
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

/**
 * Memoria compartida de una ejecución. Es un Map normal para las herramientas, pero cada cambio se guarda en
 * la base de datos: así reanudar tras un apagado o reintentar desde el fallo conserva lo que ya se había anotado.
 */
export class RunMemory extends Map<string, string> {
  private readonly persist: { save: (key: string, value: string) => void; remove: (key?: string) => void } | null = null;

  constructor(store: Store, runId: string) {
    super();
    for (const [key, value] of store.listMemory(runId)) super.set(key, value);
    this.persist = { save: (key, value) => store.saveMemory(runId, key, value), remove: (key) => store.deleteMemory(runId, key) };
  }

  override set(key: string, value: string): this {
    super.set(key, value);
    this.persist?.save(key, value);
    return this;
  }

  override delete(key: string): boolean {
    const existed = super.delete(key);
    if (existed) this.persist?.remove(key);
    return existed;
  }

  override clear(): void {
    super.clear();
    this.persist?.remove();
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
  private readonly memory: Map<string, string>;
  private readonly budget: Budget;
  // Límite de duración de la ejecución. Es un temporizador propio (no AbortSignal.timeout) porque se detiene
  // mientras la ejecución espera a una persona: una aprobación que tarda horas no consume el tiempo máximo.
  private readonly deadlineCtl = new AbortController();
  private readonly deadline: AbortSignal = this.deadlineCtl.signal;
  private deadlineTimer: NodeJS.Timeout | null = null;
  private deadlineLeftMs = 0;
  private deadlineStartedAt = 0;
  private deadlinePauses = 0;
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
    this.memory = new RunMemory(deps.store, run.id);
    this.budget = { llmCalls: 0, maxLlmCalls: this.settings.maxLlmCalls };
    this.deadlineLeftMs = this.settings.maxDurationMs;
    this.signal = AbortSignal.any([external, this.deadline, this.failFast.signal]);
  }

  private startDeadline(): void {
    if (this.deadlineTimer || this.deadline.aborted) return;
    this.deadlineStartedAt = Date.now();
    this.deadlineTimer = setTimeout(() => this.deadlineCtl.abort(new Error('Duración máxima superada.')), Math.max(0, this.deadlineLeftMs));
  }

  private stopDeadline(): void {
    if (!this.deadlineTimer) return;
    clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
    this.deadlineLeftMs -= Date.now() - this.deadlineStartedAt;
  }

  /** Ejecuta `fn` sin que el tiempo que tarde cuente para la duración máxima (esperas a una persona). */
  private async withoutDeadline<T>(fn: () => Promise<T>): Promise<T> {
    if (this.deadlinePauses++ === 0) this.stopDeadline();
    try {
      return await fn();
    } finally {
      if (--this.deadlinePauses === 0) this.startDeadline();
    }
  }

  async execute(): Promise<ExecutionResult> {
    const order = topologicalOrder(this.nodes, this.run.snapshot.workflow.edges);
    if (!order) return { status: 'failed', output: null, error: 'El workflow contiene un ciclo.', usage: this.usage };

    const running = new Map<string, Promise<void>>();
    const maxConcurrency = Math.max(1, this.settings.maxConcurrency);

    this.startDeadline();
    try {
      await this.schedule(order, running, maxConcurrency);
    } finally {
      this.stopDeadline();
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
        // Una arista que sale de una condición o de una aprobación solo está activa si coincide con su resultado.
        if (!isBranchingNode(src) || (e.sourceHandle ?? 'true') === this.outputs.get(e.source)) active++;
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
    const retriable = node.type === 'agent' || node.type === 'tool' || node.type === 'subworkflow';
    const retries = retriable ? Math.min(Math.max(Number(node.config?.retries ?? this.settings.defaultRetries) || 0, 0), 5) : 0;
    const timed = retriable || node.type === 'foreach' || node.type === 'approval';
    const timeoutMs = timed ? Math.min(Math.max(Math.round(Number(node.config?.timeoutMs) || 0), 0), MAX_NODE_TIMEOUT_MS) : 0;
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

      case 'subworkflow': {
        const input = this.render(String(cfg.input || '{{upstream}}'), node);
        store.updateStep(this.run.id, node.id, { input });
        return this.runChildWorkflow(node, String(cfg.workflowId ?? ''), input, signal, trackUsage);
      }

      case 'approval': {
        if (!this.deps.requestApproval) throw new ConfigError('Las aprobaciones no están disponibles en este contexto.');
        const message = this.render(String(cfg.message ?? ''), node).trim();
        if (!message) throw new ConfigError(`La aprobación "${node.label || node.id}" no tiene nada que preguntar.`);
        store.updateStep(this.run.id, node.id, { input: message });
        // Mientras se espera a la persona, el reloj de la duración máxima se detiene.
        const decision = await this.withoutDeadline(() => this.deps.requestApproval!({ nodeId: node.id, message, signal }));
        this.outputs.set(`${node.id}.comment`, decision.comment);
        return String(decision.approved);
      }

      case 'output':
        return this.render(String(cfg.template || '{{upstream}}'), node);

      default:
        throw new ConfigError(`Tipo de nodo desconocido: ${String(node.type)}`);
    }
  }

  /** Lanza un subworkflow y devuelve su salida; si falla, falla el nodo con el motivo. */
  private async runChildWorkflow(node: WorkflowNode, workflowId: string, input: string, signal: AbortSignal, trackUsage: (u: Usage) => void): Promise<string> {
    if (!this.deps.runSubworkflow) throw new ConfigError('Los subworkflows no están disponibles en este contexto.');
    const result = await this.deps.runSubworkflow({ nodeId: node.id, workflowId, input, signal });
    trackUsage(result.usage);
    if (signal.aborted) throw signal.reason ?? new Error('Cancelado');
    if (result.status !== 'completed') throw new ConfigError(result.error ?? 'El subworkflow no terminó correctamente.');
    return result.output ?? '';
  }

  /**
   * Nodo «para cada»: ejecuta su cuerpo (un agente, una herramienta o un subworkflow) una vez por elemento de la
   * lista, con concurrencia limitada. Los reintentos se aplican por elemento. Si un elemento falla
   * definitivamente, según `onItemError` se detiene el nodo ('fail') o se sigue con los demás ('continue').
   * El resultado de cada elemento se guarda: al reintentar la ejecución, los ya completados no se repiten.
   */
  private async runForeach(node: WorkflowNode, signal: AbortSignal, trackUsage: (u: Usage) => void): Promise<string> {
    const cfg = node.config ?? {};
    const { store, emit } = this.deps;
    const name = node.label || node.id;
    const body = foreachBody(node);
    const agent = body === 'agent' ? this.run.snapshot.agents[cfg.agentId] : undefined;
    if (body === 'agent' && !agent) throw new ConfigError(`El nodo "${name}" no tiene un agente válido.`);
    const keepGoing = cfg.onItemError === 'continue';

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
    const errors = new Array<string | null>(total).fill(null);
    const states = new Array<'pending' | 'running' | 'done' | 'failed'>(total).fill('pending');

    // Elementos ya completados en una ejecución anterior (reintento desde el fallo): se reutilizan si el elemento
    // en esa posición es el mismo.
    const previous = new Map(store.listStepItems(this.run.id, node.id).map((it) => [it.index, it]));
    for (let i = 0; i < total; i++) {
      const done = previous.get(i);
      if (done?.status === 'completed' && done.item === items[i] && done.output !== null) {
        results[i] = done.output;
        states[i] = 'done';
        emit('foreach.item', node.id, { index: i, total, item: truncate(items[i], 300), status: 'reused' });
      }
    }

    // Resumen en vivo para el monitor (transitorio: no se guarda).
    const progress = () => {
      const done = states.filter((s) => s === 'done').length;
      const mark = { done: '✓', running: '⏳', failed: '✗', pending: '·' };
      const lines = items.map((item, i) => `${mark[states[i]]} ${i + 1}. ${truncate(item, 80)}`);
      emit('llm.snapshot', node.id, { text: `**${done} de ${total} elementos completados**\n\n${lines.join('  \n')}` }, true);
    };

    const siblings = new AbortController();
    const itemSignal = AbortSignal.any([signal, siblings.signal]);
    let failure: unknown = null;
    let next = 0;

    /** Ejecuta el cuerpo para un elemento y devuelve su resultado. */
    const runBody = async (index: number, extra: Record<string, string>): Promise<string> => {
      if (body === 'tool') {
        const args = this.renderDeep(cfg.args ?? {}, node, extra) as Record<string, unknown>;
        const callId = `${index}:${node.id}`;
        emit('tool.call', node.id, { id: callId, name: cfg.tool, arguments: args, depth: 1, item: index });
        trackUsage({ ...ZERO_USAGE, toolCalls: 1 });
        const started = Date.now();
        try {
          const result = stringifyResult(
            await this.deps.tools.invoke(String(cfg.tool), args, {
              runId: this.run.id,
              nodeId: node.id,
              signal: itemSignal,
              workspaceDir: this.deps.workspaceDir,
              settings: this.deps.settings,
              memory: this.memory,
            }),
          );
          emit('tool.result', node.id, { id: callId, name: cfg.tool, ok: true, result: truncate(result, 12_000), durationMs: Date.now() - started, depth: 1, item: index });
          return result;
        } catch (err) {
          if (!itemSignal.aborted) {
            emit('tool.result', node.id, { id: callId, name: cfg.tool, ok: false, result: `Error: ${errorMessage(err)}`, durationMs: Date.now() - started, depth: 1, item: index });
          }
          throw err;
        }
      }
      if (body === 'subworkflow') {
        const input = this.render(String(cfg.input || '{{item}}'), node, extra);
        return this.runChildWorkflow(node, String(cfg.workflowId ?? ''), input, itemSignal, trackUsage);
      }
      const prompt = this.render(String(cfg.prompt || '{{item}}'), node, extra);
      if (!prompt.trim()) throw new ConfigError(`El nodo "${name}" generó una tarea vacía para el elemento ${index + 1}.`);
      const result = await runAgent(agent!, prompt, {
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
      return result.output;
    };

    const runItem = async (index: number): Promise<void> => {
      const item = items[index];
      const extra = { item, index: String(index + 1), total: String(total) };
      for (let attempt = 1; ; attempt++) {
        states[index] = 'running';
        emit('foreach.item', node.id, { index, total, item: truncate(item, 300), status: 'started', attempt });
        progress();
        const started = Date.now();
        try {
          results[index] = truncate(await runBody(index, extra), MAX_OUTPUT_CHARS);
          states[index] = 'done';
          store.saveStepItem(this.run.id, node.id, { index, item, status: 'completed', output: results[index], error: null });
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
          states[index] = 'failed';
          errors[index] = message;
          store.saveStepItem(this.run.id, node.id, { index, item, status: 'failed', output: null, error: message } satisfies RunStepItem);
          emit('foreach.item', node.id, { index, total, item: truncate(item, 300), status: 'failed', error: message });
          progress();
          if (keepGoing) return;
          throw new ConfigError(`Elemento ${index + 1} de ${total} («${truncate(item, 60)}»): ${message}`);
        }
      }
    };

    const worker = async (): Promise<void> => {
      while (!itemSignal.aborted && next < total) {
        const index = next++;
        if (states[index] === 'done') continue; // reutilizado
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

    const failed = errors.filter((e) => e !== null).length;
    if (failed && failed === total) {
      throw new ConfigError(`Han fallado los ${total} elementos de "${name}". El primero: ${errors.find((e) => e !== null)}`);
    }
    if (cfg.format === 'json') {
      return JSON.stringify(
        items.map((_item, i) => (errors[i] !== null ? { error: errors[i] } : results[i])),
        null,
        2,
      );
    }
    const sections = items.map((item, i) => `### ${i + 1}. ${truncate(item, 120)}\n\n${errors[i] !== null ? `⚠ No se pudo completar: ${errors[i]}` : results[i]}`);
    if (failed) sections.push(`_${failed} de ${total} elementos no se pudieron completar._`);
    return sections.join('\n\n');
  }

  /** Sustituye las referencias {{...}} de una plantilla con los resultados disponibles. */
  private render(template: string, node: WorkflowNode, extra: Record<string, string> = {}): string {
    return renderTemplate(template, (ref) => {
      if (Object.hasOwn(extra, ref)) return extra[ref];
      if (ref === 'input') return this.run.input;
      // Fecha local del servidor: con la fecha UTC, un workflow lanzado poco después de medianoche recibía la de ayer.
      if (ref === 'date') return localDate();
      if (ref === 'upstream') return this.upstreamText(node);
      if (ref.endsWith('.comment')) return this.outputs.get(ref) ?? '';
      const id = ref.endsWith('.output') ? ref.slice(0, -7) : ref;
      return this.outputs.get(id);
    });
  }

  private renderDeep(value: unknown, node: WorkflowNode, extra: Record<string, string> = {}): unknown {
    if (typeof value === 'string') return this.render(value, node, extra);
    if (Array.isArray(value)) return value.map((v) => this.renderDeep(v, node, extra));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.renderDeep(v, node, extra)]));
    }
    return value;
  }

  /** Texto combinado de los padres directos completados (las condiciones no aportan contenido). */
  private upstreamText(node: WorkflowNode): string {
    const parents = this.incoming
      .get(node.id)!
      .map((e) => this.nodeById.get(e.source)!)
      .filter((p, i, arr) => arr.indexOf(p) === i)
      .filter((p) => !isBranchingNode(p) && this.status.get(p.id) === 'completed');
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
