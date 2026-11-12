// Texts of lib/transfer.ts: file reading errors, import summary and the plain-language description of triggers.
export default {
  errors: {
    tooLarge: 'The file is too large (2 MB maximum).',
    notJson: '“{name}” is not a valid JSON file.',
  },
  list: {
    and: '{head} and {last}',
  },
  summary: {
    createdAgents: '{n} new agent | {n} new agents',
    replacedAgents: '{n} replaced agent | {n} replaced agents',
    createdWorkflows: '{n} new subworkflow | {n} new subworkflows',
    createdTools: '{n} new tool | {n} new tools',
    replacedTools: '{n} replaced tool | {n} replaced tools',
    createdProviders: '{n} new provider | {n} new providers',
    pausedTriggers: '{n} paused trigger | {n} paused triggers',
  },
  weekday: {
    sun: { short: 'Sun', long: 'Sunday' },
    mon: { short: 'Mon', long: 'Monday' },
    tue: { short: 'Tue', long: 'Tuesday' },
    wed: { short: 'Wed', long: 'Wednesday' },
    thu: { short: 'Thu', long: 'Thursday' },
    fri: { short: 'Fri', long: 'Friday' },
    sat: { short: 'Sat', long: 'Saturday' },
  },
  days: {
    everyDay: 'every day',
    workdays: 'Monday to Friday',
    weekend: 'on weekends',
    onDay: 'on {day}s',
  },
  trigger: {
    webhook: 'when a webhook is received',
    cron: 'on the cron “{cron}”',
    daily: '{days} at {time}',
    everyDay: 'every day',
    everyDays: 'every {n} days',
    everyHour: 'every hour',
    everyHours: 'every {n} h',
    everyMinute: 'every minute',
    everyMinutes: 'every {n} min',
    paused: 'paused trigger | paused triggers',
    count: '{n} trigger | {n} triggers',
  },
};
