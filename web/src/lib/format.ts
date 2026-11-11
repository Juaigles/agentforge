// Formateo de valores para la interfaz (español).
import type { NodeType, RunStatus, StepStatus } from '@shared/types';

const nf = new Intl.NumberFormat('es-ES');
const compact = new Intl.NumberFormat('es-ES', { notation: 'compact', maximumFractionDigits: 1 });

export const formatNumber = (n: number): string => nf.format(n);
export const formatCompact = (n: number): string => (n < 10_000 ? nf.format(n) : compact.format(n));

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0).replace('.', ',')} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s % 60)} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Duración entre dos instantes ISO; si no hay fin se mide hasta `now`. */
export function elapsedMs(startedAt: string | null, finishedAt: string | null, now = Date.now()): number | null {
  if (!startedAt) return null;
  return (finishedAt ? Date.parse(finishedAt) : now) - Date.parse(startedAt);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0).replace('.', ',')} ${units[i]}`;
}

const rtf = new Intl.RelativeTimeFormat('es-ES', { numeric: 'auto' });

export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const diff = (Date.parse(iso) - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'ahora mismo';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 30 * 86_400) return rtf.format(Math.round(diff / 86_400), 'day');
  return new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const formatTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function formatUptime(sec: number): string {
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min`;
  return `${Math.floor(sec / 86_400)} d ${Math.floor((sec % 86_400) / 3600)} h`;
}

export type Tone = 'success' | 'danger' | 'warning' | 'info' | 'neutral';

export const STATUS_LABEL: Record<RunStatus | StepStatus, string> = {
  queued: 'En cola',
  pending: 'Pendiente',
  running: 'En curso',
  waiting: 'En espera',
  completed: 'Completado',
  failed: 'Fallido',
  cancelled: 'Cancelado',
  skipped: 'Omitido',
};

export const STATUS_TONE: Record<RunStatus | StepStatus, Tone> = {
  queued: 'neutral',
  pending: 'neutral',
  running: 'info',
  waiting: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'warning',
  skipped: 'neutral',
};

export const NODE_LABEL: Record<NodeType, string> = {
  input: 'Entrada',
  agent: 'Agente',
  tool: 'Herramienta',
  condition: 'Condición',
  transform: 'Transformación',
  foreach: 'Para cada',
  subworkflow: 'Subworkflow',
  approval: 'Aprobación',
  output: 'Salida',
};

/** ¿La ejecución sigue viva? (en cola, en curso o detenida a la espera de una aprobación). */
export const isActiveStatus = (s: RunStatus): boolean => s === 'queued' || s === 'running' || s === 'waiting';

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function plural(n: number, one: string, many: string): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}
