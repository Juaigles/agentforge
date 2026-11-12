// Textos que escribe el servidor y que acaban en la pantalla: errores de validación de formularios, errores de la
// API, motivos de fallo de una ejecución o de un paso, errores de herramientas y de proveedores, y avisos de la
// importación. Cada texto tiene un código y unos parámetros: el servidor guarda y envía el texto en español de
// esta tabla (el respaldo para quien no traduzca) junto con `{ code, params }`, y la interfaz en otro idioma lo
// traduce a partir del código (ver web/src/lib/server-messages-en.ts, que debe tener exactamente estos códigos).
//
// Lo que viene de fuera (la respuesta de un proveedor, de una API o de un servidor MCP, el error de un programa)
// viaja como parámetro y se muestra tal cual dentro de la frase traducida.

/** Valores con los que se rellena un texto ya en su idioma. */
export type TextParams = Record<string, string | number>;

/** Parámetro de un mensaje: un valor, otro mensaje (la causa de un fallo) o una lista de mensajes. */
export type MessageParam = string | number | ServerMessage | ServerMessage[];

/**
 * Referencia a un texto del servidor. `message` es el texto en español: lo llevan los mensajes anidados (el de
 * primer nivel va en el campo de texto de siempre: `error`, `message`, `warnings[i]`…).
 */
export interface ServerMessage {
  code: string;
  params?: Record<string, MessageParam>;
  message?: string;
}

/** Mensaje completo: código, parámetros y texto en español. */
export interface CodedMessage extends ServerMessage {
  code: ServerCode;
  params: Record<string, MessageParam>;
  message: string;
}

/** Lo que puede no encontrarse (`notFound`). */
const NOT_FOUND: Record<string, string> = {
  provider: 'Proveedor no encontrado.',
  agent: 'Agente no encontrado.',
  tool: 'Herramienta no encontrada.',
  mcpServer: 'Servidor MCP no encontrado.',
  file: 'Archivo no encontrado.',
  workflow: 'Workflow no encontrado.',
  trigger: 'Disparador no encontrado.',
  run: 'Ejecución no encontrada.',
  approval: 'Aprobación no encontrada.',
  backup: 'Copia de seguridad no encontrada.',
  route: 'Ruta no encontrada.',
};

/** Campos de una expresión cron. */
const CRON_FIELD: Record<string, string> = {
  minute: 'minuto',
  hour: 'hora',
  dayOfMonth: 'día del mes',
  month: 'mes',
  dayOfWeek: 'día de la semana',
};

/** Límites numéricos de la configuración de un nodo (`nodeConfigRange`). */
const NODE_CONFIG: Record<string, string> = {
  timeoutMs: 'El tiempo máximo (en milisegundos)',
  retries: 'El número de reintentos',
  concurrency: 'El número de elementos a la vez',
  maxItems: 'El máximo de elementos',
};

export const SERVER_MESSAGES = {
  // ---------- Validación de formularios y de parámetros (zod) ----------
  // Genéricos: los que zod detecta sin un mensaje propio del esquema.
  required: () => 'Este dato es obligatorio',
  tooShort: (p) => `Debe tener al menos ${p.min} caracteres`,
  tooLong: (p) => `No puede superar los ${p.max} caracteres`,
  tooSmall: (p) => `Debe ser ${p.min} como mínimo`,
  tooBig: (p) => `Debe ser ${p.max} como máximo`,
  tooFewItems: (p) => `Debe tener al menos ${p.min} elementos`,
  tooManyItems: (p) => `No puede tener más de ${p.max} elementos`,
  invalidType: (p) => `El tipo del dato no es válido (se esperaba ${p.expected})`,
  invalidOption: (p) => `Valor no admitido (los posibles son: ${p.options})`,
  invalidFormat: () => 'El formato no es válido',
  unknownKeys: (p) => `Hay campos que no se reconocen: ${p.keys}`,
  invalidValue: () => 'El valor no es válido',
  // Propios de cada esquema.
  urlRequired: () => 'La URL es obligatoria',
  urlInvalid: () => 'Debe ser una URL http(s) válida',
  nameRequired: () => 'El nombre es obligatorio',
  colorInvalid: () => 'Color hexadecimal no válido',
  providerRequired: () => 'Selecciona un proveedor',
  modelRequired: () => 'Selecciona un modelo',
  enumNeedsScalar: () => 'Solo los parámetros de texto o numéricos admiten valores permitidos',
  enumTypeMismatch: () => 'Los valores permitidos deben ser del tipo del parámetro',
  defaultTypeMismatch: () => 'El valor por defecto debe ser del tipo del parámetro',
  defaultNotInEnum: () => 'El valor por defecto debe ser uno de los valores permitidos',
  toolNameInvalid: () => 'Usa minúsculas, números y guiones bajos (2-49 caracteres, empieza por letra)',
  toolDescriptionRequired: () => 'Describe qué hace la herramienta (el modelo lo usa para decidir)',
  nodeConfigRange: (p) => `${NODE_CONFIG[p.field] ?? p.field} debe ser un número entero entre ${p.min} y ${p.max}`,
  intervalMin: () => 'El intervalo mínimo es 1 minuto',
  intervalMax: () => 'El intervalo máximo son 30 días',
  timeFormat: () => 'La hora debe tener el formato HH:MM',
  intervalRequired: () => 'Indica cada cuántos minutos',
  timeRequired: () => 'Indica la hora',
  timezoneUnknown: (p) => `«${p.timezone}» no es una zona horaria conocida (ejemplo: Europe/Madrid)`,
  cronRequired: () => 'Indica la expresión cron',
  cronNever: () => 'Esa expresión no se cumple nunca (por ejemplo, un 30 de febrero).',
  cronInvalid: () => 'La expresión cron no es válida.',
  cronFieldValue: (p) => `«${p.value}» no es un valor válido para el campo ${CRON_FIELD[p.field] ?? p.field} (${p.min}-${p.max}).`,
  cronEmptyItem: (p) => `El campo ${CRON_FIELD[p.field] ?? p.field} tiene una lista con un elemento vacío.`,
  cronPartInvalid: (p) => `«${p.value}» no es válido en el campo ${CRON_FIELD[p.field] ?? p.field}.`,
  cronStepInvalid: (p) => `El paso «${p.value}» del campo ${CRON_FIELD[p.field] ?? p.field} debe ser un entero mayor que 0.`,
  cronRangeInvalid: (p) => `«${p.value}» no es un rango válido en el campo ${CRON_FIELD[p.field] ?? p.field}.`,
  cronRangeReversed: (p) => `El rango «${p.value}» del campo ${CRON_FIELD[p.field] ?? p.field} está al revés.`,
  cronFieldCount: () => 'La expresión debe tener cinco campos: minuto, hora, día del mes, mes y día de la semana (por ejemplo «0 9 * * 1-5»).',
  tooManyValues: (p) => `Demasiados valores (máximo ${p.max})`,
  mcpNameInvalid: () => 'Usa de 2 a 20 letras minúsculas, números o «_», empezando por una letra',
  mcpCommandRequired: () => 'Indica el programa que arranca el servidor',
  envNameInvalid: (p) => `«${p.name}» no es un nombre de variable de entorno válido`,
  headerInvalid: (p) => `La cabecera «${p.name}» no es válida`,
  bundleVersionUnsupported: () => 'Versión de archivo no admitida: actualiza AgentForge para importarlo',
  notWorkflowBundle: () => 'El archivo no es un workflow exportado de AgentForge',
  bundleNoAgents: () => 'El archivo no trae ningún agente',
  instantInvalid: () => 'debe ser una fecha y hora ISO 8601 con zona horaria (por ejemplo, 2026-01-31T00:00:00Z)',
  statusUnknown: () => 'estado no reconocido',
  kindUnknown: () => 'tipo no reconocido',
  intBetween: (p) => `debe ser un número entero entre ${p.min} y ${p.max}`,
  intAtLeast: (p) => `debe ser un número entero mayor o igual que ${p.min}`,
  approvalDecisionRequired: () => 'Indica si se aprueba o se rechaza',
  commentTooLong: (p) => `El comentario no puede superar los ${p.max} caracteres`,
  // La frase que resume una validación fallida (`detail` es el primer problema).
  invalidData: () => 'Datos no válidos',
  invalidDataDetail: (p) => `Datos no válidos: ${p.detail}`,
  invalidDataField: (p) => `Datos no válidos: ${p.path}: ${p.detail}`,

  // ---------- Errores de la API ----------
  notFound: (p) => NOT_FOUND[p.kind] ?? 'No encontrado.',
  forbiddenHost: () => 'Host no permitido.',
  crossSite: () => 'Petición rechazada: procede de otro sitio web.',
  rateLimited: (p) => `Demasiadas peticiones. Vuelve a intentarlo dentro de ${p.seconds} s.`,
  authRequired: () => 'Hace falta la clave de acceso.',
  invalidToken: () => 'La clave de acceso no es correcta.',
  internalError: () => 'Error interno del servidor.',
  badRequest: () => 'Petición no válida.',
  // Rechazo del propio servidor web (cuerpo que no es JSON, demasiado grande…): `detail` es su texto, en inglés.
  requestRejected: (p) => `${p.detail}`,
  apiKeyRetypeToTest: () => 'Has cambiado la dirección del proveedor: vuelve a escribir la API key para probarla con la nueva dirección.',
  apiKeyRetypeToSave: () => 'Has cambiado la dirección del proveedor: vuelve a escribir la API key (o quítala) antes de guardar.',
  providerMissing: () => 'El proveedor seleccionado no existe.',
  unknownTools: (p) => `Herramientas desconocidas: ${p.names}.`,
  containerUnavailable: (p) => `No se puede usar el contenedor: ${p.detail}`,
  backupContentType: () => 'Envía el archivo de la copia como application/octet-stream.',
  providerInUse: (p) => `No se puede eliminar: ${p.count} agente(s) usan este proveedor.`,
  agentInUse: (p) => `No se puede eliminar: lo usan los workflows ${p.names}.`,
  taskRequired: () => 'Escribe una tarea para el agente.',
  toolNameBuiltin: (p) => `"${p.name}" es el nombre de una herramienta integrada.`,
  toolNameTaken: (p) => `Ya existe una herramienta llamada "${p.name}".`,
  toolCredentialRetype: (p) => `Has cambiado la dirección de la herramienta: vuelve a escribir ${p.headers} (o quita esa cabecera) antes de guardar.`,
  mcpNameTaken: (p) => `Ya existe un servidor MCP llamado «${p.name}».`,
  mcpHeadersRetype: () => 'Has cambiado la dirección del servidor MCP: vuelve a escribir sus cabeceras (o déjalas vacías) antes de guardar.',
  mcpEnvRetype: () => 'Has cambiado el programa del servidor MCP: vuelve a escribir sus variables de entorno (o déjalas vacías) antes de guardar.',
  pathRequired: () => 'Falta el parámetro path.',
  workflowUsedAsSubworkflow: (p) => `No se puede eliminar: lo usan como subworkflow ${p.names}.`,
  notExportBundle: () => 'El archivo no es un workflow ni un agente exportado de AgentForge.',
  tooManyTriggers: (p) => `Un workflow admite como máximo ${p.max} disparadores.`,
  triggerKindChange: () => 'Un webhook no se puede convertir en un disparador con horario, ni al revés. Crea uno nuevo.',
  onlyWebhooksHaveSecret: () => 'Solo los webhooks tienen secreto.',
  webhookUnauthorized: () => 'Webhook desconocido o secreto incorrecto.',
  webhookDisabled: () => 'Este webhook está desactivado.',
  webhookBodyTooLarge: () => 'El cuerpo es demasiado grande (máximo 100 000 caracteres).',
  workflowHasErrors: (p) => `El workflow tiene errores: ${p.detail}`,
  runAlreadyFinished: () => 'La ejecución ya había terminado.',
  runStillActive: () => 'La ejecución todavía está en curso.',
  runCancelFirst: () => 'Cancela la ejecución antes de eliminarla.',
  approvalNotPending: () => 'Esta aprobación ya no está pendiente.',
  providerTimeout: (p) => `El proveedor no respondió en ${p.seconds} segundos.`,
  // Copias de seguridad.
  backupNameInvalid: () => 'Nombre de copia de seguridad no válido.',
  backupEntryCorrupt: () => 'La copia de seguridad está dañada (tamaño de entrada no válido).',
  backupIncomplete: () => 'La copia de seguridad está incompleta.',
  backupExists: () => 'Ya existe una copia con esa fecha y hora. Espera un segundo y vuelve a intentarlo.',
  backupNotOursOrCorrupt: () => 'El archivo no es una copia de seguridad de AgentForge o está dañado.',
  backupNotOurs: () => 'El archivo no es una copia de seguridad de AgentForge.',
  backupTooLarge: () => 'La copia de seguridad es demasiado grande.',
  backupNewerSchema: (p) =>
    `La copia es de una versión más reciente de AgentForge (esquema v${p.version}; esta versión entiende hasta v${p.supported}). Actualiza AgentForge antes de restaurarla.`,
  backupNoDatabase: () => 'La copia de seguridad no contiene la base de datos.',
  backupDatabaseCorrupt: () => 'La base de datos de la copia está dañada.',
  backupDatabaseNewer: () => 'La base de datos de la copia es de una versión más reciente de AgentForge.',
  backupUnreadable: (p) => `No se pudo leer la copia de seguridad: ${p.detail}`,
  // Importación.
  importActionNotPossible: (p) => `«${p.name}»: la acción «${p.action}» no es posible (${p.actions}).`,
  importProviderMissing: (p) => `«${p.name}»: el proveedor elegido no existe.`,
  importFailed: (p) => `No se pudo importar el archivo (no se ha creado nada): ${p.detail}`,
  // Disparadores.
  triggerWorkflowGone: () => 'El workflow ya no existe.',
  triggerLaunchFailed: (p) => `No se pudo lanzar: ${p.detail}`,
  triggerScheduleInvalid: (p) => `El horario no es válido: ${p.detail}`,
  triggerMissedDown: () => 'Se omitió una ejecución porque AgentForge no estaba en marcha a su hora.',
  triggerMissedOverlap: () => 'Se omitió una ejecución porque la anterior seguía en curso.',

  // ---------- Motivo de fallo de una ejecución o de un paso ----------
  runCancelledByUser: () => 'Ejecución cancelada por el usuario.',
  runCancelledBeforeStart: () => 'Ejecución cancelada antes de empezar.',
  runInterruptedByRestart: () => 'Ejecución interrumpida por un reinicio del servidor.',
  runInterruptedByShutdown: () => 'Ejecución interrumpida por el apagado del servidor.',
  runMaxDuration: (p) => `Se superó la duración máxima de la ejecución (${p.seconds} s).`,
  runNodeFailed: (p) => `El nodo "${p.name}" falló: ${p.cause}`,
  runNoOutput: () => 'Ningún nodo de salida llegó a ejecutarse.',
  runCycle: () => 'El workflow contiene un ciclo.',
  engineInternal: (p) => `Error interno del motor: ${p.detail}`,
  nodeInternal: (p) => `Error interno al ejecutar el nodo: ${p.detail}`,
  nodeTimeout: (p) => `El nodo superó su tiempo máximo (${p.ms} ms).`,
  skipDependencyFailed: () => 'Una dependencia ha fallado.',
  skipBranchNotTaken: () => 'Rama no tomada.',
  subworkflowStartFailed: () => 'No se pudo iniciar el subworkflow.',
  subworkflowTooDeep: (p) => `Se han anidado más de ${p.max} niveles de workflows.`,
  subworkflowMissing: () => 'El subworkflow ya no existe (no estaba disponible al lanzar la ejecución).',
  subworkflowUnavailable: () => 'Los subworkflows no están disponibles en este contexto.',
  subworkflowFailed: () => 'El subworkflow no terminó correctamente.',
  approvalsUnavailable: () => 'Las aprobaciones no están disponibles en este contexto.',
  approvalNoQuestion: (p) => `La aprobación "${p.name}" no tiene nada que preguntar.`,
  nodeNoAgent: (p) => `El nodo "${p.name}" no tiene un agente válido.`,
  nodeEmptyPrompt: (p) => `El nodo "${p.name}" generó un prompt vacío.`,
  nodeUnknownType: (p) => `Tipo de nodo desconocido: ${p.type}`,
  conditionNeedsNumbers: (p) => `La condición numérica necesita números; se recibió "${p.left}" y "${p.right}".`,
  conditionUnknownOperator: (p) => `Operador de condición desconocido: ${p.operator}`,
  foreachTooManyItems: (p) => `"${p.name}" recibió ${p.count} elementos y su máximo es ${p.max}. Reduce la lista o sube el límite del nodo.`,
  foreachEmptyTask: (p) => `El nodo "${p.name}" generó una tarea vacía para el elemento ${p.index}.`,
  foreachItemFailed: (p) => `Elemento ${p.index} de ${p.total} («${p.item}»): ${p.cause}`,
  foreachAllFailed: (p) => `Han fallado los ${p.total} elementos de "${p.name}". El primero: ${p.cause}`,
  regexTooLong: (p) => `La expresión regular es demasiado larga (máximo ${p.max} caracteres).`,
  regexInvalid: (p) => `Expresión regular no válida: ${p.detail}`,
  regexTimeout: (p) =>
    `La expresión regular «${p.pattern}» tardó más de ${p.ms} ms en evaluarse y se ha detenido. Simplifícala (evita cuantificadores anidados como (a+)+).`,
  regexFailed: (p) => `No se pudo evaluar la expresión regular: ${p.detail}`,
  // Configuración de agentes y proveedores.
  apiKeyUndecryptable: (p) => `No se pudo descifrar la API key de «${p.name}». Vuelve a introducirla en Ajustes → Proveedores.`,
  agentProviderGone: (p) => `El agente «${p.name}» usa un proveedor que ya no existe.`,
  providerDisabled: (p) => `El proveedor «${p.name}» está desactivado.`,
  agentNoModel: (p) => `El agente «${p.name}» no tiene modelo configurado.`,
  providerKindUnsupported: (p) => `Tipo de proveedor no soportado: ${p.kind}`,
  llmCallLimit: (p) => `Se alcanzó el límite de ${p.max} llamadas al modelo para esta ejecución.`,
  // Proveedores de modelos.
  llmEmptyAnswer: (p) => `El modelo ${p.model} devolvió una respuesta vacía.`,
  llmUnreachable: (p) => `No se pudo conectar con ${p.label} (${p.origin}). ¿Está en marcha?`,
  llmRedirect: (p) => `${p.label} respondió con una redirección (${p.status}), que no se sigue. Revisa la dirección del proveedor.`,
  llmHttpError: (p) => `${p.label} respondió ${p.status}: ${p.detail}`,
  ollamaNoBody: () => 'Ollama devolvió una respuesta sin cuerpo.',
  ollamaError: (p) => `Ollama: ${p.detail}`,
  ollamaCutOff: () => 'La respuesta de Ollama se cortó antes de terminar.',
  providerNoBody: () => 'El proveedor devolvió una respuesta sin cuerpo.',
  providerError: (p) => `El proveedor devolvió un error: ${p.detail}`,
  providerNoData: () => 'El proveedor no devolvió ningún dato.',
  providerCutOff: () => 'La respuesta del proveedor se cortó antes de terminar.',

  // ---------- Errores de herramientas ----------
  toolNotAvailable: (p) => `Herramienta desconocida o desactivada: ${p.name}`,
  toolArgsNotObject: () => 'Los argumentos deben ser un objeto JSON.',
  toolArgsInvalid: (p) => `Argumentos no válidos: ${p.problems}.`,
  argMissing: (p) => `falta el parámetro obligatorio "${p.name}"`,
  argNotNumber: (p) => `"${p.name}" debe ser un número`,
  argNotInteger: (p) => `"${p.name}" debe ser un número entero`,
  argNotBoolean: (p) => `"${p.name}" debe ser true o false`,
  argNotJson: (p) => `"${p.name}" debe ser JSON válido`,
  argWrongType: (p) => `"${p.name}" debe ser de tipo ${p.type}`,
  argNotInEnum: (p) => `"${p.name}" debe ser uno de: ${p.options}`,
  toolApiError: (p) => `La API respondió ${p.status}: ${p.detail}`,
  workspaceOutside: (p) => `Ruta fuera del espacio de trabajo: ${p.path}`,
  timezoneInvalid: (p) => `Zona horaria no válida: ${p.timezone}`,
  pageHttpError: (p) => `La página respondió ${p.status} ${p.statusText}.`,
  writeTooLarge: () => 'El contenido supera el límite de 1 MB.',
  fileTooLarge: (p) => `El archivo superaría el límite de ${p.mb} MB por archivo. Escribe en otro archivo o sobrescribe este.`,
  workspaceFull: (p) => `El espacio de trabajo ha alcanzado su límite de ${p.mb} MB. Borra archivos desde Herramientas → Archivos.`,
  fileMissing: (p) => `El archivo no existe: ${p.path}`,
  notAFile: (p) => `No es un archivo: ${p.path}`,
  memoryFull: () => 'La memoria compartida está llena (200 entradas).',
  delegateUnavailable: () => 'La delegación solo está disponible durante la ejecución de un agente.',
  codeDisabled: () => 'La ejecución de código está desactivada. Puede habilitarse en Ajustes → "Permitir ejecución de código".',
  // Calculadora.
  calcBadChar: (p) => `Carácter no válido en la expresión, posición ${p.position}: "${p.text}"`,
  calcTooLong: () => 'La expresión es demasiado larga.',
  calcExpected: (p) => `Se esperaba "${p.symbol}" en la expresión.`,
  calcDivisionByZero: () => 'División entre cero.',
  calcIncomplete: () => 'Expresión incompleta.',
  calcUnknownFunction: (p) => `Función desconocida: ${p.name}`,
  calcUnknownIdentifier: (p) => `Identificador desconocido: ${p.name}`,
  calcUnexpected: (p) => `Símbolo inesperado: ${p.symbol}`,
  calcEmpty: () => 'La expresión está vacía.',
  calcNotFinite: () => 'El resultado no es un número finito.',
  // Red.
  urlNotValid: (p) => `URL no válida: ${p.url}`,
  protocolNotAllowed: (p) => `Protocolo no permitido: ${p.protocol} (solo http y https).`,
  hostUnresolved: (p) => `No se pudo resolver el host: ${p.host}`,
  privateNetworkBlocked: (p) => `Acceso bloqueado a red privada o local (${p.host}). Puede habilitarse en Ajustes → "Permitir redes privadas".`,
  ownApiBlocked: (p) => `Acceso bloqueado: las herramientas no pueden llamar a la propia API de AgentForge (${p.host}).`,
  requestTimeout: (p) => `La petición a ${p.host} superó el tiempo de espera.`,
  networkConnectFailed: (p) => `Fallo de red al conectar con ${p.host}: ${p.detail}`,
  networkReadFailed: (p) => `Fallo de red al leer la respuesta de ${p.host}: ${p.detail}`,
  redirectDowngrade: (p) => `Redirección rechazada: ${p.host} redirige de https a http (${p.target}).`,
  tooManyRedirects: () => 'Demasiadas redirecciones.',
  // Ejecución de código.
  codeTooLong: (p) => `El código es demasiado largo (máximo ${p.max} caracteres).`,
  codeTimeout: (p) => `El código superó el tiempo máximo (${p.ms} ms).`,
  codeOutputTooLarge: () => 'El resultado del código es demasiado grande.',
  sandboxStartFailed: (p) => `No se pudo iniciar el entorno aislado: ${p.detail}`,
  codeOutOfMemory: (p) => `El código superó el límite de memoria (${p.mb} MB).`,
  codeNoResult: () => 'El código terminó sin devolver resultado (¿límite de memoria?).',
  codeError: (p) => `Error al ejecutar el código: ${p.detail}`,
  codePendingPromise: () => 'El código devolvió una promesa que no llega a resolverse (no hay temporizadores ni red).',
  containerEngineDown: (p) => `${p.engine} está instalado pero su servicio no responde. Arráncalo e inténtalo de nuevo.`,
  containerEngineMissing: () => 'No se ha encontrado Docker ni Podman en este equipo.',
  containerEngineNotLinux: (p) =>
    `${p.engine} está en marcha pero ejecuta contenedores de ${p.os}, y el entorno aislado necesita contenedores de Linux. Cámbialo a contenedores de Linux.`,
  containerImageMissing: (p) => `Falta la imagen ${p.image}. Descárgala una vez con: ${p.engine} pull ${p.image}`,
  sandboxImageMissing: (p) => `Falta la imagen ${p.image} del entorno aislado. Descárgala una vez con: ${p.engine} pull ${p.image}`,
  containerStartFailed: (p) => `El contenedor no pudo arrancar: ${p.detail}`,
  containerSandboxUnavailable: (p) => `El entorno aislado en contenedor no está disponible: ${p.detail} Puedes volver al aislamiento por proceso en Ajustes.`,
  // Servidores MCP.
  mcpUnavailable: (p) => `El servidor MCP «${p.name}» ya no está disponible.`,
  mcpConnectFailed: (p) => `No se pudo conectar con el servidor MCP «${p.name}»: ${p.detail}`,
  mcpCallFailed: (p) => `El servidor MCP «${p.name}» falló: ${p.detail}`,
  mcpToolError: (p) => `${p.detail}`,
  mcpToolErrorNoDetail: () => 'La herramienta devolvió un error sin detalle.',
  mcpUnknownError: () => 'error desconocido',
  mcpConnectionLost: () => 'Se perdió la conexión. Se volverá a intentar cuando un agente use una de sus herramientas.',
  mcpNoResponse: (p) => `No respondió en ${p.seconds} s.`,

  // ---------- Plan y resultado de una importación ----------
  importProviderUrlDiffers: (p) => `Aquí «${p.name}» apunta a ${p.localUrl}; en el archivo, a ${p.fileUrl}.`,
  importProviderSameKind: (p) => `No existe aquí. Sus agentes usarán «${p.name}», que es del mismo tipo, salvo que elijas crearlo.`,
  importProviderNoKey: () => 'Se creará sin clave de API: añádela en Ajustes antes de ejecutar sus agentes.',
  importProviderCreated: (p) => `Se creará apuntando a ${p.url}.`,
  importToolDiffers: () => 'Ya existe una herramienta con ese nombre y es distinta. Se usará la de aquí salvo que elijas sustituirla.',
  importToolHostDiffers: (p) => `Aquí hace peticiones a ${p.localHost}; la del archivo, a ${p.fileHost}.`,
  importToolOrphanedCredential: (p) =>
    `Si la sustituyes, la credencial guardada aquí (${p.headers}) no se enviará a la nueva dirección: quedará sin valor hasta que la escribas de nuevo.`,
  importToolReserved: () => 'Aquí ese nombre es de una herramienta integrada o de un servidor MCP: no se importa y se usará la de aquí.',
  importToolRequests: (p) => `Hace peticiones ${p.method} a ${p.host}.`,
  importToolNeedsCredentials: (p) => `Lleva credenciales que no viajan en el archivo: habrá que escribir ${p.headers} al editarla.`,
  importAgentDiffers: () =>
    'Ya existe un agente con ese nombre y su configuración es distinta. Se usará el de aquí salvo que elijas sustituirlo o crear una copia.',
  importAgentNoProvider: () => 'No hay ningún proveedor configurado: no se podrá crear.',
  importWorkflowDiffers: () => 'Ya existe un workflow con ese nombre y es distinto: se creará una copia salvo que elijas usar el de aquí.',
  importWarnSensitive: (p) =>
    `Este archivo usa herramientas que actúan fuera de la conversación (${p.tools}). Revisa los agentes antes de ejecutarlo si no conoces su origen.`,
  importWarnMcp: (p) =>
    `Este archivo usa herramientas de tus servidores MCP (${p.tools}): son programas y servicios tuyos, que actúan con tus permisos. Revisa qué les pide antes de ejecutarlo.`,
  importWarnCredentials: (p) =>
    `Este archivo usa herramientas tuyas que llevan credenciales guardadas (${p.tools}): sus peticiones se harán con tus credenciales.`,
  importWarnDelegate: () =>
    'Sus agentes pueden delegar tareas (delegate_task) en cualquier agente de esta instalación, con las herramientas que ese agente tenga.',
  importWarnToolNode: (p) => `El nodo «${p.node}» de «${p.workflow}» llama a ${p.tool} con estos argumentos: ${p.args}`,
  importWarnMoreToolNodes: (p) => `Otros ${p.count} nodos llaman también a herramientas con argumentos fijos: revísalos en el constructor.`,
  importWarnTriggers: (p) => `Trae ${p.count === 1 ? 'un disparador, que se creará' : `${p.count} disparadores, que se crearán`} en pausa.`,
  importedProviderNoKey: (p) => `El proveedor «${p.name}» se ha creado sin clave de API: añádela en Ajustes.`,
  importedToolCredentialDropped: (p) =>
    `La herramienta «${p.name}» apunta ahora a ${p.host}: la credencial que tenías guardada (${p.headers}) no se ha conservado.`,
  importedToolNeedsCredentials: (p) => `La herramienta «${p.name}» lleva credenciales que no viajan en el archivo: escribe ${p.headers} al editarla.`,
  importedAgentNoProvider: (p) => `No se pudo crear el agente «${p.name}»: no hay ningún proveedor configurado.`,
  importedAgentMissingTools: (p) => `El agente «${p.name}» usaba herramientas que no existen aquí: ${p.tools}.`,
  importedAgentNoModel: (p) => `El agente «${p.name}» no tiene modelo: asígnale uno antes de ejecutarlo.`,
  importedWebhookSecrets: () => 'Los webhooks importados tienen un secreto nuevo: genera uno desde sus disparadores para poder usarlos.',

  // ---------- Cualquier otro error (sin texto propio): se muestra tal cual ----------
  unexpected: (p) => `${p.detail}`,
} satisfies Record<string, (p: TextParams) => string>;

export type ServerCode = keyof typeof SERVER_MESSAGES;

/** Separador de una lista de mensajes dentro de otro. */
const LIST_SEPARATOR = '; ';

/**
 * Rellena un texto: los parámetros que son otros mensajes se sustituyen por el texto que devuelve `render`
 * (en español, su `message`; en otro idioma, su traducción).
 */
export function flattenParams(params: Record<string, MessageParam> | undefined, render: (nested: ServerMessage) => string): TextParams {
  const out: TextParams = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    out[key] = Array.isArray(value) ? value.map(render).join(LIST_SEPARATOR) : typeof value === 'object' && value !== null ? render(value) : value;
  }
  return out;
}

/** Mensaje del servidor: su código, sus parámetros y el texto en español. */
export function msg(code: ServerCode, params: Record<string, MessageParam> = {}): CodedMessage {
  return { code, params, message: SERVER_MESSAGES[code](flattenParams(params, (nested) => nested.message ?? '')) };
}

/** La referencia que se guarda o se envía junto al texto: código y parámetros, sin repetir el texto de primer nivel. */
export function refOf(coded: ServerMessage): ServerMessage {
  return coded.params && Object.keys(coded.params).length ? { code: coded.code, params: coded.params } : { code: coded.code };
}
