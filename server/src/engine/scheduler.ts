// Ejecución programada sencilla: cada workflow puede tener una programación (cada N minutos o a una hora
// fija cada día). Un temporizador comprueba periódicamente cuáles han vencido y las lanza por el mismo camino
// que una ejecución manual.
import type { Run, Schedule, ScheduleInput, ValidationIssue, Workflow } from '../../../shared/types';
import type { Store } from '../db/store';
import { errorMessage, silentLogger, type Logger } from '../util';
import type { RunManager } from './run-manager';

/** Próximo instante en que debe dispararse una programación, contado a partir de `from`. */
export function nextOccurrence(input: Pick<ScheduleInput, 'kind' | 'intervalMinutes' | 'time'>, from: Date): Date {
  if (input.kind === 'interval') {
    return new Date(from.getTime() + Math.max(1, Number(input.intervalMinutes) || 1) * 60_000);
  }
  // Diaria: la próxima vez que el reloj local marque HH:MM (hoy si aún no ha pasado; si no, mañana).
  const [hours, minutes] = String(input.time ?? '00:00').split(':').map(Number);
  const next = new Date(from);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

export interface SchedulerDeps {
  store: Store;
  runs: RunManager;
  /** Problemas de validación del workflow (los errores impiden lanzarlo). */
  validate: (workflow: Workflow) => ValidationIssue[];
  log?: () => Logger;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SchedulerDeps) {}

  private get log(): Logger {
    return this.deps.log?.() ?? silentLogger;
  }

  /** Empieza a comprobar las programaciones cada `tickMs`. No impide que el proceso termine. */
  start(tickMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        // Un fallo puntual (p. ej. la base de datos ocupada) se reintenta en la siguiente pasada.
        this.log.warn({ err }, 'No se pudieron comprobar las programaciones');
      }
    }, tickMs);
    this.timer.unref();
  }

  /** ¿Está en marcha el temporizador? */
  get running(): boolean {
    return this.timer !== null;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Lanza las programaciones vencidas a fecha `now`. Devuelve los ids de las ejecuciones iniciadas. */
  tick(now = Date.now()): string[] {
    const started: string[] = [];
    for (const schedule of this.deps.store.listSchedules()) {
      if (!schedule.enabled || !schedule.nextRunAt || Date.parse(schedule.nextRunAt) > now) continue;
      const next = nextOccurrence(schedule, new Date(now)).toISOString();
      // Sin solapes: si la ejecución anterior de esta programación sigue viva, esta ocasión se omite.
      if (schedule.lastRunId && this.deps.runs.isActive(schedule.lastRunId)) {
        this.deps.store.updateScheduleState(schedule.workflowId, { nextRunAt: next, lastError: 'Se omitió una ejecución porque la anterior seguía en curso.' });
        continue;
      }
      // Cada programación por separado: si una falla de forma inesperada, las demás se siguen evaluando.
      let result: { run: Run } | { error: string };
      try {
        result = this.launch(schedule);
      } catch (err) {
        this.log.error({ err, workflowId: schedule.workflowId }, 'Fallo inesperado al lanzar una programación');
        result = { error: `No se pudo lanzar: ${errorMessage(err)}` };
      }
      if ('run' in result) {
        started.push(result.run.id);
        this.log.info({ workflowId: schedule.workflowId, runId: result.run.id }, 'Programación lanzada');
        this.deps.store.updateScheduleState(schedule.workflowId, { nextRunAt: next, lastRunAt: new Date(now).toISOString(), lastRunId: result.run.id, lastError: null });
      } else {
        this.deps.store.updateScheduleState(schedule.workflowId, { nextRunAt: next, lastError: result.error });
      }
    }
    return started;
  }

  /** Lanza ahora la programación de un workflow (sin alterar su siguiente cita). */
  runNow(schedule: Schedule): Run {
    const result = this.launch(schedule);
    if (!('run' in result)) throw new Error(result.error);
    this.deps.store.updateScheduleState(schedule.workflowId, { lastRunAt: new Date().toISOString(), lastRunId: result.run.id, lastError: null });
    return result.run;
  }

  private launch(schedule: Schedule): { run: Run } | { error: string } {
    const workflow = this.deps.store.getWorkflow(schedule.workflowId);
    if (!workflow) return { error: 'El workflow ya no existe.' };
    const problem = this.deps.validate(workflow).find((i) => i.level === 'error');
    if (problem) return { error: `No se pudo lanzar: ${problem.message}` };
    return { run: this.deps.runs.startWorkflowRun(workflow, schedule.input, { scheduled: true }) };
  }
}
