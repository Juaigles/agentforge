// Exportación e importación de workflows como archivos JSON, y textos de la programación.
import type { Schedule } from '@shared/types';

/** Nombre de archivo seguro a partir del nombre del workflow. */
export function exportFileName(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'workflow'}.agentforge.json`;
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

/** Cadencia de una programación en lenguaje natural: «cada 15 min», «cada 2 h», «cada día a las 07:45». */
export function describeSchedule(s: Pick<Schedule, 'kind' | 'intervalMinutes' | 'time'>): string {
  if (s.kind === 'daily') return `cada día a las ${s.time}`;
  const minutes = s.intervalMinutes ?? 0;
  if (minutes % 1440 === 0) return minutes === 1440 ? 'cada día' : `cada ${minutes / 1440} días`;
  if (minutes % 60 === 0) return minutes === 60 ? 'cada hora' : `cada ${minutes / 60} h`;
  return minutes === 1 ? 'cada minuto' : `cada ${minutes} min`;
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
