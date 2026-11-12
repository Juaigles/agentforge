// Validación de workflows en inglés. Los problemas llegan con su código y sus parámetros
// (shared/validation-messages.ts); el tipo obliga a que aquí estén exactamente los mismos códigos.
import type { ValidationIssue } from '@shared/types';
import type { IssueParams, ValidationCode } from '@shared/validation-messages';
import { locale } from '@/i18n';

export const VALIDATION_EN: Record<ValidationCode, (p: IssueParams) => string> = {
  empty: () => 'The workflow has no nodes.',
  subworkflowUnset: (p) => `Node "${p.name}" has no workflow assigned.`,
  subworkflowSelf: (p) => `Node "${p.name}" cannot call the workflow it belongs to.`,
  subworkflowGone: (p) => `Node "${p.name}" uses a workflow that no longer exists.`,
  subworkflowCycleSelf: (p) => `Subworkflow "${p.workflow}" of "${p.name}" ends up calling this same workflow (cycle between workflows).`,
  subworkflowCycle: (p) => `Subworkflow "${p.workflow}" of "${p.name}" contains a cycle between workflows.`,
  subworkflowDepth: (p) => `Subworkflow "${p.workflow}" of "${p.name}" nests more than ${p.max} levels of workflows.`,
  nodeIdInvalid: (p) => `Invalid node id: "${p.id}" (letters, numbers, _ and - only).`,
  nodeIdReserved: (p) => `Node id "${p.id}" is reserved: change it (it would clash with the reference {{${p.id}}}).`,
  nodeIdDuplicate: (p) => `Duplicate node id: "${p.id}".`,
  multipleInputs: () => 'There can only be one input node.',
  edgeDangling: (p) => `Connection "${p.id}" points to a node that does not exist.`,
  selfLoop: () => 'A node cannot be connected to itself.',
  duplicateEdges: () => 'There are duplicate connections between the same nodes.',
  cycle: () => 'The workflow contains a cycle; it must be an acyclic graph.',
  inputHasIncoming: (p) => `Input node "${p.name}" cannot have incoming connections.`,
  inputUnconnected: (p) => `Input node "${p.name}" is not connected.`,
  agentUnset: (p) => `Node "${p.name}" has no agent assigned.`,
  agentGone: (p) => `Node "${p.name}" uses an agent that no longer exists.`,
  promptEmpty: (p) => `Node "${p.name}" has no instructions (prompt).`,
  toolUnset: (p) => `Node "${p.name}" has no tool assigned.`,
  toolUnknown: (p) => `Node "${p.name}" uses an unknown tool: ${p.tool}.`,
  conditionNoOperator: (p) => `Condition "${p.name}" has no operator.`,
  conditionBadRegex: (p) => `Condition "${p.name}" has an invalid regular expression.`,
  conditionEmptyRight: (p) => `Condition "${p.name}" compares against an empty value.`,
  conditionBadBranch: (p) => `The outputs of condition "${p.name}" must start from "yes" or "no".`,
  conditionNoBranches: (p) => `Condition "${p.name}" has no connected branches.`,
  conditionNoIncoming: (p) => `Condition "${p.name}" needs an incoming connection.`,
  templateEmpty: (p) => `Node "${p.name}" has no template.`,
  foreachTaskEmpty: (p) => `Node "${p.name}" has no task to apply to each item.`,
  foreachTaskNoItem: (p) => `The task of "${p.name}" does not use {{item}}: every item will get exactly the same task.`,
  foreachArgsNoItem: (p) => `The arguments of "${p.name}" do not use {{item}}: the tool will receive the same input for every item.`,
  foreachBadPolicy: (p) => `"${p.name}": the policy for a failed item must be "stop" or "continue".`,
  foreachNoList: (p) => `Node "${p.name}" has nowhere to get the list from: connect it or set a template.`,
  foreachListUsesItem: (p) => `The list of "${p.name}" cannot use {{item}}, {{index}} or {{total}}: they only exist inside the task.`,
  foreachConcurrencyRange: (p) => `The concurrency of "${p.name}" must be between 1 and ${p.max}.`,
  foreachMaxItemsRange: (p) => `The maximum number of items of "${p.name}" must be between 1 and ${p.max}.`,
  subworkflowNoInput: (p) => `Node "${p.name}" has no input to pass to the subworkflow: connect it or set a template.`,
  approvalNoMessage: (p) => `Approval "${p.name}" has no text describing what is to be approved.`,
  approvalBadBranch: (p) => `The outputs of approval "${p.name}" must start from "approved" or "rejected".`,
  approvalNoBranches: (p) => `Approval "${p.name}" has no connected branches.`,
  outputHasOutgoing: (p) => `Output node "${p.name}" cannot have outgoing connections.`,
  outputNoIncoming: (p) => `Output node "${p.name}" needs an incoming connection.`,
  unknownNodeType: (p) => `Unknown node type: ${p.type}.`,
  upstreamNoIncoming: (p) => `"${p.name}" uses {{upstream}} but has no incoming connections.`,
  foreachRefOutside: (p) => `"${p.name}" uses {{${p.ref}}}, which only exists inside a "for each" node.`,
  refMissing: (p) => `"${p.name}" references a node that does not exist: {{${p.ref}}}.`,
  refNotAncestor: (p) => `"${p.name}" references {{${p.ref}}}, which does not run before it (it is not an earlier node).`,
  refNoComment: (p) => `"${p.name}" uses {{${p.ref}}}, but only approvals have a comment.`,
  noWork: () => 'The workflow contains no agent or tool.',
};

/** Texto de un problema de validación en el idioma de la interfaz (reactivo). */
export function issueText(issue: Pick<ValidationIssue, 'message' | 'code' | 'params'>): string {
  if (locale.value !== 'en' || !issue.code) return issue.message;
  return VALIDATION_EN[issue.code]?.(issue.params ?? {}) ?? issue.message;
}
