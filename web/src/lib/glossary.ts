// Glosario: única fuente de verdad de las definiciones que muestran los tooltips (<Term>) y la página Glosario.
// `GLOSSARY` (español) fija los ids; `GLOSSARY_EN` es su versión inglesa y debe tener exactamente las mismas claves.
import { locale } from '@/i18n';

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

/** Versión inglesa del glosario: mismas claves que `GLOSSARY` (si falta una, TypeScript lo señala). */
export const GLOSSARY_EN: Record<GlossaryId, GlossaryEntry> = {
  agente: {
    term: 'Agent',
    definition: 'A language model with a role, instructions and tools. Like an employee with a job title and a toolbox.',
  },
  api: {
    term: 'API',
    definition: 'A door that one program offers to other programs: you send it a request and it returns data, with no screens involved.',
  },
  aprobacion: {
    term: 'Approval',
    definition: 'A point in a workflow where the run stops until a person approves or rejects. Depending on the decision, it continues down one branch or the other.',
  },
  'api-key': {
    term: 'API key',
    definition: 'A password that identifies your account to a service. AgentForge stores it encrypted and never shows it again.',
  },
  'base-url': {
    term: 'Base URL',
    definition: "The root address of the provider's server, for example http://localhost:11434 for Ollama on your machine.",
  },
  'base-datos': {
    term: 'Database',
    definition: 'File where AgentForge stores agents, workflows and runs (SQLite, in the data folder). It survives restarts.',
  },
  cabecera: {
    term: 'Header',
    definition: 'An extra piece of data that goes with an HTTP request, such as the credential (Authorization) or the content format.',
  },
  capacidades: {
    term: 'Capabilities',
    definition: 'What a model can do besides chatting: use tools, reason (thinking), see images (vision)…',
  },
  'clave-acceso': {
    term: 'Access key',
    definition: 'The password the AgentForge server asks for when it can be reached from other machines. Whoever starts it sets it.',
  },
  cifrado: {
    term: 'Encryption',
    definition: 'Transforming data with a key so it is unreadable without it. API keys are stored this way on disk.',
  },
  cola: {
    term: 'Queue',
    definition: 'A waiting line: when the maximum number of simultaneous runs is reached, new ones wait here for their turn.',
  },
  'copia-seguridad': {
    term: 'Backup',
    definition: 'A single file with everything AgentForge stores: agents, workflows, history, encrypted keys and files. Use it to roll back or move to another machine.',
  },
  contenedor: {
    term: 'Container',
    definition: 'A sealed box created by Docker or Podman to run a program apart from the rest of the machine: no network, none of your files and limited memory.',
  },
  condicion: {
    term: 'Condition',
    definition: 'A node that compares a text with a value and follows the “yes” branch or the “no” branch. The other branch is skipped.',
  },
  concurrencia: {
    term: 'Concurrency',
    definition: 'How many things happen at once. With concurrency 2, two agents work in parallel and the rest wait their turn.',
  },
  cron: {
    term: 'Cron',
    definition: 'A compact way to write a schedule with five fields: minute, hour, day of month, month and day of week. “0 9 * * 1-5” means Monday to Friday at 9:00.',
  },
  dag: {
    term: 'DAG',
    definition: 'Directed acyclic graph: the arrows never loop back to an earlier node, so there is always a valid order of execution.',
  },
  delegacion: {
    term: 'Delegation',
    definition: 'One agent hands a subtask to another agent and waits for its answer, like a boss assigning work.',
  },
  disparador: {
    term: 'Trigger',
    definition: 'What launches a workflow without anyone pressing “Run”: a schedule (at intervals, certain days at a time, a cron) or a call from another program (webhook).',
  },
  ejecucion: {
    term: 'Run',
    definition: 'Each time an agent or a workflow is started. It is saved with its steps, results and events.',
  },
  herramienta: {
    term: 'Tool',
    definition: 'A function the agent can call to do something real: calculate, read a web page, write a file or call an API.',
  },
  http: {
    term: 'HTTP',
    definition: 'The protocol programs use to request and send data over the web. An HTTP tool calls an address and gets a response.',
  },
  instantanea: {
    term: 'Snapshot',
    definition: 'A copy of the workflow and its agents as they were when the run started. Editing them later does not change the history.',
  },
  iteraciones: {
    term: 'Iterations',
    definition: 'The model → tools → model loops an agent can take in a task. When they run out, it must answer with what it has.',
  },
  json: {
    term: 'JSON',
    definition: 'A text format for structured data, with braces and quotes: {"city": "Madrid"}.',
  },
  'json-schema': {
    term: 'Parameter schema',
    definition: 'A description of the data a tool accepts: name, type and whether each is required. The model reads it to know how to call the tool.',
  },
  llm: {
    term: 'LLM',
    definition: 'Large language model: the AI program that reads text and generates the answer. It is the “brain” of each agent.',
  },
  mcp: {
    term: 'MCP',
    definition: 'Model Context Protocol: a standard for an external program to offer tools to agents. Connect an MCP server and its tools appear alongside the others.',
  },
  'memoria-compartida': {
    term: 'Shared memory',
    definition: 'A common whiteboard for a run: one agent notes down a piece of data and the other agents in the same workflow can read it.',
  },
  'metodo-http': {
    term: 'HTTP method',
    definition: 'The type of request: GET asks for data, POST sends it, PUT and PATCH modify it and DELETE removes it.',
  },
  modelo: {
    term: 'Model',
    definition: 'The specific AI version the agent uses, for example qwen3:8b. Larger ones reason better; smaller ones answer sooner.',
  },
  nodo: {
    term: 'Node',
    definition: 'Each box in the workflow: an input, an agent, a tool, a condition, a transformation or an output.',
  },
  nodejs: {
    term: 'Node.js',
    definition: 'The environment that runs the AgentForge server on your machine. Its version matters if something breaks after updating it.',
  },
  ollama: {
    term: 'Ollama',
    definition: 'A free program that runs AI models on your own computer, without sending data to any external service.',
  },
  'openai-compatible': {
    term: 'OpenAI-compatible',
    definition: 'A service that speaks the same “language” as the OpenAI API (OpenRouter, Groq, LM Studio…), so it connects the same way.',
  },
  'para-cada': {
    term: 'For each',
    definition: 'A node that repeats the same task for each item in a list (several at a time) and gathers all the results.',
  },
  paralelo: {
    term: 'In parallel',
    definition: 'Several steps that do not depend on each other run at the same time instead of one after another, so the workflow finishes sooner.',
  },
  plantilla: {
    term: 'Template',
    definition: 'Text with gaps in double braces, like {{input}}, that are filled in with real results at run time.',
  },
  prompt: {
    term: 'Prompt',
    definition: 'The instruction text sent to the model. The quality of the answer depends largely on how clear it is.',
  },
  'prompt-sistema': {
    term: 'System instructions',
    definition: 'Fixed text that defines how the agent should behave in all its tasks: tone, format and limits.',
  },
  proveedor: {
    term: 'Provider',
    definition: 'A service that runs the models: Ollama on your machine or a remote OpenAI-compatible API.',
  },
  razonamiento: {
    term: 'Reasoning',
    definition: 'A mode in which the model “thinks quietly” before answering. It helps with hard problems, but takes longer and uses more.',
  },
  'red-privada': {
    term: 'Private network',
    definition: 'Internal addresses (localhost, 192.168.x.x…). Blocked by default so an agent cannot reach services on your network.',
  },
  reintento: {
    term: 'Retry',
    definition: 'Running a step again after it failed because of a temporary error, waiting a bit longer between attempts each time.',
  },
  sandbox: {
    term: 'Sandbox',
    definition: 'A closed space where code runs without access to your files or the network, to limit the damage of a mistake.',
  },
  streaming: {
    term: 'Streaming',
    definition: 'The answer arrives word by word as the model generates it, instead of waiting for the full text.',
  },
  subworkflow: {
    term: 'Subworkflow',
    definition: 'A workflow that another one uses as if it were a single step: it gets an input and returns its result. Useful for reusing multi-node flows.',
  },
  temperatura: {
    term: 'Temperature',
    definition: 'How random the model is. Near 0 it answers consistently and precisely; high values make it more creative and variable.',
  },
  timeout: {
    term: 'Timeout',
    definition: 'A waiting limit. If a step takes longer, it is cut off and counts as a failure, so nothing hangs forever.',
  },
  tokens: {
    term: 'Tokens',
    definition: 'Pieces of words the model uses to measure text. About 100 words of English come to roughly 130 tokens.',
  },
  url: {
    term: 'URL',
    definition: 'The full web address of a resource, for example https://api.example.com/weather?city=Madrid.',
  },
  webhook: {
    term: 'Webhook',
    definition: 'A web address that another program sends a request to, to signal something. Here, each call with the right secret launches the workflow with the request body as input.',
  },
  workflow: {
    term: 'Workflow',
    definition: 'A diagram of connected steps that coordinates several agents and tools to solve a task.',
  },
  'zona-horaria': {
    term: 'Time zone',
    definition: 'A region with the same official time, written like “Europe/Madrid”. It makes “at 9:00” mean 9:00 in that place, even when daylight saving time changes.',
  },
  workspace: {
    term: 'Workspace',
    definition: 'An isolated folder (data/workspace) where agents can read and write files. They cannot leave it.',
  },
};

const BY_LOCALE: Record<'es' | 'en', Record<GlossaryId, GlossaryEntry>> = { es: GLOSSARY, en: GLOSSARY_EN };

/** Entrada del glosario en el idioma actual (reactiva: depende de `locale`). */
export const glossaryEntry = (id: GlossaryId): GlossaryEntry => BY_LOCALE[locale.value][id];

/** Todas las entradas en el idioma actual, ordenadas alfabéticamente según ese idioma. */
export const glossaryEntries = (): Array<GlossaryEntry & { id: GlossaryId }> => {
  const lang = locale.value;
  return (Object.keys(GLOSSARY) as GlossaryId[]).map((id) => ({ id, ...BY_LOCALE[lang][id] })).sort((a, b) => a.term.localeCompare(b.term, lang));
};
