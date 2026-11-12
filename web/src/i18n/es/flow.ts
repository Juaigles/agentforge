// Textos de lib/flow.ts: ayuda de cada tipo de nodo, operadores de condición y conexiones.
export default {
  hint: {
    input: 'El texto con el que se lanza el workflow',
    agent: 'Un agente realiza una tarea',
    tool: 'Ejecuta una herramienta sin pasar por un modelo',
    condition: 'Elige una rama según el resultado anterior',
    transform: 'Combina resultados con una plantilla',
    foreach: 'Repite una tarea con cada elemento de una lista',
    subworkflow: 'Ejecuta otro workflow como un paso de este',
    approval: 'Detiene la ejecución hasta que una persona aprueba o rechaza',
    output: 'El resultado final del workflow',
  },
  operator: {
    contains: 'contiene',
    not_contains: 'no contiene',
    equals: 'es igual a',
    not_equals: 'es distinto de',
    matches: 'cumple la expresión regular',
    gt: 'es mayor que',
    lt: 'es menor que',
    is_empty: 'está vacío',
    not_empty: 'no está vacío',
  },
  branch: {
    yes: 'sí',
    no: 'no',
  },
  edge: {
    label: 'Conexión de {from} a {to}',
    labelBranch: 'Conexión de {from} a {to} (rama {branch})',
  },
};
