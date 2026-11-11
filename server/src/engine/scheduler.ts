// Disparadores: lo que lanza un workflow sin que nadie pulse «Ejecutar». Un workflow puede tener varios:
// cada N minutos, a una hora ciertos días, con una expresión cron o al recibir una petición HTTP (webhook).
// Un temporizador comprueba periódicamente cuáles han vencido y las lanza por el mismo camino que una ejecución
// manual; los webhooks llegan por la API (routes/api.ts) y usan `fire`.
import type { Run, Trigger, TriggerInput, ValidationIssue, Workflow } from '../../../shared/types';
import type { Store } from '../db/store';
import { errorMessage, silentLogger, type Logger } from '../util';
import { dailyCron, nextCronTime, parseCron, systemTimeZone } from './cron';
import type { RunManager } from './run-manager';

type Timing = Pick<TriggerInput, 'kind' | 'intervalMinutes' | 'time' | 'weekdays' | 'cron' | 'timezone'>;

/** Una ocasión con hora fija que llega con más retraso que este (el servidor estaba apagado) se omite. */
export const LATE_GRACE_MS = 60 * 60_000;

/**
 * Próximo instante en que debe dispararse, estrictamente posterior a `from`. Null si no tiene horario (webhook)
 * o si la expresión no se cumple nunca.
 *
 * En un intervalo, `scheduledAt` es la ocasión que acaba de vencer: la siguiente se cuenta desde ella y no
 * desde el momento en que se comprobó, para que el horario no se vaya retrasando unos segundos cada vez.
 */
export function nextOccurrence(input: Timing, from: Date, scheduledAt?: Date | null): Date | null {
  const now = from.getTime();
  if (input.kind === 'webhook') return null;
  if (input.kind === 'interval') {
    const step = Math.max(1, Number(input.intervalMinutes) || 1) * 60_000;
    const base = scheduledAt?.getTime() ?? now;
    if (base > now || !Number.isFinite(base)) return new Date(now + step);
    // Si se han perdido varias ocasiones (servidor apagado) no se recuperan una a una: se salta a la siguiente futura.
    return new Date(base + (Math.floor((now - base) / step) + 1) * step);
  }
  const expression = input.kind === 'daily' ? dailyCron(String(input.time ?? '00:00'), input.weekdays ?? []) : String(input.cron ?? '');
  const next = nextCronTime(parseCron(expression), now, input.timezone || systemTimeZone());
  return next === null ? null : new Date(next);
}

/** Las próximas `count` ocasiones a partir de `from`. */
export function upcomingOccurrences(input: Timing, from: Date, count: number): Date[] {
  const out: Date[] = [];
  let cursor: Date | null = from;
  let scheduled: Date | null = null;
  while (out.length < count) {
    cursor = nextOccurrence(input, cursor, scheduled);
    if (!cursor) break;
    out.push(cursor);
    scheduled = cursor;
  }
  return out;
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

  /** Empieza a comprobar los disparadores cada `tickMs`. No impide que el proceso termine. */
  start(tickMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        // Un fallo puntual (p. ej. la base de datos ocupada) se reintenta en la siguiente pasada.
        this.log.warn({ err }, 'No se pudieron comprobar los disparadores');
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

  /** Lanza los disparadores con horario vencidos a fecha `now`. Devuelve los ids de las ejecuciones iniciadas. */
  tick(now = Date.now()): string[] {
    const started: string[] = [];
    for (const trigger of this.deps.store.listTriggers()) {
      if (trigger.kind === 'webhook' || !trigger.enabled || !trigger.nextRunAt) continue;
      const due = Date.parse(trigger.nextRunAt);
      if (due > now) continue;
      let next: string | null = null;
      try {
        next = nextOccurrence(trigger, new Date(now), new Date(due))?.toISOString() ?? null;
      } catch (err) {
        // Una expresión guardada que ya no se entiende no debe parar a los demás disparadores.
        this.deps.store.updateTriggerState(trigger.id, { nextRunAt: null, lastError: `El horario no es válido: ${errorMessage(err)}` });
        continue;
      }
      // Una hora fija que llega muy tarde (el servidor estaba apagado) no se ejecuta a deshora.
      if (trigger.kind !== 'interval' && now - due > LATE_GRACE_MS) {
        this.deps.store.updateTriggerState(trigger.id, { nextRunAt: next, lastError: 'Se omitió una ejecución porque AgentForge no estaba en marcha a su hora.' });
        continue;
      }
      // Sin solapes: si la ejecución anterior de este disparador sigue viva, esta ocasión se omite.
      if (trigger.lastRunId && this.deps.runs.isActive(trigger.lastRunId)) {
        this.deps.store.updateTriggerState(trigger.id, { nextRunAt: next, lastError: 'Se omitió una ejecución porque la anterior seguía en curso.' });
        continue;
      }
      // Cada disparador por separado: si uno falla de forma inesperada, los demás se siguen evaluando.
      let result: { run: Run } | { error: string };
      try {
        result = this.launch(trigger, trigger.input);
      } catch (err) {
        this.log.error({ err, triggerId: trigger.id }, 'Fallo inesperado al lanzar un disparador');
        result = { error: `No se pudo lanzar: ${errorMessage(err)}` };
      }
      if ('run' in result) {
        started.push(result.run.id);
        this.log.info({ triggerId: trigger.id, workflowId: trigger.workflowId, runId: result.run.id }, 'Disparador lanzado');
        this.deps.store.updateTriggerState(trigger.id, { nextRunAt: next, lastRunAt: new Date(now).toISOString(), lastRunId: result.run.id, lastError: null });
      } else {
        this.deps.store.updateTriggerState(trigger.id, { nextRunAt: next, lastError: result.error });
      }
    }
    return started;
  }

  /**
   * Lanza ahora un disparador (sin alterar su siguiente ocasión): «Ejecutar ahora» y la llegada de un webhook.
   * `input` sustituye a la entrada guardada. Lanza un Error con el motivo si no se puede.
   */
  fire(trigger: Trigger, input = trigger.input): Run {
    const result = this.launch(trigger, input);
    if (!('run' in result)) {
      this.deps.store.updateTriggerState(trigger.id, { lastError: result.error });
      throw new Error(result.error);
    }
    this.deps.store.updateTriggerState(trigger.id, { lastRunAt: new Date().toISOString(), lastRunId: result.run.id, lastError: null });
    return result.run;
  }

  private launch(trigger: Trigger, input: string): { run: Run } | { error: string } {
    const workflow = this.deps.store.getWorkflow(trigger.workflowId);
    if (!workflow) return { error: 'El workflow ya no existe.' };
    const problem = this.deps.validate(workflow).find((i) => i.level === 'error');
    if (problem) return { error: `No se pudo lanzar: ${problem.message}` };
    return { run: this.deps.runs.startWorkflowRun(workflow, input, { scheduled: trigger.kind !== 'webhook', triggerKind: trigger.kind }) };
  }
}
