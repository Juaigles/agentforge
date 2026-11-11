// Exportación e importación de workflows como archivos JSON, y textos de la programación.
import type { ImportResult, Trigger } from '@shared/types';

/** Nombre de archivo seguro a partir del nombre del workflow (o del agente). */
export function exportFileName(name: string, fallback = 'workflow'): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || fallback}.agentforge.json`;
}

/** Descarga un objeto como archivo JSON legible. */
export function downloadJson(fileName: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Resumen de una importación terminada, para el aviso: «con 2 agentes nuevos, 1 herramienta nueva y 1 proveedor nuevo». */
export function importSummary(result: Pick<ImportResult, 'createdAgents' | 'replacedAgents' | 'createdTools' | 'replacedTools' | 'createdProviders' | 'createdWorkflows' | 'triggers'>): string {
  const count = (n: number, one: string, many: string): string => (n ? `${n} ${n === 1 ? one : many}` : '');
  const parts = [
    count(result.createdAgents.length, 'agente nuevo', 'agentes nuevos'),
    count(result.replacedAgents.length, 'agente sustituido', 'agentes sustituidos'),
    count(result.createdWorkflows.length, 'subworkflow nuevo', 'subworkflows nuevos'),
    count(result.createdTools.length, 'herramienta nueva', 'herramientas nuevas'),
    count(result.replacedTools.length, 'herramienta sustituida', 'herramientas sustituidas'),
    count(result.createdProviders.length, 'proveedor nuevo', 'proveedores nuevos'),
    count(result.triggers, 'disparador en pausa', 'disparadores en pausa'),
  ].filter(Boolean);
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`;
}

/** Lee un archivo elegido por el usuario como JSON; lanza un error legible si no lo es. */
export async function readJsonFile(file: File): Promise<unknown> {
  if (file.size > 2 * 1024 * 1024) throw new Error('El archivo es demasiado grande (máximo 2 MB).');
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`«${file.name}» no es un archivo JSON válido.`);
  }
}

/** Días de la semana en el orden en que se muestran (lunes primero); `value` es el de cron (0 = domingo). */
export const WEEKDAYS = [
  { value: 1, short: 'lun', long: 'lunes' },
  { value: 2, short: 'mar', long: 'martes' },
  { value: 3, short: 'mié', long: 'miércoles' },
  { value: 4, short: 'jue', long: 'jueves' },
  { value: 5, short: 'vie', long: 'viernes' },
  { value: 6, short: 'sáb', long: 'sábado' },
  { value: 0, short: 'dom', long: 'domingo' },
];

function joinList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

/** Días elegidos en lenguaje natural: «de lunes a viernes», «lun, mié y vie», «cada día». */
export function describeWeekdays(weekdays: number[]): string {
  const chosen = WEEKDAYS.filter((d) => weekdays.includes(d.value));
  if (!chosen.length || chosen.length === 7) return 'cada día';
  const key = chosen.map((d) => d.value).join('');
  if (key === '12345') return 'de lunes a viernes';
  if (key === '60') return 'los fines de semana';
  return chosen.length === 1 ? `los ${chosen[0].long}` : joinList(chosen.map((d) => d.short));
}

/** Disparador en lenguaje natural: «cada 15 min», «de lunes a viernes a las 07:45», «al recibir un webhook». */
export function describeTrigger(t: Pick<Trigger, 'kind' | 'intervalMinutes' | 'time' | 'weekdays' | 'cron' | 'timezone'>): string {
  const zone = t.timezone ? ` (${t.timezone})` : '';
  if (t.kind === 'webhook') return 'al recibir un webhook';
  if (t.kind === 'cron') return `según el cron «${t.cron}»${zone}`;
  if (t.kind === 'daily') return `${describeWeekdays(t.weekdays ?? [])} a las ${t.time}${zone}`;
  const minutes = t.intervalMinutes ?? 0;
  if (minutes % 1440 === 0) return minutes === 1440 ? 'cada día' : `cada ${minutes / 1440} días`;
  if (minutes % 60 === 0) return minutes === 60 ? 'cada hora' : `cada ${minutes / 60} h`;
  return minutes === 1 ? 'cada minuto' : `cada ${minutes} min`;
}

/** Resumen de los disparadores de un workflow para una etiqueta: el único activo, o cuántos hay. Null si no tiene. */
export function summarizeTriggers(triggers: Trigger[]): { text: string; active: boolean } | null {
  if (!triggers.length) return null;
  const active = triggers.filter((t) => t.enabled);
  if (!active.length) return { text: triggers.length === 1 ? 'disparador en pausa' : 'disparadores en pausa', active: false };
  return { text: active.length === 1 ? describeTrigger(active[0]) : `${active.length} disparadores`, active: true };
}

export type IntervalUnit = 'minutes' | 'hours' | 'days';
const UNIT_MINUTES: Record<IntervalUnit, number> = { minutes: 1, hours: 60, days: 1440 };

/** Descompone unos minutos en la unidad más grande que los representa sin decimales. */
export function splitInterval(minutes: number): { value: number; unit: IntervalUnit } {
  if (minutes >= 1440 && minutes % 1440 === 0) return { value: minutes / 1440, unit: 'days' };
  if (minutes >= 60 && minutes % 60 === 0) return { value: minutes / 60, unit: 'hours' };
  return { value: minutes, unit: 'minutes' };
}
export const toMinutes = (value: number, unit: IntervalUnit): number => Math.round(value * UNIT_MINUTES[unit]);
