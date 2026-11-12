// Exportación e importación de workflows como archivos JSON, y textos de la programación.
import type { ImportResult, Trigger } from '@shared/types';
import { t, tn } from '@/i18n';

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
  // La dirección se libera con margen: revocarla al segundo cancelaba la descarga en equipos lentos o cargados.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Resumen de una importación terminada, para el aviso: «con 2 agentes nuevos, 1 herramienta nueva y 1 proveedor nuevo». */
export function importSummary(result: Pick<ImportResult, 'createdAgents' | 'replacedAgents' | 'createdTools' | 'replacedTools' | 'createdProviders' | 'createdWorkflows' | 'triggers'>): string {
  const count = (n: number, key: string): string => (n ? tn(`transfer.summary.${key}`, n) : '');
  const parts = [
    count(result.createdAgents.length, 'createdAgents'),
    count(result.replacedAgents.length, 'replacedAgents'),
    count(result.createdWorkflows.length, 'createdWorkflows'),
    count(result.createdTools.length, 'createdTools'),
    count(result.replacedTools.length, 'replacedTools'),
    count(result.createdProviders.length, 'createdProviders'),
    count(result.triggers, 'pausedTriggers'),
  ].filter(Boolean);
  return joinList(parts);
}

/** Lee un archivo elegido por el usuario como JSON; lanza un error legible si no lo es. */
export async function readJsonFile(file: File): Promise<unknown> {
  if (file.size > 2 * 1024 * 1024) throw new Error(t('transfer.errors.tooLarge'));
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(t('transfer.errors.notJson', { name: file.name }));
  }
}

/** Días de la semana en el orden en que se muestran (lunes primero); `value` es el de cron (0 = domingo). Los nombres dependen del idioma. */
export function weekdays(): Array<{ value: number; short: string; long: string }> {
  const days: Array<[number, string]> = [[1, 'mon'], [2, 'tue'], [3, 'wed'], [4, 'thu'], [5, 'fri'], [6, 'sat'], [0, 'sun']];
  return days.map(([value, key]) => ({ value, short: t(`transfer.weekday.${key}.short`), long: t(`transfer.weekday.${key}.long`) }));
}

function joinList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : t('transfer.list.and', { head: items.slice(0, -1).join(', '), last: items[items.length - 1] });
}

/** Días elegidos en lenguaje natural: «de lunes a viernes», «lun, mié y vie», «cada día». */
export function describeWeekdays(selected: number[]): string {
  const chosen = weekdays().filter((d) => selected.includes(d.value));
  if (!chosen.length || chosen.length === 7) return t('transfer.days.everyDay');
  const key = chosen.map((d) => d.value).join('');
  if (key === '12345') return t('transfer.days.workdays');
  if (key === '60') return t('transfer.days.weekend');
  return chosen.length === 1 ? t('transfer.days.onDay', { day: chosen[0].long }) : joinList(chosen.map((d) => d.short));
}

/** Disparador en lenguaje natural: «cada 15 min», «de lunes a viernes a las 07:45», «al recibir un webhook». */
export function describeTrigger(trigger: Pick<Trigger, 'kind' | 'intervalMinutes' | 'time' | 'weekdays' | 'cron' | 'timezone'>): string {
  const zone = trigger.timezone ? ` (${trigger.timezone})` : '';
  if (trigger.kind === 'webhook') return t('transfer.trigger.webhook');
  if (trigger.kind === 'cron') return `${t('transfer.trigger.cron', { cron: trigger.cron })}${zone}`;
  if (trigger.kind === 'daily') return `${t('transfer.trigger.daily', { days: describeWeekdays(trigger.weekdays ?? []), time: trigger.time })}${zone}`;
  const minutes = trigger.intervalMinutes ?? 0;
  if (minutes % 1440 === 0) return minutes === 1440 ? t('transfer.trigger.everyDay') : t('transfer.trigger.everyDays', { n: minutes / 1440 });
  if (minutes % 60 === 0) return minutes === 60 ? t('transfer.trigger.everyHour') : t('transfer.trigger.everyHours', { n: minutes / 60 });
  return minutes === 1 ? t('transfer.trigger.everyMinute') : t('transfer.trigger.everyMinutes', { n: minutes });
}

/** Resumen de los disparadores de un workflow para una etiqueta: el único activo, o cuántos hay. Null si no tiene. */
export function summarizeTriggers(triggers: Trigger[]): { text: string; active: boolean } | null {
  if (!triggers.length) return null;
  const active = triggers.filter((trigger) => trigger.enabled);
  if (!active.length) return { text: tn('transfer.trigger.paused', triggers.length), active: false };
  return { text: active.length === 1 ? describeTrigger(active[0]) : tn('transfer.trigger.count', active.length), active: true };
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
