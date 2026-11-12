// Qué workflows usan un agente, y el texto de confirmación al borrarlo (el mismo en la lista y en la ficha).
import type { Workflow } from '@shared/types';
import { t, tn } from '@/i18n';

/** Workflows con algún nodo (agente o «para cada») que usa el agente indicado. */
export function workflowsUsingAgent(workflows: Workflow[], agentId: string): Workflow[] {
  return workflows.filter((w) => w.nodes.some((n) => (n.type === 'agent' || n.type === 'foreach') && n.config?.agentId === agentId));
}

/** Mensaje del diálogo «Eliminar agente»: dice qué workflows dejarán de poder ejecutarse. */
export function agentDeleteMessage(agentName: string, usedBy: Workflow[]): string {
  const base = t('usage.deleteBase', { name: agentName });
  const tail = t('usage.deleteTail');
  if (!usedBy.length) return t('usage.deleteUnused', { base, tail });
  const shown = usedBy.slice(0, 5).map((w) => t('usage.quoted', { name: w.name }));
  const names = shown.join(', ');
  const list = usedBy.length > shown.length ? t('usage.andMore', { names, count: usedBy.length - shown.length }) : names;
  return tn('usage.deleteUsed', usedBy.length, { base, names: list, tail });
}
