// Qué workflows usan un agente, y el texto de confirmación al borrarlo (el mismo en la lista y en la ficha).
import type { Workflow } from '@shared/types';

/** Workflows con algún nodo (agente o «para cada») que usa el agente indicado. */
export function workflowsUsingAgent(workflows: Workflow[], agentId: string): Workflow[] {
  return workflows.filter((w) => w.nodes.some((n) => (n.type === 'agent' || n.type === 'foreach') && n.config?.agentId === agentId));
}

/** Mensaje del diálogo «Eliminar agente»: dice qué workflows dejarán de poder ejecutarse. */
export function agentDeleteMessage(agentName: string, usedBy: Workflow[]): string {
  const base = `Se eliminará «${agentName}».`;
  const tail = 'Las ejecuciones anteriores se conservan en el historial.';
  if (!usedBy.length) return `${base} Ningún workflow lo usa. ${tail}`;
  const shown = usedBy.slice(0, 5).map((w) => `«${w.name}»`);
  const names = shown.join(', ') + (usedBy.length > shown.length ? ` y ${usedBy.length - shown.length} más` : '');
  const many = usedBy.length > 1;
  return `${base} Lo ${many ? `usan ${usedBy.length} workflows` : 'usa 1 workflow'} (${names}), que ${many ? 'dejarán' : 'dejará'} de poder ejecutarse hasta que ${many ? 'les' : 'le'} asignes otro agente. ${tail}`;
}
