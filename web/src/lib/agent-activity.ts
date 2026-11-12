// Qué está haciendo un agente en este momento, para el orbe animado (AgentAvatar) y el grafo en vivo.
import type { ActivityLog, StepLive } from './run-state';

/**
 * - `idle`: disponible, sin trabajo (el orbe «respira»).
 * - `thinking`: esperando al modelo o razonando (anillo que gira).
 * - `tool`: usando una herramienta (satélites en órbita).
 * - `writing`: el modelo está escribiendo la respuesta (ondas hacia fuera).
 * - `waiting`: parado a la espera de una aprobación humana (pulso lento).
 * - `done` / `error`: terminó bien o mal (anillo fijo, sin movimiento).
 */
export type AgentActivity = 'idle' | 'thinking' | 'tool' | 'writing' | 'waiting' | 'done' | 'error';

/** Si el nodo tiene alguna llamada a herramienta sin resultado todavía (a cualquier profundidad). */
export function hasOpenTool(log: ActivityLog, nodeId: string): boolean {
  const prefix = `${nodeId}|`;
  for (const key in log.openTools) if (key.startsWith(prefix)) return true;
  return false;
}

/**
 * Actividad de un paso de agente a partir de su estado en vivo. `toolOpen` dice si tiene una herramienta en marcha.
 * Un paso sin estado (aún no ha empezado) devuelve `undefined`: el orbe se queda quieto.
 */
export function stepActivity(step: StepLive | undefined, toolOpen: boolean): AgentActivity | undefined {
  if (!step) return undefined;
  switch (step.status) {
    case 'running':
      // Una herramienta abierta manda: mientras corre, el modelo no escribe aunque quede texto de la vuelta anterior.
      if (toolOpen) return 'tool';
      if (step.streamText) return 'writing';
      return 'thinking';
    case 'waiting':
      return 'waiting';
    case 'completed':
      return 'done';
    case 'failed':
      return 'error';
    default:
      // Pendiente, omitido o cancelado: orbe quieto; la insignia de estado ya dice qué pasó.
      return undefined;
  }
}
