// Texts of lib/flow.ts: help for each node type, condition operators and connections.
export default {
  hint: {
    input: 'The text the workflow is started with',
    agent: 'An agent carries out a task',
    tool: 'Runs a tool without going through a model',
    condition: 'Picks a branch based on the previous result',
    transform: 'Combines results using a template',
    foreach: 'Repeats a task for each item in a list',
    subworkflow: 'Runs another workflow as a step of this one',
    approval: 'Pauses the run until a person approves or rejects',
    output: 'The final result of the workflow',
  },
  operator: {
    contains: 'contains',
    not_contains: 'does not contain',
    equals: 'equals',
    not_equals: 'is not equal to',
    matches: 'matches the regular expression',
    gt: 'is greater than',
    lt: 'is less than',
    is_empty: 'is empty',
    not_empty: 'is not empty',
  },
  branch: {
    yes: 'yes',
    no: 'no',
  },
  edge: {
    label: 'Connection from {from} to {to}',
    labelBranch: 'Connection from {from} to {to} ({branch} branch)',
  },
};
