// Glosario: única fuente de verdad de las definiciones que muestran los tooltips (<Term>) y la página Glosario.

export interface GlossaryEntry {
  term: string;
  definition: string;
}

export const GLOSSARY = {
  agente: {
    term: 'Agente',
    definition: 'Un modelo de lenguaje con un papel, unas instrucciones y unas herramientas. Como un empleado con su puesto y su caja de herramientas.',
  },
  api: {
    term: 'API',
    definition: 'Puerta de entrada que un programa ofrece a otros programas: se le envía una petición y devuelve datos, sin pantallas de por medio.',
  },
  aprobacion: {
    term: 'Aprobación',
    definition: 'Punto de un workflow en el que la ejecución se detiene hasta que una persona aprueba o rechaza. Según lo que decida, sigue por una rama u otra.',
  },
  'api-key': {
    term: 'API key',
    definition: 'Contraseña que identifica tu cuenta ante un servicio. AgentForge la guarda cifrada y nunca la vuelve a mostrar.',
  },
  'base-url': {
    term: 'URL base',
    definition: 'Dirección raíz del servidor del proveedor, por ejemplo http://localhost:11434 para Ollama en tu equipo.',
  },
  'base-datos': {
    term: 'Base de datos',
    definition: 'Archivo donde AgentForge guarda agentes, workflows y ejecuciones (SQLite, en la carpeta de datos). Sobrevive a los reinicios.',
  },
  cabecera: {
    term: 'Cabecera',
    definition: 'Dato adicional que acompaña a una petición HTTP, como la credencial (Authorization) o el formato del contenido.',
  },
  capacidades: {
    term: 'Capacidades',
    definition: 'Lo que un modelo sabe hacer además de conversar: usar herramientas (tools), razonar (thinking), ver imágenes (vision)…',
  },
  'clave-acceso': {
    term: 'Clave de acceso',
    definition: 'Contraseña que el servidor de AgentForge pide para usarlo cuando se puede llegar a él desde otros equipos. La define quien lo arranca.',
  },
  cifrado: {
    term: 'Cifrado',
    definition: 'Transformar un dato con una clave para que sea ilegible sin ella. Las API keys se guardan así en el disco.',
  },
  cola: {
    term: 'Cola',
    definition: 'Fila de espera: cuando se alcanza el máximo de ejecuciones simultáneas, las nuevas aguardan aquí su turno.',
  },
  'copia-seguridad': {
    term: 'Copia de seguridad',
    definition: 'Un único archivo con todo lo que AgentForge guarda: agentes, workflows, historial, claves cifradas y archivos. Sirve para volver atrás o mudarse de equipo.',
  },
  contenedor: {
    term: 'Contenedor',
    definition: 'Caja cerrada que crea Docker o Podman para ejecutar un programa separado del resto del equipo: sin red, sin tus archivos y con memoria limitada.',
  },
  condicion: {
    term: 'Condición',
    definition: 'Nodo que compara un texto con un valor y sigue por la rama «sí» o por la rama «no». La otra rama se omite.',
  },
  concurrencia: {
    term: 'Concurrencia',
    definition: 'Cuántas cosas se hacen a la vez. Con concurrencia 2, dos agentes trabajan en paralelo y el resto espera turno.',
  },
  cron: {
    term: 'Cron',
    definition: 'Forma compacta de escribir un horario con cinco campos: minuto, hora, día del mes, mes y día de la semana. «0 9 * * 1-5» significa de lunes a viernes a las 9:00.',
  },
  dag: {
    term: 'DAG',
    definition: 'Grafo dirigido sin ciclos: las flechas nunca vuelven a un nodo anterior, así que siempre hay un orden posible de ejecución.',
  },
  delegacion: {
    term: 'Delegación',
    definition: 'Un agente encarga una subtarea a otro agente y espera su respuesta, como un jefe que reparte trabajo.',
  },
  disparador: {
    term: 'Disparador',
    definition: 'Lo que lanza un workflow sin que nadie pulse «Ejecutar»: un horario (cada cierto tiempo, ciertos días a una hora, un cron) o la llamada de otro programa (webhook).',
  },
  ejecucion: {
    term: 'Ejecución',
    definition: 'Cada vez que se pone en marcha un agente o un workflow. Queda guardada con sus pasos, resultados y eventos.',
  },
  herramienta: {
    term: 'Herramienta',
    definition: 'Función que el agente puede invocar para hacer algo real: calcular, leer una web, escribir un archivo o llamar a una API.',
  },
  http: {
    term: 'HTTP',
    definition: 'Protocolo con el que los programas piden y envían datos por la web. Una herramienta HTTP llama a una dirección y recibe una respuesta.',
  },
  instantanea: {
    term: 'Instantánea',
    definition: 'Copia del workflow y de sus agentes tal como estaban al lanzar la ejecución. Editar después no altera el historial.',
  },
  iteraciones: {
    term: 'Iteraciones',
    definition: 'Vueltas modelo → herramientas → modelo que puede dar un agente en una tarea. Al agotarlas debe responder con lo que tenga.',
  },
  json: {
    term: 'JSON',
    definition: 'Formato de texto para datos estructurados, con llaves y comillas: {"ciudad": "Madrid"}.',
  },
  'json-schema': {
    term: 'Esquema de parámetros',
    definition: 'Descripción de los datos que acepta una herramienta: nombre, tipo y si son obligatorios. El modelo la lee para saber cómo llamarla.',
  },
  llm: {
    term: 'LLM',
    definition: 'Modelo de lenguaje grande: el programa de IA que lee texto y genera la respuesta. Es el «cerebro» de cada agente.',
  },
  mcp: {
    term: 'MCP',
    definition: 'Model Context Protocol: un estándar para que un programa externo ofrezca herramientas a los agentes. Conectas un servidor MCP y sus herramientas aparecen junto a las demás.',
  },
  'memoria-compartida': {
    term: 'Memoria compartida',
    definition: 'Pizarra común de una ejecución: un agente apunta un dato y los demás agentes del mismo workflow pueden leerlo.',
  },
  'metodo-http': {
    term: 'Método HTTP',
    definition: 'El tipo de petición: GET pide datos, POST los envía, PUT y PATCH los modifican y DELETE los borra.',
  },
  modelo: {
    term: 'Modelo',
    definition: 'La versión concreta de IA que usa el agente, por ejemplo qwen3:8b. Los grandes razonan mejor; los pequeños responden antes.',
  },
  nodo: {
    term: 'Nodo',
    definition: 'Cada caja del workflow: una entrada, un agente, una herramienta, una condición, una transformación o una salida.',
  },
  nodejs: {
    term: 'Node.js',
    definition: 'Entorno que ejecuta el servidor de AgentForge en tu equipo. Su versión importa si algo deja de funcionar tras actualizarlo.',
  },
  ollama: {
    term: 'Ollama',
    definition: 'Programa gratuito que ejecuta modelos de IA en tu propio ordenador, sin enviar datos a ningún servicio externo.',
  },
  'openai-compatible': {
    term: 'Compatible con OpenAI',
    definition: 'Servicio que habla el mismo «idioma» que la API de OpenAI (OpenRouter, Groq, LM Studio…), así que se conecta igual.',
  },
  'para-cada': {
    term: 'Para cada',
    definition: 'Nodo que repite la misma tarea con cada elemento de una lista (varios a la vez) y reúne todos los resultados.',
  },
  paralelo: {
    term: 'En paralelo',
    definition: 'Varios pasos que no dependen entre sí se ejecutan a la vez en lugar de uno detrás de otro, y el workflow termina antes.',
  },
  plantilla: {
    term: 'Plantilla',
    definition: 'Texto con huecos entre llaves dobles, como {{input}}, que se rellenan con resultados reales al ejecutar.',
  },
  prompt: {
    term: 'Prompt',
    definition: 'El texto de instrucciones que se envía al modelo. De su claridad depende en gran parte la calidad de la respuesta.',
  },
  'prompt-sistema': {
    term: 'Instrucciones del sistema',
    definition: 'Texto fijo que define cómo debe comportarse el agente en todas sus tareas: tono, formato y límites.',
  },
  proveedor: {
    term: 'Proveedor',
    definition: 'Servicio que ejecuta los modelos: Ollama en tu equipo o una API remota compatible con OpenAI.',
  },
  razonamiento: {
    term: 'Razonamiento',
    definition: 'Modo en el que el modelo «piensa en voz baja» antes de responder. Mejora problemas difíciles, pero tarda y consume más.',
  },
  'red-privada': {
    term: 'Red privada',
    definition: 'Direcciones internas (localhost, 192.168.x.x…). Se bloquean por defecto para que un agente no alcance servicios de tu red.',
  },
  reintento: {
    term: 'Reintento',
    definition: 'Volver a ejecutar un paso que falló por un error pasajero, esperando cada vez un poco más entre intentos.',
  },
  sandbox: {
    term: 'Entorno aislado',
    definition: 'Espacio cerrado donde se ejecuta código sin acceso a tus archivos ni a la red, para limitar el daño de un error.',
  },
  streaming: {
    term: 'Streaming',
    definition: 'La respuesta llega palabra a palabra mientras el modelo la genera, en lugar de esperar al texto completo.',
  },
  subworkflow: {
    term: 'Subworkflow',
    definition: 'Un workflow que otro usa como si fuera un solo paso: se le pasa una entrada y devuelve su resultado. Sirve para reutilizar flujos de varios nodos.',
  },
  temperatura: {
    term: 'Temperatura',
    definition: 'Grado de azar del modelo. Cerca de 0 responde siempre parecido y preciso; valores altos lo hacen más creativo y variable.',
  },
  timeout: {
    term: 'Tiempo máximo',
    definition: 'Límite de espera. Si un paso tarda más, se corta y cuenta como fallo, para que nada quede colgado indefinidamente.',
  },
  tokens: {
    term: 'Tokens',
    definition: 'Trozos de palabra con los que el modelo mide el texto. Unas 100 palabras en español rondan los 150 tokens.',
  },
  url: {
    term: 'URL',
    definition: 'Dirección web completa de un recurso, por ejemplo https://api.ejemplo.com/clima?ciudad=Madrid.',
  },
  webhook: {
    term: 'Webhook',
    definition: 'Dirección web a la que otro programa envía una petición para avisar de algo. Aquí, cada llamada con el secreto correcto lanza el workflow con el cuerpo de la petición como entrada.',
  },
  workflow: {
    term: 'Workflow',
    definition: 'Flujo de trabajo: un diagrama de pasos conectados que coordina varios agentes y herramientas para resolver una tarea.',
  },
  'zona-horaria': {
    term: 'Zona horaria',
    definition: 'Región con la misma hora oficial, escrita como «Europe/Madrid». Sirve para que «a las 9:00» signifique las 9:00 de ese lugar, también cuando cambia la hora en verano.',
  },
  workspace: {
    term: 'Espacio de trabajo',
    definition: 'Carpeta aislada (data/workspace) donde los agentes pueden leer y escribir archivos. No pueden salir de ella.',
  },
} satisfies Record<string, GlossaryEntry>;

export type GlossaryId = keyof typeof GLOSSARY;

export const glossaryEntries = (): Array<GlossaryEntry & { id: GlossaryId }> =>
  (Object.entries(GLOSSARY) as Array<[GlossaryId, GlossaryEntry]>)
    .map(([id, e]) => ({ id, ...e }))
    .sort((a, b) => a.term.localeCompare(b.term, 'es'));
