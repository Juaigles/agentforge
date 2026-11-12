// Textos de lib/transfer.ts: errores al leer archivos, resumen de importaciones y descripción de los disparadores.
export default {
  errors: {
    tooLarge: 'El archivo es demasiado grande (máximo 2 MB).',
    notJson: '«{name}» no es un archivo JSON válido.',
  },
  list: {
    and: '{head} y {last}',
  },
  summary: {
    createdAgents: '{n} agente nuevo | {n} agentes nuevos',
    replacedAgents: '{n} agente sustituido | {n} agentes sustituidos',
    createdWorkflows: '{n} subworkflow nuevo | {n} subworkflows nuevos',
    createdTools: '{n} herramienta nueva | {n} herramientas nuevas',
    replacedTools: '{n} herramienta sustituida | {n} herramientas sustituidas',
    createdProviders: '{n} proveedor nuevo | {n} proveedores nuevos',
    pausedTriggers: '{n} disparador en pausa | {n} disparadores en pausa',
  },
  weekday: {
    sun: { short: 'dom', long: 'domingo' },
    mon: { short: 'lun', long: 'lunes' },
    tue: { short: 'mar', long: 'martes' },
    wed: { short: 'mié', long: 'miércoles' },
    thu: { short: 'jue', long: 'jueves' },
    fri: { short: 'vie', long: 'viernes' },
    sat: { short: 'sáb', long: 'sábado' },
  },
  days: {
    everyDay: 'cada día',
    workdays: 'de lunes a viernes',
    weekend: 'los fines de semana',
    onDay: 'los {day}',
  },
  trigger: {
    webhook: 'al recibir un webhook',
    cron: 'según el cron «{cron}»',
    daily: '{days} a las {time}',
    everyDay: 'cada día',
    everyDays: 'cada {n} días',
    everyHour: 'cada hora',
    everyHours: 'cada {n} h',
    everyMinute: 'cada minuto',
    everyMinutes: 'cada {n} min',
    paused: 'disparador en pausa | disparadores en pausa',
    count: '{n} disparador | {n} disparadores',
  },
};
