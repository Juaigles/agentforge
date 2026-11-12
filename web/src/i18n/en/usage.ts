// Texts of the "Delete agent" dialog (lib/usage.ts).
export default {
  deleteBase: '“{name}” will be deleted.',
  deleteTail: 'Previous runs are kept in the history.',
  deleteUnused: '{base} No workflow uses it. {tail}',
  deleteUsed:
    '{base} It is used by {n} workflow ({names}), which will no longer be able to run until you assign it another agent. {tail} | {base} It is used by {n} workflows ({names}), which will no longer be able to run until you assign them another agent. {tail}',
  quoted: '“{name}”',
  andMore: '{names} and {count} more',
};
