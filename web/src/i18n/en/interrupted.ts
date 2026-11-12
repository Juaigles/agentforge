// Texts of the notice about runs interrupted by a server shutdown (InterruptedBanner).
export default {
  title: 'A run was interrupted when the server shut down. | {n} runs were interrupted when the server shut down.',
  body: 'You can resume each {run} where it left off: the steps that had already finished are reused and only the rest is repeated.',
  bodyRun: 'run',
  more: 'and {n} more',
  resume: 'Resume | Resume all',
  dismiss: 'Dismiss',
  toast: {
    resumedOne: '"{name}" has been resumed.',
    resumedMany: '{n} run resumed. | {n} runs resumed.',
  },
};
