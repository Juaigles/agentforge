// Estado en vivo de una ejecución, reconstruido a partir de sus eventos (reductor puro).
import { t } from '@/i18n';
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
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  steps: Record<string, StepLive>;
  /** Orden de los pasos tal como se definieron. */
  order: string[];
  /** Eventos persistidos, en orden. */
  events: RunEvent[];
  lastSeq: number;
  /** Uso final comunicado por el servidor (null mientras la ejecución sigue en curso). */
  finalUsage: Usage | null;
}

/** Estado tal cual lo devuelve la API (para ejecuciones ya terminadas). */
export function fromRun(run: Run, events: RunEvent[] = []): RunLive {
  return {
    status: run.status,
    output: run.output,
    error: run.error,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    steps: Object.fromEntries(run.steps.map((s) => [s.nodeId, { ...s, streamText: '', thinkingText: '' }])),
    order: run.steps.map((s) => s.nodeId),
    events,
    lastSeq: events.at(-1)?.seq ?? 0,
    finalUsage: run.usage,
  };
}

/** Estado inicial "en blanco" para reproducir todos los eventos de una ejecución en curso. */
export function blankFromRun(run: Run): RunLive {
  return {
    status: 'queued',
    output: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    steps: Object.fromEntries(
      run.steps.map((s) => [
        s.nodeId,
        {
          ...s,
          status: 'pending' as const,
          attempt: 0,
          output: null,
          error: null,
          usage: { ...ZERO_USAGE },
          startedAt: null,
          finishedAt: null,
          streamText: '',
          thinkingText: '',
        },
      ]),
    ),
    order: run.steps.map((s) => s.nodeId),
    events: [],
    lastSeq: 0,
    finalUsage: null,
  };
}

/** Aplica un evento al estado (lo muta). Los eventos persistidos repetidos se ignoran. */
export function applyEvent(state: RunLive, ev: RunEvent): void {
  if (ev.seq !== null) {
    if (ev.seq <= state.lastSeq) return;
    state.lastSeq = ev.seq;
    state.events.push(ev);
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
      state.finishedAt = ev.ts;
      if (d.usage) state.finalUsage = d.usage;
      break;
    case 'step.started':
      if (!step) break;
      step.status = 'running';
      step.attempt = d.attempt ?? 1;
      step.startedAt ??= ev.ts;
      step.error = null;
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
  | { kind: 'marker'; key: string; ts: string; nodeId: string | null; tone: 'info' | 'success' | 'danger' | 'warning' | 'neutral'; text: string; detail?: string; link?: { to: string; label: string } }
  | { kind: 'message'; key: string; ts: string; nodeId: string | null; agent: string; depth: number; content: string; thinking?: string; tokens: number; toolCount: number }
  | { kind: 'tool'; key: string; ts: string; nodeId: string | null; agent?: string; depth: number; name: string; args: unknown; pending: boolean; ok: boolean; result: string; durationMs: number | null };

/** Clave del texto con que se cierra un paso, según cómo terminó. */
const STEP_END_KEY: Record<string, string> = {
  completed: 'runState.stepCompleted',
  failed: 'runState.stepFailed',
  cancelled: 'runState.stepCancelled',
};

/** Convierte los eventos en elementos legibles, emparejando cada llamada a herramienta con su resultado. */
export function buildActivity(events: RunEvent[], nodeId?: string | null): ActivityItem[] {
  const items: ActivityItem[] = [];
  const openTools = new Map<string, Extract<ActivityItem, { kind: 'tool' }>>();
  for (const ev of events) {
    if (nodeId && ev.nodeId !== nodeId) continue;
    const d = ev.data;
    const base = { key: `e${ev.seq}`, ts: ev.ts, nodeId: ev.nodeId };
    switch (ev.type) {
      case 'run.started':
        items.push({ ...base, kind: 'marker', tone: 'info', text: t('runState.runStarted') });
        break;
      case 'run.finished':
        items.push({
          ...base,
          kind: 'marker',
          tone: d.status === 'completed' ? 'success' : d.status === 'failed' ? 'danger' : 'warning',
          text: t(d.status === 'completed' ? 'runState.runCompleted' : d.status === 'failed' ? 'runState.runFailed' : 'runState.runCancelled'),
          detail: d.error ?? undefined,
        });
        break;
      case 'step.started':
        if (d.attempt > 1) items.push({ ...base, kind: 'marker', tone: 'info', text: t('runState.attempt', { attempt: d.attempt, max: d.maxAttempts }) });
        else items.push({ ...base, kind: 'marker', tone: 'info', text: t('runState.stepStarted') });
        break;
      case 'step.finished':
        items.push({
          ...base,
          kind: 'marker',
          tone: d.status === 'completed' ? 'success' : d.status === 'failed' ? 'danger' : 'warning',
          text: STEP_END_KEY[d.status] ? t(STEP_END_KEY[d.status]) : d.status,
          detail: d.error ?? undefined,
        });
        break;
      case 'step.retry':
        items.push({ ...base, kind: 'marker', tone: 'warning', text: t('runState.stepRetry', { attempt: d.attempt, delay: d.delayMs }), detail: d.error });
        break;
      case 'step.skipped':
        items.push({ ...base, kind: 'marker', tone: 'neutral', text: t('runState.stepSkipped'), detail: d.reason });
        break;
      case 'step.reused':
        items.push({ ...base, kind: 'marker', tone: 'neutral', text: t('runState.stepReused') });
        break;
      case 'subrun.started':
        items.push({ ...base, kind: 'marker', tone: 'info', text: t('runState.subrunStarted', { name: d.name }), link: { to: `/runs/${d.runId}`, label: t('runState.subrunLink') } });
        break;
      case 'approval.requested':
        items.push({ ...base, kind: 'marker', tone: 'warning', text: t('runState.approvalRequested'), detail: d.message });
        break;
      case 'approval.decided':
        items.push({ ...base, kind: 'marker', tone: d.approved ? 'success' : 'danger', text: d.approved ? t('runState.approved') : t('runState.rejected'), detail: d.comment || undefined });
        break;
      case 'foreach.item': {
        const which = { n: d.index + 1, total: d.total };
        if (d.status === 'started' && (d.attempt ?? 1) === 1) items.push({ ...base, kind: 'marker', tone: 'info', text: t('runState.foreach.started', which), detail: d.item });
        else if (d.status === 'completed') items.push({ ...base, kind: 'marker', tone: 'success', text: t('runState.foreach.completed', which) });
        else if (d.status === 'reused') items.push({ ...base, kind: 'marker', tone: 'neutral', text: t('runState.foreach.reused', which), detail: d.item });
        else if (d.status === 'retry') items.push({ ...base, kind: 'marker', tone: 'warning', text: t('runState.foreach.retry', { ...which, attempt: d.attempt, delay: d.delayMs }), detail: d.error });
        else if (d.status === 'failed') items.push({ ...base, kind: 'marker', tone: 'danger', text: t('runState.foreach.failed', which), detail: d.error });
        break;
      }
      case 'llm.message':
        items.push({
          ...base,
          kind: 'message',
          agent: d.agent ?? '',
          depth: d.depth ?? 0,
          content: d.content ?? '',
          thinking: d.thinking,
          tokens: (d.usage?.promptTokens ?? 0) + (d.usage?.completionTokens ?? 0),
          toolCount: d.toolCalls?.length ?? 0,
        });
        break;
      case 'tool.call': {
        const item: Extract<ActivityItem, { kind: 'tool' }> = {
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
        openTools.set(`${ev.nodeId}|${d.id}|${d.depth ?? 0}`, item);
        items.push(item);
        break;
      }
      case 'tool.result': {
        const key = `${ev.nodeId}|${d.id}|${d.depth ?? 0}`;
        const item = openTools.get(key);
        if (!item) break;
        item.pending = false;
        item.ok = d.ok;
        item.result = d.result ?? '';
        item.durationMs = d.durationMs ?? null;
        openTools.delete(key);
        break;
      }
    }
  }
  return items;
}
