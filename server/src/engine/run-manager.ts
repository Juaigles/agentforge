// Gestor de ejecuciones: crea runs, los encola, limita la concurrencia global, permite cancelar
// y publica los eventos (persistidos y transitorios) para la monitorización en tiempo real.
import { EventEmitter } from 'node:events';
import { nodeSubworkflowId, nodeUsesAgent, topologicalOrder } from '../../../shared/graph';
import {
  DEFAULT_WORKFLOW_SETTINGS,
  MAX_SUBWORKFLOW_DEPTH,
  type Agent,
  type Approval,
  type Run,
  type RunEvent,
  type RunEventType,
  type RunSnapshot,
  type RunSummary,
  type TriggerKind,
  type Workflow,
  type WorkflowDefinition,
} from '../../../shared/types';
import type { Store } from '../db/store';
import type { LlmFactory } from '../llm/types';
import type { ToolRegistry } from '../tools/registry';
import { ConfigError, HttpError, ShutdownSignal } from '../errors';
import { errorMessage, nowIso, silentLogger, type Logger } from '../util';
import { WorkflowExecution, type ExecutionResult } from './workflow-engine';

export interface RunManagerDeps {
  store: Store;
  tools: ToolRegistry;
  llm: LlmFactory;
  workspaceDir: string;
  retryBaseDelayMs?: number;
  /** Se llama cada vez que termina una ejecución (p. ej. para aplicar la retención del historial). */
  onRunFinished?: () => void;
  /** Registro del ciclo de vida de las ejecuciones (por defecto, ninguno). */
  log?: () => Logger;
}

/** Ventana en la que se agrupan los fragmentos de texto del modelo antes de emitirlos (ms). */
const DELTA_WINDOW_MS = 33;

interface PendingDelta {
  type: RunEventType;
  nodeId: string;
  data: Record<string, any>;
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
  /** Aprobaciones a la espera de una decisión: quien la toma resuelve la promesa en la que el nodo está parado. */
  private readonly approvals = new Map<string, { runId: string; nodeId: string; resolve: (d: { approved: boolean; comment: string }) => void }>();
  /** Ejecuciones (de primer nivel) detenidas esperando a una persona: no ocupan un hueco de ejecución. */
  private readonly waitingRuns = new Map<string, number>();
  /** Ejecución de primer nivel a la que pertenece cada subejecución en curso. */
  private readonly rootOf = new Map<string, string>();

  constructor(private readonly deps: RunManagerDeps) {
    this.emitter.setMaxListeners(0);
  }

  private get log(): Logger {
    return this.deps.log?.() ?? silentLogger;
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

  /** Fragmentos de texto pendientes de emitir, por ejecución y por origen (nodo, tipo, agente, elemento). */
  private readonly deltas = new Map<string, { timer: NodeJS.Timeout; pending: Map<string, PendingDelta> }>();

  private emit(runId: string, type: RunEventType, nodeId: string | null, data: Record<string, any>, transient = false): void {
    const partials = this.active.get(runId)?.partials;
    if (partials && nodeId) {
      if (type === 'llm.delta' && !data.depth) partials.set(nodeId, (partials.get(nodeId) ?? '') + data.text);
      else if (type === 'llm.start' || type === 'llm.message' || type === 'step.finished') {
        // Un paso que se cancela o falla con el modelo a media respuesta conserva lo que llevaba escrito.
        const partial = partials.get(nodeId);
        if (type === 'step.finished' && data.status !== 'completed' && partial) {
          this.deps.store.updateStep(runId, nodeId, { partialOutput: partial });
          data = { ...data, partialOutput: partial };
        }
        partials.delete(nodeId);
      }
    }
    // Un modelo emite decenas de fragmentos por segundo. Enviarlos uno a uno multiplica los mensajes SSE, las
    // serializaciones y los repintados del navegador; se agrupan en ventanas cortas, imperceptibles a la vista.
    if (transient && nodeId && (type === 'llm.delta' || type === 'llm.thinking') && typeof data.text === 'string') {
      let entry = this.deltas.get(runId);
      if (!entry) {
        entry = { timer: setTimeout(() => this.flushDeltas(runId), DELTA_WINDOW_MS), pending: new Map() };
        this.deltas.set(runId, entry);
      }
      const key = `${nodeId}|${type}|${data.depth ?? 0}|${data.item ?? ''}|${data.agentId ?? ''}`;
      const pending = entry.pending.get(key);
      if (pending) pending.data.text += data.text;
      else entry.pending.set(key, { type, nodeId, data: { ...data } });
      return;
    }
    // Cualquier otro evento va detrás del texto que ya se había generado: el orden se conserva.
    this.flushDeltas(runId);
    const event: RunEvent = transient
      ? { seq: null, runId, ts: nowIso(), type, nodeId, data }
      : this.deps.store.appendEvent(runId, type, nodeId, data);
    this.emitter.emit(`run:${runId}`, event);
  }

  private flushDeltas(runId: string): void {
    const entry = this.deltas.get(runId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.deltas.delete(runId);
    const ts = nowIso();
    for (const { type, nodeId, data } of entry.pending.values()) {
      this.emitter.emit(`run:${runId}`, { seq: null, runId, ts, type, nodeId, data } satisfies RunEvent);
    }
  }

  private publishRun(runId: string): void {
    const summary = this.deps.store.getRunSummary(runId);
    if (summary) this.emitter.emit('runs', summary);
  }

  // ---------- Creación ----------
  /**
   * Instantánea de un workflow: su definición, los agentes que usa y, de forma recursiva, los workflows que
   * lanza como subworkflow (con sus agentes). Así la ejecución entera es reproducible aunque luego se editen.
   */
  private snapshotOf(workflow: Workflow): RunSnapshot {
    const agents: Record<string, Agent> = {};
    const subworkflows: NonNullable<RunSnapshot['subworkflows']> = {};
    const collect = (nodes: Workflow['nodes'], depth: number): void => {
      for (const node of nodes) {
        if (nodeUsesAgent(node)) {
          const agent = this.deps.store.getAgent(node.config?.agentId);
          if (agent) agents[agent.id] = agent;
        }
        const childId = nodeSubworkflowId(node);
        if (!childId || childId in subworkflows || childId === workflow.id || depth >= MAX_SUBWORKFLOW_DEPTH) continue;
        const child = this.deps.store.getWorkflow(childId);
        if (!child) continue;
        subworkflows[childId] = { name: child.name, definition: { nodes: child.nodes, edges: child.edges, settings: child.settings } };
        collect(child.nodes, depth + 1);
      }
    };
    collect(workflow.nodes, 1);
    const snapshot: RunSnapshot = { workflow: { nodes: workflow.nodes, edges: workflow.edges, settings: workflow.settings }, agents };
    if (Object.keys(subworkflows).length) snapshot.subworkflows = subworkflows;
    return snapshot;
  }

  startWorkflowRun(workflow: Workflow, input: string, opts: { scheduled?: boolean; triggerKind?: TriggerKind } = {}): Run {
    const snapshot = this.snapshotOf(workflow);
    const definition = snapshot.workflow;
    const run = this.deps.store.createRun({
      kind: 'workflow',
      workflowId: workflow.id,
      agentId: null,
      name: workflow.name,
      input,
      scheduled: opts.scheduled,
      triggerKind: opts.triggerKind ?? null,
      snapshot,
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
      // Con los pasos reutilizados viaja también lo que guardaron en la memoria compartida: un paso posterior
      // que la consulte debe encontrar lo mismo que habría encontrado en la ejecución original.
      this.deps.store.copyMemory(original.id, run.id);
      // Y los elementos de «para cada» que ya se completaron: al repetir ese nodo solo se procesan los que faltan.
      this.deps.store.copyCompletedStepItems(original.id, run.id);
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
      agentId: nodeUsesAgent(n) ? (n.config?.agentId ?? null) : null,
    }));
  }

  // ---------- Cola y ejecución ----------
  private enqueue(runId: string, seeded: Map<string, string>): void {
    this.queue.push({ runId, seeded });
    this.publishRun(runId);
    // La ejecución empieza en el siguiente tick para que quien la creó reciba primero la respuesta.
    setImmediate(() => this.pump());
  }

  private closed = false;

  private pump(): void {
    if (this.closed) return;
    const max = Math.max(1, this.deps.store.getSettings().maxConcurrentRuns);
    // Las ejecuciones detenidas esperando una aprobación no cuentan: no están usando el modelo ni el equipo.
    while (this.active.size - this.waitingRuns.size < max && this.queue.length) {
      const { runId, seeded } = this.queue.shift()!;
      const controller = new AbortController();
      const entry: ActiveRun = { controller, partials: new Map(), done: Promise.resolve() };
      this.active.set(runId, entry);
      entry.done = this.execute(runId, controller.signal, seeded)
        .then(() => undefined)
        .catch((err) => {
          // Ni siquiera se pudo cerrar la ejecución (base de datos ocupada, disco lleno): que no tumbe el proceso.
          this.log.error({ err, runId }, 'No se pudo cerrar la ejecución');
        })
        .finally(() => {
          this.active.delete(runId);
          for (const resolve of this.waiters.get(runId) ?? []) resolve();
          this.waiters.delete(runId);
          if (this.closed) return;
          try {
            this.deps.store.releaseRun(runId);
            this.deps.onRunFinished?.();
            this.pump();
          } catch (err) {
            // La retención y el arranque de la siguiente son secundarios: no deben acabar en un rechazo sin dueño.
            this.log.warn({ err, runId }, 'Fallo al terminar la ejecución (retención o cola)');
          }
        });
    }
  }

  private async execute(runId: string, signal: AbortSignal, seeded: Map<string, string>, depth = 1): Promise<ExecutionResult | null> {
    const { store } = this.deps;
    const run = store.getRun(runId);
    if (!run) return null;
    store.updateRun(runId, { status: 'running', startedAt: nowIso() });
    this.emit(runId, 'run.started', null, { name: run.name, kind: run.kind });
    this.publishRun(runId);
    this.log.info({ runId, kind: run.kind, name: run.name }, 'Ejecución iniciada');

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
          runSubworkflow: (opts) => this.runSubworkflow(run, depth, opts),
          requestApproval: (opts) => this.requestApproval(run, opts),
        },
        run,
        signal,
        seeded,
      );
      result = await execution.execute();
    } catch (err) {
      // Error inesperado del propio motor: la ejecución se cierra como fallida en lugar de quedar colgada.
      this.log.error({ err, runId }, 'Error interno del motor');
      result = { status: 'failed' as const, output: null, error: `Error interno del motor: ${errorMessage(err)}`, usage: run.usage };
      // Ningún paso debe quedar «en curso» en una ejecución que ya ha terminado.
      const now = nowIso();
      for (const step of store.listSteps(runId)) {
        if (step.status === 'pending' || step.status === 'running') store.updateStep(runId, step.nodeId, { status: 'cancelled', finishedAt: now });
      }
    }
    // Apagado del servidor: la ejecución no se cierra aquí. Queda «en curso» y `shutdown` la marca como
    // interrumpida, igual que si el proceso hubiera muerto de golpe, para que se pueda reanudar al volver.
    if (signal.reason instanceof ShutdownSignal) {
      this.flushDeltas(runId);
      store.updateRun(runId, { usage: result.usage });
      return result;
    }
    this.log.info({ runId, status: result.status, usage: result.usage }, 'Ejecución terminada');
    store.finishRun(runId, { status: result.status as 'completed' | 'failed' | 'cancelled', output: result.output, error: result.error, usage: result.usage });
    this.emit(runId, 'run.finished', null, { status: result.status, output: result.output, error: result.error, usage: result.usage });
    this.publishRun(runId);
    return result;
  }

  // ---------- Subworkflows ----------
  /**
   * Lanza un subworkflow como una ejecución propia (aparece en el historial, enlazada con la que la lanza) y
   * espera a que termine. No pasa por la cola: forma parte de la ejecución que la contiene y se cancela con ella.
   */
  private async runSubworkflow(
    parent: Run,
    depth: number,
    opts: { nodeId: string; workflowId: string; input: string; signal: AbortSignal },
  ): Promise<ExecutionResult & { runId: string }> {
    const sub = parent.snapshot.subworkflows?.[opts.workflowId];
    if (!sub) throw new ConfigError('El subworkflow ya no existe (no estaba disponible al lanzar la ejecución).');
    if (depth >= MAX_SUBWORKFLOW_DEPTH) throw new ConfigError(`Se han anidado más de ${MAX_SUBWORKFLOW_DEPTH} niveles de workflows.`);
    const { store } = this.deps;
    const child = store.createRun({
      kind: 'workflow',
      workflowId: opts.workflowId,
      agentId: null,
      name: sub.name,
      input: opts.input,
      // La subejecución hereda la instantánea de la ejecución entera: mismos agentes y mismos subworkflows.
      snapshot: { workflow: sub.definition, agents: parent.snapshot.agents, subworkflows: parent.snapshot.subworkflows },
      parentRunId: parent.id,
      parentNodeId: opts.nodeId,
      steps: this.stepsFor(sub.definition),
    });
    this.emit(parent.id, 'subrun.started', opts.nodeId, { runId: child.id, name: sub.name });
    const controller = new AbortController();
    const onAbort = () => controller.abort(opts.signal.reason);
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
    this.active.set(child.id, { controller, partials: new Map(), done: Promise.resolve() });
    this.rootOf.set(child.id, this.rootOf.get(parent.id) ?? parent.id);
    this.publishRun(child.id);
    try {
      const result = (await this.execute(child.id, controller.signal, new Map(), depth + 1)) ?? {
        status: 'failed' as const,
        output: null,
        error: 'No se pudo iniciar el subworkflow.',
        usage: child.usage,
      };
      return { ...result, runId: child.id };
    } finally {
      opts.signal.removeEventListener('abort', onAbort);
      this.active.delete(child.id);
      this.rootOf.delete(child.id);
      this.deps.store.releaseRun(child.id);
      for (const resolve of this.waiters.get(child.id) ?? []) resolve();
      this.waiters.delete(child.id);
    }
  }

  // ---------- Aprobaciones humanas ----------
  /** Detiene el nodo hasta que una persona apruebe o rechace. Mientras tanto la ejecución queda «en espera». */
  private requestApproval(run: Run, opts: { nodeId: string; message: string; signal: AbortSignal }): Promise<{ approved: boolean; comment: string }> {
    const { store } = this.deps;
    const approval = store.createApproval(run.id, opts.nodeId, opts.message);
    const root = this.rootOf.get(run.id) ?? run.id;
    store.updateStep(run.id, opts.nodeId, { status: 'waiting' });
    store.updateRun(run.id, { status: 'waiting' });
    this.emit(run.id, 'approval.requested', opts.nodeId, { approvalId: approval.id, message: opts.message });
    this.publishRun(run.id);
    this.emitter.emit('approvals');
    this.waitingRuns.set(root, (this.waitingRuns.get(root) ?? 0) + 1);
    this.log.info({ runId: run.id, nodeId: opts.nodeId, approvalId: approval.id }, 'Ejecución a la espera de una aprobación');
    // El hueco que deja la ejecución en espera puede ocuparlo otra de la cola.
    setImmediate(() => this.pump());

    return new Promise<{ approved: boolean; comment: string }>((resolve, reject) => {
      const settle = () => {
        this.approvals.delete(approval.id);
        opts.signal.removeEventListener('abort', onAbort);
        const left = (this.waitingRuns.get(root) ?? 1) - 1;
        if (left > 0) this.waitingRuns.set(root, left);
        else this.waitingRuns.delete(root);
        // Vuelve a «en curso» salvo que la ejecución se esté apagando (queda como está, para reanudarse al arrancar).
        if (!(opts.signal.reason instanceof ShutdownSignal) && !store.listApprovals({ runId: run.id, pendingOnly: true }).length) {
          store.updateRun(run.id, { status: 'running' });
          this.publishRun(run.id);
        }
        this.emitter.emit('approvals');
      };
      const onAbort = () => {
        // Cancelación, tiempo máximo o apagado: la petición deja de estar pendiente.
        if (!(opts.signal.reason instanceof ShutdownSignal)) store.closeApproval(approval.id, 'cancelled');
        settle();
        reject(opts.signal.reason);
      };
      this.approvals.set(approval.id, {
        runId: run.id,
        nodeId: opts.nodeId,
        resolve: (decision) => {
          settle();
          store.updateStep(run.id, opts.nodeId, { status: 'running' });
          this.emit(run.id, 'approval.decided', opts.nodeId, { approvalId: approval.id, approved: decision.approved, comment: decision.comment });
          resolve(decision);
        },
      });
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Registra la decisión de una persona sobre una aprobación pendiente y reanuda el nodo que la esperaba. */
  decideApproval(id: string, approved: boolean, comment = ''): Approval {
    const { store } = this.deps;
    const approval = store.getApproval(id);
    if (!approval) throw new HttpError(404, 'Aprobación no encontrada.');
    const waiting = this.approvals.get(id);
    if (approval.status !== 'pending' || !waiting) {
      // Sin nodo esperando (p. ej. el servidor se reinició): la petición ya no sirve.
      if (approval.status === 'pending') store.closeApproval(id, 'cancelled');
      throw new HttpError(409, 'Esta aprobación ya no está pendiente.');
    }
    store.closeApproval(id, approved ? 'approved' : 'rejected', comment);
    waiting.resolve({ approved, comment });
    this.log.info({ approvalId: id, runId: approval.runId, approved }, 'Aprobación decidida');
    return store.getApproval(id)!;
  }

  /** Avisa cuando cambia el conjunto de aprobaciones pendientes (para la interfaz en vivo). */
  subscribeApprovals(listener: () => void): () => void {
    this.emitter.on('approvals', listener);
    return () => this.emitter.off('approvals', listener);
  }

  // ---------- Reanudación automática ----------
  /**
   * Al arrancar: reanuda sin preguntar las ejecuciones interrumpidas que solo esperaban una aprobación y, si el
   * ajuste «reanudar automáticamente» está activado, todas las demás. Devuelve las ejecuciones nuevas.
   */
  autoResume(): Run[] {
    const { store } = this.deps;
    const resumed: Run[] = [];
    for (const id of store.listAutoResumableRuns(store.getSettings().autoResume)) {
      const original = store.getRun(id);
      if (!original) continue;
      try {
        resumed.push(this.retryRun(original, 'failed'));
      } catch (err) {
        this.log.error({ err, runId: id }, 'No se pudo reanudar automáticamente una ejecución interrumpida');
      }
    }
    if (resumed.length) this.log.info({ resumed: resumed.length }, 'Ejecuciones interrumpidas reanudadas automáticamente');
    return resumed;
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
      this.deps.store.finishRun(runId, { status: 'cancelled', error: 'Ejecución cancelada antes de empezar.', finishedAt: now });
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

  /**
   * Apagado ordenado: detiene las ejecuciones y las deja INTERRUMPIDAS (reanudables), no canceladas. Espera
   * como mucho `graceMs` a que reaccionen; lo que siga vivo después queda igualmente marcado. Devuelve cuántas
   * ejecuciones se han interrumpido.
   */
  async shutdown(graceMs = 10_000): Promise<number> {
    if (this.closed) return 0;
    // A partir de aquí no se arranca nada más (un pump pendiente no debe tocar una base de datos ya cerrada).
    this.closed = true;
    // Las que esperaban en la cola no llegan a empezar: siguen «en cola» en la base y se marcan más abajo.
    const queued = this.queue.splice(0);
    const pending = [...this.active.values()].map((a) => a.done);
    for (const entry of this.active.values()) entry.controller.abort(new ShutdownSignal());
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      Promise.allSettled(pending).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), graceMs);
      }),
    ]);
    clearTimeout(timer);
    if (!settled) this.log.warn({ active: this.active.size, graceMs }, 'Hay ejecuciones que no han reaccionado al apagado dentro del plazo');
    const interrupted = this.deps.store.markInterruptedRuns('Ejecución interrumpida por el apagado del servidor.');
    for (const { runId } of queued) {
      for (const resolve of this.waiters.get(runId) ?? []) resolve();
      this.waiters.delete(runId);
    }
    if (interrupted) this.log.info({ interrupted }, 'Ejecuciones interrumpidas por el apagado; se podrán reanudar al arrancar');
    return interrupted;
  }
}
