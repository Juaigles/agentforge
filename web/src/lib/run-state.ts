// Estado en vivo de una ejecución: parte del que entrega el servidor y se mantiene al día evento a evento.
import { t } from '@/i18n';
import type { ServerMessage } from '@shared/server-messages';
import { serverText } from './server-messages-en';
import { ZERO_USAGE, type Run, type RunEvent, type RunStatus, type RunStep, type Usage } from '@shared/types';

export interface StepLive extends RunStep {
  /** Texto que el modelo está generando ahora mismo (streaming). */
  streamText: string;
  /** Razonamiento que el modelo está emitiendo ahora mismo. */
  thinkingText: string;
}

export interface RunLive {
  status: RunStatus;
  output: string | null;
  /** Motivo del fallo tal como lo escribió el servidor, y su código para mostrarlo en otro idioma (`serverText`). */
  error: string | null;
  errorI18n: ServerMessage | null;
  startedAt: string | null;
  finishedAt: string | null;
  steps: Record<string, StepLive>;
  /** Orden de los pasos tal como se definieron. */
  order: string[];
  /** Registro de actividad: se amplía con cada evento, sin volver a recorrer los anteriores. */
  activity: ActivityLog;
  /** Último evento guardado ya aplicado al estado. */
  lastSeq: number;
  /** Uso final comunicado por el servidor (null mientras la ejecución sigue en curso). */
  finalUsage: Usage | null;
}

const isActive = (status: RunStatus): boolean => status === 'queued' || status === 'running' || status === 'waiting';

/**
 * Estado tal cual lo devuelve la API: el servidor entrega los pasos ya calculados hasta el evento `run.lastSeq`,
 * también en una ejecución en curso, así que no hace falta reproducir su historial. Los eventos posteriores se
 * aplican con `applyEvent`; `activity` es el registro ya cargado (vacío si no se pasa).
 */
export function fromRun(run: Run, activity: ActivityLog = emptyActivity()): RunLive {
  return {
    status: run.status,
    output: run.output,
    error: run.error,
    errorI18n: run.errorI18n ?? null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    steps: Object.fromEntries(run.steps.map((s) => [s.nodeId, { ...s, streamText: '', thinkingText: '' }])),
    order: run.steps.map((s) => s.nodeId),
    activity,
    lastSeq: run.lastSeq,
    // Mientras sigue en curso el total es la suma en vivo de los pasos; el definitivo llega al terminar.
    finalUsage: isActive(run.status) ? null : run.usage,
  };
}

/** Aplica un evento al estado (lo muta). Los eventos persistidos repetidos se ignoran. */
export function applyEvent(state: RunLive, ev: RunEvent): void {
  if (ev.seq !== null) {
    if (ev.seq <= state.lastSeq) return;
    state.lastSeq = ev.seq;
    appendActivity(state.activity, ev);
  }
  const d = ev.data;
  const step = ev.nodeId ? state.steps[ev.nodeId] : undefined;
  const topLevel = !d.depth;

  switch (ev.type) {
    case 'run.started':
      state.status = 'running';
      state.startedAt = ev.ts;
      break;
    case 'run.finished':
      state.status = d.status;
      // El evento en directo trae la salida; el guardado en el historial no (está en la propia ejecución).
      if ('output' in d) state.output = d.output ?? null;
      state.error = d.error ?? null;
      state.errorI18n = d.errorI18n ?? null;
      state.finishedAt = ev.ts;
      if (d.usage) state.finalUsage = d.usage;
      break;
    case 'step.started':
      if (!step) break;
      step.status = 'running';
      step.attempt = d.attempt ?? 1;
      step.startedAt ??= ev.ts;
      step.error = null;
      step.errorI18n = null;
      step.streamText = '';
      step.thinkingText = '';
      break;
    case 'approval.requested':
      // El nodo se detiene a la espera de una persona; la ejecución entera queda «en espera».
      if (step) step.status = 'waiting';
      state.status = 'waiting';
      break;
    case 'approval.decided':
      if (step) step.status = 'running';
      if (!Object.values(state.steps).some((s) => s.status === 'waiting')) state.status = 'running';
      break;
    case 'step.finished':
      if (!step) break;
      step.status = d.status;
      if (d.output !== undefined) step.output = d.output;
      if (d.partialOutput !== undefined) step.partialOutput = d.partialOutput;
      step.error = d.error ?? null;
      step.errorI18n = d.errorI18n ?? null;
      if (d.usage) step.usage = d.usage;
      step.finishedAt = ev.ts;
      // Un paso cancelado o fallido a medias no tiene salida: se conserva lo que ya se había generado en directo.
      if (d.status === 'completed' || step.output !== null) {
        step.streamText = '';
        step.thinkingText = '';
      }
      break;
    case 'step.skipped':
      if (!step) break;
      step.status = 'skipped';
      step.finishedAt = ev.ts;
      break;
    case 'step.reused':
      if (!step) break;
      step.status = 'completed';
      if ('output' in d) step.output = d.output ?? null;
      break;
    case 'llm.start':
      if (step && topLevel) {
        step.streamText = '';
        step.thinkingText = '';
      }
      break;
    case 'llm.delta':
      if (step && topLevel) step.streamText += d.text;
      break;
    case 'llm.thinking':
      if (step && topLevel) step.thinkingText += d.text;
      break;
    case 'llm.snapshot':
      if (step) step.streamText = d.text;
      break;
    case 'llm.message':
      if (!step) break;
      if (topLevel) {
        step.streamText = d.content ?? '';
        step.thinkingText = '';
      }
      step.usage = {
        ...step.usage,
        llmCalls: step.usage.llmCalls + 1,
        promptTokens: step.usage.promptTokens + (d.usage?.promptTokens ?? 0),
        completionTokens: step.usage.completionTokens + (d.usage?.completionTokens ?? 0),
      };
      break;
    case 'tool.call':
      if (step) step.usage = { ...step.usage, toolCalls: step.usage.toolCalls + 1 };
      break;
  }
}

/** Uso total: el definitivo del servidor si ya existe; si no, la suma en vivo de los pasos. */
export function totalUsage(state: RunLive): Usage {
  if (state.finalUsage) return state.finalUsage;
  const total = { ...ZERO_USAGE };
  for (const s of Object.values(state.steps)) {
    total.promptTokens += s.usage.promptTokens;
    total.completionTokens += s.usage.completionTokens;
    total.llmCalls += s.usage.llmCalls;
    total.toolCalls += s.usage.toolCalls;
  }
  return total;
}

// ---------- Registro de actividad ----------
export type ActivityItem =
  | {
      kind: 'marker';
      key: string;
      ts: string;
      nodeId: string | null;
      tone: 'info' | 'success' | 'danger' | 'warning' | 'neutral';
      text: string;
      detail?: string;
      link?: { to: string; label: string };
    }
  | {
      kind: 'message';
      key: string;
      ts: string;
      nodeId: string | null;
      agent: string;
      depth: number;
      content: string;
      thinking?: string;
      tokens: number;
      toolCount: number;
    }
  | {
      kind: 'tool';
      key: string;
      ts: string;
      nodeId: string | null;
      agent?: string;
      depth: number;
      name: string;
      args: unknown;
      pending: boolean;
      ok: boolean;
      result: string;
      durationMs: number | null;
    };

/** Clave del texto con que se cierra un paso, según cómo terminó. */
const STEP_END_KEY: Record<string, string> = {
  completed: 'runState.stepCompleted',
  failed: 'runState.stepFailed',
  cancelled: 'runState.stepCancelled',
};

type ToolItem = Extract<ActivityItem, { kind: 'tool' }>;

/**
 * Registro de actividad de una ejecución. Se construye de forma incremental: cada evento nuevo añade su entrada (o
 * completa la de la llamada a herramienta que responde) y una página de eventos más antiguos se antepone, sin
 * recorrer en ningún caso lo que ya estaba.
 */
export interface ActivityLog {
  /** Entradas, de la más antigua a la más reciente. */
  items: ActivityItem[];
  /** `seq` del evento más antiguo incorporado (0 si no hay ninguno). Si es mayor que 1, quedan eventos anteriores sin cargar. */
  firstSeq: number;
  /** Entradas cargadas de cada nodo. */
  counts: Record<string, number>;
  /** Llamadas a herramientas que aún no tienen resultado, por nodo, identificador y profundidad. */
  openTools: Record<string, ToolItem>;
  /** Resultados cuya llamada está en una página anterior todavía sin cargar. */
  orphanResults: Record<string, RunEvent>;
}

export const emptyActivity = (): ActivityLog => ({ items: [], firstSeq: 0, counts: {}, openTools: {}, orphanResults: {} });

const toolKey = (ev: RunEvent): string => `${ev.nodeId}|${ev.data.id}|${ev.data.depth ?? 0}`;

function closeTool(item: ToolItem, result: RunEvent): void {
  const d = result.data;
  item.pending = false;
  item.ok = d.ok;
  // El error de una herramienta se guarda como el texto que recibió el modelo («Error: …»); si trae código, se traduce.
  item.result = d.errorI18n ? `Error: ${serverText(String(d.result ?? '').replace(/^Error: /, ''), d.errorI18n)}` : (d.result ?? '');
  item.durationMs = d.durationMs ?? null;
}

/** Entrada legible de un evento, o null si el evento no tiene entrada propia. */
function activityItem(ev: RunEvent): ActivityItem | null {
  const d = ev.data;
  const base = { key: `e${ev.seq}`, ts: ev.ts, nodeId: ev.nodeId };
  switch (ev.type) {
    case 'run.started':
      return { ...base, kind: 'marker', tone: 'info', text: t('runState.runStarted') };
    case 'run.finished':
      return {
        ...base,
        kind: 'marker',
        tone: d.status === 'completed' ? 'success' : d.status === 'failed' ? 'danger' : 'warning',
        text: t(d.status === 'completed' ? 'runState.runCompleted' : d.status === 'failed' ? 'runState.runFailed' : 'runState.runCancelled'),
        detail: d.error ? serverText(d.error, d.errorI18n) : undefined,
      };
    case 'step.started':
      if (d.attempt > 1) return { ...base, kind: 'marker', tone: 'info', text: t('runState.attempt', { attempt: d.attempt, max: d.maxAttempts }) };
      return { ...base, kind: 'marker', tone: 'info', text: t('runState.stepStarted') };
    case 'step.finished':
      return {
        ...base,
        kind: 'marker',
        tone: d.status === 'completed' ? 'success' : d.status === 'failed' ? 'danger' : 'warning',
        text: STEP_END_KEY[d.status] ? t(STEP_END_KEY[d.status]) : d.status,
        detail: d.error ? serverText(d.error, d.errorI18n) : undefined,
      };
    case 'step.retry':
      return {
        ...base,
        kind: 'marker',
        tone: 'warning',
        text: t('runState.stepRetry', { attempt: d.attempt, delay: d.delayMs }),
        detail: serverText(d.error, d.errorI18n),
      };
    case 'step.skipped':
      return { ...base, kind: 'marker', tone: 'neutral', text: t('runState.stepSkipped'), detail: serverText(d.reason, d.reasonI18n) };
    case 'step.reused':
      return { ...base, kind: 'marker', tone: 'neutral', text: t('runState.stepReused') };
    case 'subrun.started':
      return {
        ...base,
        kind: 'marker',
        tone: 'info',
        text: t('runState.subrunStarted', { name: d.name }),
        link: { to: `/runs/${d.runId}`, label: t('runState.subrunLink') },
      };
    case 'approval.requested':
      return { ...base, kind: 'marker', tone: 'warning', text: t('runState.approvalRequested'), detail: d.message };
    case 'approval.decided':
      return {
        ...base,
        kind: 'marker',
        tone: d.approved ? 'success' : 'danger',
        text: d.approved ? t('runState.approved') : t('runState.rejected'),
        detail: d.comment || undefined,
      };
    case 'foreach.item': {
      const which = { n: d.index + 1, total: d.total };
      if (d.status === 'started' && (d.attempt ?? 1) === 1)
        return { ...base, kind: 'marker', tone: 'info', text: t('runState.foreach.started', which), detail: d.item };
      if (d.status === 'completed') return { ...base, kind: 'marker', tone: 'success', text: t('runState.foreach.completed', which) };
      if (d.status === 'reused') return { ...base, kind: 'marker', tone: 'neutral', text: t('runState.foreach.reused', which), detail: d.item };
      if (d.status === 'retry')
        return {
          ...base,
          kind: 'marker',
          tone: 'warning',
          text: t('runState.foreach.retry', { ...which, attempt: d.attempt, delay: d.delayMs }),
          detail: serverText(d.error, d.errorI18n),
        };
      if (d.status === 'failed')
        return { ...base, kind: 'marker', tone: 'danger', text: t('runState.foreach.failed', which), detail: serverText(d.error, d.errorI18n) };
      return null;
    }
    case 'llm.message':
      return {
        ...base,
        kind: 'message',
        agent: d.agent ?? '',
        depth: d.depth ?? 0,
        content: d.content ?? '',
        thinking: d.thinking,
        tokens: (d.usage?.promptTokens ?? 0) + (d.usage?.completionTokens ?? 0),
        toolCount: d.toolCalls?.length ?? 0,
      };
    case 'tool.call':
      return {
        ...base,
        kind: 'tool',
        agent: d.agent,
        depth: d.depth ?? 0,
        name: d.name,
        args: d.arguments,
        pending: true,
        ok: true,
        result: '',
        durationMs: null,
      };
    default:
      return null;
  }
}

/** Incorpora al registro un evento posterior a todos los que ya tiene. */
export function appendActivity(log: ActivityLog, ev: RunEvent): void {
  if (ev.seq === null) return;
  if (!log.firstSeq) log.firstSeq = ev.seq;
  if (ev.type === 'tool.result') {
    const key = toolKey(ev);
    const open = log.openTools[key];
    if (open) {
      closeTool(open, ev);
      delete log.openTools[key];
    } else if (log.firstSeq > 1) log.orphanResults[key] = ev;
    return;
  }
  const item = activityItem(ev);
  if (!item) return;
  log.items.push(item);
  if (item.nodeId) log.counts[item.nodeId] = (log.counts[item.nodeId] ?? 0) + 1;
  // Se guarda la entrada tal como queda en la lista (reactiva, si el registro lo es): al llegar el resultado se actualiza ahí.
  if (item.kind === 'tool') log.openTools[toolKey(ev)] = log.items[log.items.length - 1] as ToolItem;
}

/**
 * Antepone una página de eventos más antiguos que todos los del registro (en orden de secuencia). Las llamadas a
 * herramientas de la página se emparejan con sus resultados, estén en la misma página o ya cargados.
 */
export function prependActivity(log: ActivityLog, events: RunEvent[]): void {
  const older = events.filter((ev) => ev.seq !== null && (!log.firstSeq || ev.seq < log.firstSeq));
  if (!older.length) return;
  const items: ActivityItem[] = [];
  const open: Record<string, ToolItem> = {};
  for (const ev of older) {
    if (ev.type === 'tool.result') {
      const key = toolKey(ev);
      if (open[key]) {
        closeTool(open[key], ev);
        delete open[key];
      } else log.orphanResults[key] = ev;
      continue;
    }
    const item = activityItem(ev);
    if (!item) continue;
    items.push(item);
    if (item.nodeId) log.counts[item.nodeId] = (log.counts[item.nodeId] ?? 0) + 1;
    if (item.kind === 'tool') open[toolKey(ev)] = item;
  }
  for (const [key, item] of Object.entries(open)) {
    const result = log.orphanResults[key];
    if (result) {
      closeTool(item, result);
      delete log.orphanResults[key];
    } else log.openTools[key] ??= item;
  }
  log.firstSeq = older[0].seq!;
  // Ya no puede haber llamadas más antiguas: los resultados que sigan sueltos no tienen pareja.
  if (log.firstSeq <= 1) log.orphanResults = {};
  log.items.unshift(...items);
}

/** Registro de actividad completo de una lista de eventos (en orden), opcionalmente solo el de un nodo. */
export function buildActivity(events: RunEvent[], nodeId?: string | null): ActivityItem[] {
  const log = emptyActivity();
  // Se parte del principio: un resultado sin llamada anterior no tiene con quién emparejarse.
  log.firstSeq = 1;
  for (const ev of events) appendActivity(log, ev);
  return nodeId ? log.items.filter((item) => item.nodeId === nodeId) : log.items;
}
