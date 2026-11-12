// Texts of the notice about runs waiting for a human decision (ApprovalsBanner).
export default {
  title: 'A run is waiting for your decision | {n} runs are waiting for your decision',
  intro: 'An {approval} node has paused the {run} until someone decides. While it waits it uses no time and takes no run slot.',
  introApproval: 'approval',
  introRun: 'run',
  viewLess: 'Show less',
  viewAll: 'Show full text',
  commentLabel: 'Comment for "{name}" (optional)',
  commentPlaceholder: 'Comment (optional): the following steps can use it',
  approve: 'Approve',
  reject: 'Reject',
  toast: {
    approved: 'Approved: "{name}" continues.',
    rejected: 'Rejected: "{name}" follows the other branch.',
    waiting: '"{name}" is waiting for your decision.',
    decide: 'Decide',
  },
};
