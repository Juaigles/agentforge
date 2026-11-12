// Herramientas integradas: título, categoría y descripción para la pantalla, por nombre de herramienta. Son los
// mismos textos que entrega el servidor (lo comprueba tool-text.test.ts); la descripción que lee el modelo es la
// del servidor y no cambia con el idioma de la interfaz.
export default {
  category: {
    utilities: 'Utilidades',
    network: 'Red',
    files: 'Archivos',
    coordination: 'Coordinación',
    code: 'Código',
    custom: 'Personalizadas',
  },
  calculator: {
    title: 'Calculadora',
    description:
      'Evalúa una expresión matemática con precisión. Soporta + - * / % ^, paréntesis, constantes (pi, e) y funciones (sqrt, abs, round, floor, ceil, min, max, pow, exp, ln, log, sin, cos, tan).',
    params: { expression: 'Expresión matemática a evaluar.' },
  },
  current_datetime: {
    title: 'Fecha y hora actual',
    description: 'Devuelve la fecha y hora actuales (ISO 8601, hora local y día de la semana).',
    params: { timezone: 'Zona horaria IANA opcional, p. ej. "Europe/Madrid".' },
  },
  http_request: {
    title: 'Petición HTTP',
    description: 'Realiza una petición HTTP(S) a una API y devuelve el estado, las cabeceras y el cuerpo (JSON si es posible). Útil para consultar APIs REST.',
    params: {
      url: 'URL completa (http o https).',
      method: 'Método HTTP.',
      headers: 'Cabeceras como objeto JSON.',
      body: 'Cuerpo de la petición (texto o JSON serializado).',
    },
  },
  web_fetch: {
    title: 'Leer página web',
    description: 'Descarga una página web y devuelve su contenido como texto legible (sin HTML). Útil para leer artículos o documentación.',
    params: { url: 'URL de la página (http o https).', max_chars: 'Máximo de caracteres a devolver.' },
  },
  file_write: {
    title: 'Escribir archivo',
    description: 'Escribe (o sobrescribe) un archivo de texto en el espacio de trabajo de AgentForge. Útil para guardar informes, datos o código.',
    params: {
      path: 'Ruta relativa dentro del espacio de trabajo, p. ej. "informes/resumen.md".',
      content: 'Contenido del archivo.',
      append: 'Si es true, añade al final en lugar de sobrescribir.',
    },
  },
  file_read: {
    title: 'Leer archivo',
    description: 'Lee un archivo de texto del espacio de trabajo de AgentForge.',
    params: { path: 'Ruta relativa dentro del espacio de trabajo.' },
  },
  file_list: {
    title: 'Listar archivos',
    description: 'Lista los archivos del espacio de trabajo de AgentForge (recursivo).',
    params: { directory: 'Subdirectorio opcional.' },
  },
  memory_set: {
    title: 'Guardar en memoria compartida',
    description: 'Guarda un dato en la memoria compartida de la ejecución. Otros agentes del mismo workflow pueden leerlo con memory_get.',
    params: { key: 'Nombre del dato.', value: 'Valor a guardar.' },
  },
  memory_get: {
    title: 'Leer memoria compartida',
    description: 'Lee un dato de la memoria compartida de la ejecución. Sin "key" devuelve la lista de claves disponibles.',
    params: { key: 'Nombre del dato a leer (opcional).' },
  },
  delegate_task: {
    title: 'Delegar en otro agente',
    description:
      'Delega una subtarea en otro agente especializado y devuelve su respuesta. Da instrucciones completas y autocontenidas: el otro agente no ve esta conversación.',
    params: { agent: 'Nombre exacto del agente al que delegar.', task: 'Descripción completa de la subtarea.' },
  },
  run_javascript: {
    title: 'Ejecutar JavaScript',
    description:
      'Ejecuta código JavaScript en un entorno aislado (sin acceso a red, disco ni módulos) y devuelve el valor de la última expresión y lo impreso con console.log. Útil para cálculos y transformación de datos.',
    params: { code: 'Código JavaScript. La última expresión es el resultado.' },
  },
};
