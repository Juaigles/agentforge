// Gestor de ejecuciones: crea runs, los encola, limita la concurrencia global, permite cancelar
// y publica los eventos (persistidos y transitorios) para la monitorización en tiempo real.
import { EventEmitter } from 'node:events';
import { topologicalOrder } from '../../../shared/graph';
import {
  DEFAULT_WORKFLOW_SETTINGS,
  type Agent,
  type Run,
  type RunEvent,
  type RunEventType,
  type RunSummary,
  type Workflow,
  type WorkflowDefinition,
} from '../../../shared/types';
import type { Store } from '../db/store';
import type { LlmFactory } from '../llm/types';
import type { ToolRegistry } from '../tools/registry';
import { errorMessage, nowIso } from '../util';
import { WorkflowExecution } from './workflow-engine';

export interface RunManagerDeps {
  store: Store;
  tools: ToolRegistry;
  llm: LlmFactory;
  workspaceDir: string;
  retryBaseDelayMs?: number;
  /** Se llama cada vez que termina una ejecución (p. ej. para aplicar la retención del historial). */
  onRunFinished?: () => void;
}

interface ActiveRun {
  controller: AbortController;
  /** Texto parcial en streaming por nodo, para clientes que se conectan a mitad de una respuesta. */
  partials: Map<string, string>;
  done: Promise<void>;
}

export class RunManager {
  private readonly emitter = new EventEmitter();
  private readonly active = new Map<string, ActiveRun>();
  private readonly queue: Array<{ runId: string; seeded: Map<string, string> }> = [];
  private readonly waiters = new Map<string, Array<() => void>>();

  constructor(private readonly deps: RunManagerDeps) {
    this.emitter.setMaxListeners(0);
  }

  // ---------- Suscripciones ----------
  subscribe(runId: string, listener: (ev: RunEvent) => void): () => void {
    this.emitter.on(`run:${runId}`, listener);
    return () => this.emitter.off(`run:${runId}`, listener);
  }

  /** Cambios de estado de cualquier ejecución (para listas y dashboard en vivo). */
  subscribeRuns(listener: (run: RunSummary) => void): () => void {
    this.emitter.on('runs', listener);
    return () => this.emitter.off('runs', listener);
  }

  partials(runId: string): Array<{ nodeId: string; text: string }> {
    const entry = this.active.get(runId);
    return entry ? [...entry.partials].filter(([, text]) => text).map(([nodeId, text]) => ({ nodeId, text })) : [];
  }

  get activeCount(): number {
    return this.active.size;
  }
  get queuedCount(): number {
    return this.queue.length;
  }

  private emit(runId: string, type: RunEventType, nodeId: string | null, data: Record<string, any>, transient = false): void {
    const partials = this.active.get(runId)?.partials;
    if (partials && nodeId) {
      if (type === 'llm.delta' && !data.depth) partials.set(nodeId, (partials.get(nodeId) ?? '') + data.text);
      else if (type === 'llm.start' || type === 'llm.message' || type === 'step.finished') partials.delete(nodeId);
    }
    const event: RunEvent = transient
      ? { seq: null, runId, ts: nowIso(), type, nodeId, data }
      : this.deps.store.appendEvent(runId, type, nodeId, data);
    this.emitter.emit(`run:${runId}`, event);
  }

  private publishRun(runId: string): void {
    const summary = this.deps.store.getRunSummary(runId);
    if (summary) this.emitter.emit('runs', summary);
  }

  // ---------- Creación ----------
  startWorkflowRun(workflow: Workflow, input: string, opts: { scheduled?: boolean } = {}): Run {
    const agents: Record<string, Agent> = {};
    for (const node of workflow.nodes) {
      if (node.type !== 'agent' && node.type !== 'foreach') continue;
      const agent = this.deps.store.getAgent(node.config?.agentId);
      if (agent) agents[agent.id] = agent;
    }
    const definition: WorkflowDefinition = { nodes: workflow.nodes, edges: workflow.edges, settings: workflow.settings };
    const run = this.deps.store.createRun({
      kind: 'workflow',
      workflowId: workflow.id,
      agentId: null,
      name: workflow.name,
      input,
      scheduled: opts.scheduled,
      snapshot: { workflow: definition, agents },
      steps: this.stepsFor(definition),
    });
    this.enqueue(run.id, new Map());
    return run;
  }

  /** Una ejecución de agente individual es un workflow de un solo nodo. */
  startAgentRun(agent: Agent, input: string, limits: Partial<typeof DEFAULT_WORKFLOW_SETTINGS> = {}): Run {
    const definition: WorkflowDefinition = {
      nodes: [
        { id: 'agent', type: 'agent', label: agent.name, position: { x: 0, y: 0 }, config: { agentId: agent.id, prompt: '{{input}}' } },
      ],
      edges: [],
      settings: { ...DEFAULT_WORKFLOW_SETTINGS, maxConcurrency: 1, ...limits },
    };
    const run = this.deps.store.createRun({
      kind: 'agent',
      workflowId: null,
      agentId: agent.id,
      name: agent.name,
      input,
      snapshot: { workflow: definition, agents: { [agent.id]: agent } },
      steps: this.stepsFor(definition),
    });
    this.enqueue(run.id, new Map());
    return run;
  }

  /**
   * Reintenta una ejecución con la misma definición e input.
   * mode 'all': desde cero. mode 'failed': reutiliza las salidas de los nodos que ya terminaron bien.
   */
  retryRun(original: Run, mode: 'all' | 'failed'): Run {
    const run = this.deps.store.createRun({
      kind: original.kind,
      workflowId: original.workflowId,
      agentId: original.agentId,
      name: original.name,
      input: original.input,
      snapshot: original.snapshot,
      retryOf: original.id,
      steps: this.stepsFor(original.snapshot.workflow),
    });
    // Reintentarla es la forma de atender una ejecución interrumpida: deja de ofrecerse la reanudación.
    this.deps.store.clearInterrupted([original.id]);
    const seeded = new Map<string, string>();
    if (mode === 'failed') {
      for (const step of original.steps) {
        if (step.status !== 'completed' || step.output === null) continue;
        seeded.set(step.nodeId, step.output);
        this.deps.store.updateStep(run.id, step.nodeId, {
          status: 'completed',
          input: step.input,
          output: step.output,
          startedAt: step.startedAt,
          finishedAt: step.finishedAt,
        });
        this.deps.store.appendEvent(run.id, 'step.reused', step.nodeId, { from: original.id, output: step.output });
      }
    }
    this.enqueue(run.id, seeded);
    return this.deps.store.getRun(run.id)!;
  }

  private stepsFor(def: WorkflowDefinition) {
    // Los pasos se guardan en orden de ejecución (topológico), no en el orden en que se dibujaron.
    const order = topologicalOrder(def.nodes, def.edges);
    const rank = new Map((order ?? []).map((id, i) => [id, i]));
    const sorted = [...def.nodes].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    return sorted.map((n) => ({
      nodeId: n.id,
      nodeType: n.type,
      label: n.label || n.id,
      agentId: n.type === 'agent' || n.type === 'foreach' ? (n.config?.agentId ?? null) : null,
    }));
  }

  // ---------- Cola y ejecución ----------
  private enqueue(runId: string, seeded: Map<string, string>): void {
    this.queue.push({ runId, seeded });
    this.publishRun(runId);
    // La ejecución empieza en el siguiente tick para que quien la creó reciba primero la respuesta.
    setImmediate(() => this.pump());
  }

  private pump(): void {
    const max = Math.max(1, this.deps.store.getSettings().maxConcurrentRuns);
    while (this.active.size < max && this.queue.length) {
      const { runId, seeded } = this.queue.shift()!;
      const controller = new AbortController();
      const entry: ActiveRun = { controller, partials: new Map(), done: Promise.resolve() };
      this.active.set(runId, entry);
      entry.done = this.execute(runId, controller.signal, seeded).finally(() => {
        this.active.delete(runId);
        this.deps.store.releaseRun(runId);
        for (const resolve of this.waiters.get(runId) ?? []) resolve();
        this.waiters.delete(runId);
        try {
          this.deps.onRunFinished?.();
        } catch {
          /* la retención es secundaria: no debe afectar a la cola */
        }
        this.pump();
      });
    }
  }

  private async execute(runId: string, signal: AbortSignal, seeded: Map<string, string>): Promise<void> {
    const { store } = this.deps;
    const run = store.getRun(runId);
    if (!run) return;
    store.updateRun(runId, { status: 'running', startedAt: nowIso() });
    this.emit(runId, 'run.started', null, { name: run.name, kind: run.kind });
    this.publishRun(runId);

    let result;
    try {
      const execution = new WorkflowExecution(
        {
          store,
          tools: this.deps.tools,
          llm: this.deps.llm,
          settings: store.getSettings(),
          workspaceDir: this.deps.workspaceDir,
          retryBaseDelayMs: this.deps.retryBaseDelayMs,
          emit: (type, nodeId, data, transient) => {
            this.emit(runId, type, nodeId, data, transient);
            if (type === 'step.finished') this.publishRun(runId);
          },
        },
        run,
        signal,
        seeded,
      );
      result = await execution.execute();
    } catch (err) {
      // Error inesperado del propio motor: la ejecución se cierra como fallida en lugar de quedar colgada.
      result = { status: 'failed' as const, output: null, error: `Error interno del motor: ${errorMessage(err)}`, usage: run.usage };
    }
    store.updateRun(runId, {
      status: result.status,
      output: result.output,
      error: result.error,
      usage: result.usage,
      finishedAt: nowIso(),
    });
    this.emit(runId, 'run.finished', null, { status: result.status, output: result.output, error: result.error, usage: result.usage });
    this.publishRun(runId);
  }

  // ---------- Control ----------
  /** Cancela una ejecución en cola o en curso. Devuelve false si ya había terminado. */
  cancel(runId: string): boolean {
    const queuedIndex = this.queue.findIndex((q) => q.runId === runId);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      const now = nowIso();
      for (const step of this.deps.store.listSteps(runId)) {
        if (step.status === 'pending') this.deps.store.updateStep(runId, step.nodeId, { status: 'cancelled', finishedAt: now });
      }
      this.deps.store.updateRun(runId, { status: 'cancelled', error: 'Ejecución cancelada antes de empezar.', finishedAt: now });
      this.emit(runId, 'run.finished', null, { status: 'cancelled', error: 'Ejecución cancelada antes de empezar.' });
      this.deps.store.releaseRun(runId);
      this.publishRun(runId);
      for (const resolve of this.waiters.get(runId) ?? []) resolve();
      this.waiters.delete(runId);
      return true;
    }
    const entry = this.active.get(runId);
    if (!entry) return false;
    entry.controller.abort(new Error('Ejecución cancelada por el usuario.'));
    return true;
  }

  isActive(runId: string): boolean {
    return this.active.has(runId) || this.queue.some((q) => q.runId === runId);
  }

  /** Resuelve cuando la ejecución ha terminado (o inmediatamente si no está activa). */
  waitFor(runId: string): Promise<void> {
    if (!this.isActive(runId)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.waiters.get(runId) ?? [];
      list.push(resolve);
      this.waiters.set(runId, list);
    });
  }

  /** Cancela todo y espera a que termine (apagado ordenado). */
  async shutdown(): Promise<void> {
    for (const { runId } of [...this.queue]) this.cancel(runId);
    const pending = [...this.active.values()].map((a) => a.done);
    for (const entry of this.active.values()) entry.controller.abort(new Error('Servidor detenido.'));
    await Promise.allSettled(pending);
  }
}
