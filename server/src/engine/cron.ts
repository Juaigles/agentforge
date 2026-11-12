// Expresiones cron de cinco campos (minuto hora día-del-mes mes día-de-la-semana) y cálculo de la siguiente
// ocasión en una zona horaria. No depende de ninguna librería: las zonas las resuelve Intl (la base de datos de
// zonas que trae Node).
//
// La siguiente ocasión se busca enumerando HORAS DE PARED (fecha y HH:MM en la zona) y convirtiendo cada una a un
// instante. Así una tarea «todos los días a las 02:30» se ejecuta exactamente una vez también los días de cambio
// de hora: si esa hora no existe (salto de primavera) se ejecuta al terminar el salto, y si se repite (otoño), solo
// en la primera de las dos.
import { msg, refOf, type CodedMessage, type ServerMessage } from '../../../shared/server-messages';

export interface CronSpec {
  minutes: number[];
  hours: number[];
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** ¿El campo estaba restringido (no era «*»)? Si lo están los dos, basta con que coincida uno (como en cron). */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const FIELDS = [
  { key: 'minute', name: 'minuto', min: 0, max: 59, names: [] as string[], base: 0 },
  { key: 'hour', name: 'hora', min: 0, max: 23, names: [] as string[], base: 0 },
  { key: 'dayOfMonth', name: 'día del mes', min: 1, max: 31, names: [] as string[], base: 0 },
  { key: 'month', name: 'mes', min: 1, max: 12, names: MONTH_NAMES, base: 1 },
  { key: 'dayOfWeek', name: 'día de la semana', min: 0, max: 7, names: DAY_NAMES, base: 0 },
];
const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

/** Expresión cron que no se entiende. `text` lleva el código y los parámetros del motivo, para mostrarlo en otro idioma. */
export class CronError extends Error {
  readonly i18n: ServerMessage;
  constructor(readonly text: CodedMessage) {
    super(text.message);
    this.name = 'CronError';
    this.i18n = refOf(text);
  }
}

function parseField(text: string, field: (typeof FIELDS)[number]): number[] {
  const values = new Set<number>();
  const number = (raw: string): number => {
    const named = field.names.indexOf(raw.toLowerCase());
    const n = named >= 0 ? named + field.base : /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < field.min || n > field.max) {
      throw new CronError(msg('cronFieldValue', { value: raw, field: field.key, min: field.min, max: field.max }));
    }
    return n;
  };
  for (const part of text.split(',')) {
    if (!part) throw new CronError(msg('cronEmptyItem', { field: field.key }));
    const [range, stepText, extra] = part.split('/');
    if (extra !== undefined) throw new CronError(msg('cronPartInvalid', { value: part, field: field.key }));
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1 || !/^\d+$/.test(stepText ?? '1'))
      throw new CronError(msg('cronStepInvalid', { value: String(stepText), field: field.key }));
    let from: number;
    let to: number;
    if (range === '*') {
      from = field.min;
      to = field.name === 'día de la semana' ? 6 : field.max;
    } else if (range.includes('-')) {
      const [a, b, more] = range.split('-');
      if (more !== undefined) throw new CronError(msg('cronRangeInvalid', { value: range, field: field.key }));
      from = number(a);
      to = number(b);
      if (from > to) throw new CronError(msg('cronRangeReversed', { value: range, field: field.key }));
    } else {
      from = number(range);
      // «5/10» significa «desde 5, cada 10».
      to = stepText === undefined ? from : field.max;
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

/** Interpreta una expresión cron. Lanza CronError con un mensaje pensado para mostrarlo en el formulario. */
export function parseCron(expression: string): CronSpec {
  const text = expression.trim();
  const fields = (ALIASES[text.toLowerCase()] ?? text).split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError(msg('cronFieldCount'));
  }
  const [minutes, hours, dom, months, dow] = fields.map((f, i) => parseField(f, FIELDS[i]));
  return {
    minutes,
    hours,
    daysOfMonth: new Set(dom),
    months: new Set(months),
    // 7 también es domingo.
    daysOfWeek: new Set(dow.map((d) => d % 7)),
    domRestricted: !fields[2].startsWith('*'),
    dowRestricted: !fields[4].startsWith('*'),
  };
}

// ---------- Zonas horarias ----------
const formatters = new Map<string, Intl.DateTimeFormat>();

/** Zona horaria del equipo donde corre el servidor. */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, f);
  }
  return f;
}

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** Fecha y hora que marca el reloj de `zone` en el instante `ms`. */
export function wallTime(ms: number, zone: string): WallTime & { second: number } {
  const parts: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(new Date(ms))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

/** Diferencia (ms) entre la hora de `zone` y UTC en el instante `ms`. */
function offsetAt(ms: number, zone: string): number {
  const w = wallTime(ms, zone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * Instante en que el reloj de `zone` marca la hora dada. Si esa hora no existe (salto de primavera) devuelve el
 * instante equivalente tras el salto; si existe dos veces (otoño), la primera.
 */
export function zonedTimeToUtc(w: WallTime, zone: string): number {
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  // Los desfases de un día antes y un día después cubren cualquier cambio de hora cercano.
  const candidates = [...new Set([asUtc - offsetAt(asUtc - 86_400_000, zone), asUtc - offsetAt(asUtc + 86_400_000, zone)])];
  const exact = candidates.filter((t) => {
    const back = wallTime(t, zone);
    return back.hour === w.hour && back.minute === w.minute && back.day === w.day;
  });
  return exact.length ? Math.min(...exact) : Math.max(...candidates);
}

/** Años que se exploran como máximo: suficiente para «29 de febrero en lunes». */
const MAX_DAYS = 366 * 28;

/** Siguiente instante (ms), estrictamente posterior a `fromMs`, en que se cumple la expresión. Null si nunca. */
export function nextCronTime(spec: CronSpec, fromMs: number, zone: string): number | null {
  const start = wallTime(fromMs, zone);
  const startDay = Date.UTC(start.year, start.month - 1, start.day);
  for (let i = 0; i < MAX_DAYS; i++) {
    const date = new Date(startDay + i * 86_400_000);
    const month = date.getUTCMonth() + 1;
    if (!spec.months.has(month)) continue;
    const dom = spec.daysOfMonth.has(date.getUTCDate());
    const dow = spec.daysOfWeek.has(date.getUTCDay());
    const dayMatches = spec.domRestricted && spec.dowRestricted ? dom || dow : dom && dow;
    if (!dayMatches) continue;
    let best: number | null = null;
    for (const hour of spec.hours) {
      // El día de partida, las horas ya pasadas no pueden dar un instante futuro (con margen por el cambio de hora).
      if (i === 0 && hour < start.hour - 2) continue;
      for (const minute of spec.minutes) {
        const t = zonedTimeToUtc({ year: date.getUTCFullYear(), month, day: date.getUTCDate(), hour, minute }, zone);
        if (t > fromMs && (best === null || t < best)) best = t;
      }
      if (best !== null && i > 0) break;
    }
    if (best !== null) return best;
  }
  return null;
}

/** Expresión cron equivalente a «a las HH:MM los días indicados» (0 = domingo; lista vacía = todos). */
export function dailyCron(time: string, weekdays: number[]): string {
  const [hour, minute] = time.split(':').map(Number);
  const days = weekdays.length && weekdays.length < 7 ? [...new Set(weekdays)].sort((a, b) => a - b).join(',') : '*';
  return `${minute} ${hour} * * ${days}`;
}
