// Especificación OpenAPI 3.1 de la API HTTP de AgentForge.
//
// El documento se escribe como datos TypeScript normales, con ayudantes pequeños para no repetir. Los cuerpos de
// entrada se generan a partir de los esquemas zod reales (`routes/schemas.ts`), de modo que los campos, los
// obligatorios y los límites son exactamente los que valida el servidor. Los objetos que devuelve la API se
// describen a mano a partir de `shared/types.ts`.
//
// `server/test/openapi.test.ts` compara este documento con las rutas realmente registradas en Fastify y con
// respuestas reales: si se añade una ruta o cambia una forma de respuesta, el test avisa.
import { z } from 'zod';
import { VALIDATION_MESSAGES } from '../../shared/validation-messages';
import {
  agentImportSchema,
  agentSchema,
  approvalDecisionSchema,
  customToolSchema,
  importDecisionsSchema,
  invokeToolSchema,
  mcpServerSchema,
  providerProbeSchema,
  providerSchema,
  retrySchema,
  runIdsSchema,
  runInputSchema,
  settingsSchema,
  triggerSchema,
  workflowImportSchema,
  workflowSchema,
} from './routes/schemas';

type Schema = Record<string, unknown>;
type Method = 'get' | 'post' | 'put' | 'delete';

// ---------- Ayudantes de esquemas ----------
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const withText = (schema: Schema, description?: string): Schema => (description ? { ...schema, description } : schema);
const str = (description?: string, extra: Schema = {}): Schema => withText({ type: 'string', ...extra }, description);
const int = (description?: string, extra: Schema = {}): Schema => withText({ type: 'integer', ...extra }, description);
const num = (description?: string, extra: Schema = {}): Schema => withText({ type: 'number', ...extra }, description);
const bool = (description?: string): Schema => withText({ type: 'boolean' }, description);
const dateTime = (description?: string): Schema => str(description, { format: 'date-time' });
const enumOf = (values: readonly (string | number)[], description?: string): Schema =>
  withText({ type: typeof values[0] === 'number' ? 'number' : 'string', enum: [...values] }, description);
const array = (items: Schema, description?: string): Schema => withText({ type: 'array', items }, description);
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
const dict = (values: Schema, description?: string): Schema => withText({ type: 'object', additionalProperties: values }, description);
const anyObject = (description?: string): Schema => withText({ type: 'object', additionalProperties: true }, description);

/** Objeto con todas las propiedades obligatorias salvo las de `optional`. */
function obj(properties: Record<string, Schema>, opts: { optional?: string[]; description?: string } = {}): Schema {
  const optional = new Set(opts.optional ?? []);
  const required = Object.keys(properties).filter((key) => !optional.has(key));
  return withText({ type: 'object', properties, ...(required.length ? { required } : {}) }, opts.description);
}

/**
 * Esquema JSON de un esquema zod de entrada (`io: 'input'`: los campos con valor por defecto son opcionales).
 * `fieldDocs` añade la descripción en español de los campos de primer nivel.
 */
function fromZod(schema: z.ZodType, description: string, fieldDocs: Record<string, string> = {}): Schema {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Schema;
  delete json.$schema;
  const properties = (json.properties ?? {}) as Record<string, Schema>;
  for (const [field, text] of Object.entries(fieldDocs)) {
    if (properties[field]) properties[field] = { ...properties[field], description: text };
  }
  return { ...json, description };
}

// ---------- Errores ----------
/** Código estable de cada error (campo `code`) y cuándo aparece. */
const ERROR_CODES: Record<string, string> = {
  validation: 'El cuerpo o los parámetros no cumplen el esquema (400). Trae `issues` con el campo y el motivo.',
  not_found: 'El recurso no existe (404).',
  bad_request: 'Petición no válida por otro motivo: conflicto con el estado actual, formato no admitido, etc. (400, 409, 415, 422…).',
  auth_required: 'Falta la clave de acceso o la sesión ha caducado (401). La interfaz muestra entonces la pantalla de entrada.',
  invalid_token: 'La clave enviada al iniciar sesión no es correcta (401).',
  forbidden_host: 'La petición llega por un nombre de servidor que no está admitido (403). Ver `AGENTFORGE_ALLOWED_HOSTS`.',
  cross_site: 'La petición procede de otro sitio web (403).',
  api_key_required: 'Se ha cambiado la dirección de un proveedor y hay que volver a escribir su API key (400).',
  rate_limited: 'Se ha superado el límite de peticiones (429). La cabecera `Retry-After` indica los segundos de espera.',
  payload_too_large: 'El cuerpo de la petición supera el tamaño máximo (413).',
  provider_error: 'El proveedor de modelos (Ollama, OpenAI…) ha fallado o no responde (502).',
  tool_error: 'Una herramienta ha rechazado sus argumentos (400).',
  config_error: 'Configuración que el usuario puede arreglar: clave que no se descifra, proveedor desactivado… (409).',
  internal: 'Error interno del servidor (500 o superior). El mensaje es genérico; el detalle queda en el registro del servidor.',
};

const STATUS_TEXT: Record<number, string> = {
  400: 'Datos no válidos (`validation`), petición mal formada (`bad_request`) o argumentos rechazados (`tool_error`).',
  401: 'Hace falta la clave de acceso (`auth_required`). Solo ocurre si el servidor tiene una clave configurada.',
  404: 'El recurso no existe (`not_found`).',
  409: 'Conflicto con el estado actual (`bad_request`) o configuración por arreglar (`config_error`).',
  413: 'El cuerpo es demasiado grande (`payload_too_large`).',
  415: 'Tipo de contenido no admitido (`bad_request`).',
  422: 'La petición es válida pero no se puede atender, p. ej. un workflow con errores (`bad_request`).',
  429: 'Demasiadas peticiones (`rate_limited`). Espera los segundos de `Retry-After`.',
  502: 'El proveedor de modelos ha fallado (`provider_error`).',
  503: 'El servidor no está listo.',
};

const errorResponse = (status: number): Schema => ({
  description: STATUS_TEXT[status] ?? 'Error.',
  content: { 'application/json': { schema: ref('Error') } },
  ...(status === 429 ? { headers: { 'Retry-After': { description: 'Segundos que hay que esperar.', schema: { type: 'integer' } } } } : {}),
});

/** Respuestas de error de una operación, todas con el esquema `Error`: `errorResponses(404, 409)`. */
const errorResponses = (...statuses: number[]): Record<string, Schema> => Object.fromEntries(statuses.map((status) => [String(status), errorResponse(status)]));

// ---------- Operaciones ----------
interface Param {
  name: string;
  in: 'query' | 'header';
  description: string;
  schema: Schema;
  required?: boolean;
}

interface OpSpec {
  tag: string;
  id: string;
  summary: string;
  description?: string;
  query?: Param[];
  /** Cuerpo JSON: esquema o referencia. */
  body?: Schema;
  bodyRequired?: boolean;
  /** Cuerpo que no es JSON (`content` completo). */
  bodyContent?: Schema;
  /** Código de éxito (por defecto, 200) y esquema JSON de la respuesta. */
  ok?: number;
  response?: Schema;
  okDescription?: string;
  /** Contenido de la respuesta de éxito cuando no es JSON (SSE, descargas). */
  okContent?: Schema;
  /** Otras respuestas con esquema propio, p. ej. 503 en la sonda de disponibilidad. */
  extra?: Record<string, Schema>;
  errors?: number[];
  /** `public`: no exige clave de acceso. `webhook`: se autentica con el secreto del disparador. */
  access?: 'public' | 'webhook';
}

const OK_TEXT: Record<number, string> = {
  200: 'Correcto.',
  201: 'Creado.',
  202: 'Aceptado: el trabajo sigue en segundo plano.',
  204: 'Correcto, sin contenido.',
};

const PATH_PARAM_DOCS: Array<[RegExp, string]> = [
  [/^\/api\/agents\/\{id\}/, 'Identificador del agente.'],
  [/^\/api\/providers\/\{id\}/, 'Identificador del proveedor.'],
  [/^\/api\/tools\/custom\/\{id\}/, 'Identificador de la herramienta personalizada.'],
  [/^\/api\/mcp\/servers\/\{id\}/, 'Identificador del servidor MCP.'],
  [/^\/api\/workflows\/\{id\}/, 'Identificador del workflow.'],
  [/^\/api\/triggers\/\{id\}/, 'Identificador del disparador.'],
  [/^\/api\/hooks\/\{id\}/, 'Identificador del disparador de tipo webhook.'],
  [/^\/api\/runs\/\{id\}/, 'Identificador de la ejecución.'],
  [/^\/api\/approvals\/\{id\}/, 'Identificador de la aprobación.'],
  [/^\/api\/backups\/\{name\}/, 'Nombre del archivo de la copia, p. ej. `agentforge-20260101-120000.afbackup`.'],
  [/^\/api\/tools\/\{name\}/, 'Nombre de la herramienta (integrada, personalizada o de un servidor MCP).'],
  [/\{nodeId\}/, 'Identificador del nodo del workflow.'],
];

function pathParams(path: string): Schema[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => {
    // Cada parámetro se describe con la primera regla que reconoce su ruta; `nodeId` solo con la suya.
    const rule = PATH_PARAM_DOCS.find(([re]) => (name === 'nodeId' ? re.source.includes('nodeId') : !re.source.includes('nodeId') && re.test(path)));
    return { name, in: 'path', required: true, description: rule?.[1] ?? 'Identificador.', schema: { type: 'string' } };
  });
}

function operation(path: string, spec: OpSpec): Schema {
  const ok = spec.ok ?? 200;
  const okResponse: Schema = { description: spec.okDescription ?? OK_TEXT[ok] ?? 'Correcto.' };
  if (spec.okContent) okResponse.content = spec.okContent;
  else if (spec.response) okResponse.content = { 'application/json': { schema: spec.response } };

  const errors = new Set(spec.errors ?? []);
  if (spec.access !== 'public' && spec.access !== 'webhook') errors.add(401);
  errors.add(429);

  const parameters = [...pathParams(path), ...(spec.query ?? [])];
  const result: Schema = {
    tags: [spec.tag],
    operationId: spec.id,
    summary: spec.summary,
    ...(spec.description ? { description: spec.description } : {}),
    ...(parameters.length ? { parameters } : {}),
    responses: { [String(ok)]: okResponse, ...spec.extra, ...errorResponses(...[...errors].sort()) },
  };
  if (spec.body) result.requestBody = { required: spec.bodyRequired ?? true, content: { 'application/json': { schema: spec.body } } };
  if (spec.bodyContent) result.requestBody = { required: true, content: spec.bodyContent };
  if (spec.access === 'public') result.security = [];
  if (spec.access === 'webhook') result.security = [{ webhookSecret: [] }, { webhookBearer: [] }, { webhookSignature: [] }];
  return result;
}

const queryParam = (name: string, description: string, schema: Schema): Param => ({ name, in: 'query', description, schema });
const forceParam = queryParam('force', 'Con `1` se ignora la caché y se vuelve a comprobar.', { type: 'string', enum: ['1'] });
const SSE = (description: string): Schema => ({ 'text/event-stream': { schema: { type: 'string', description } } });

// ---------- Esquemas del dominio ----------
const RUN_STATUS = ['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'] as const;
const NODE_TYPES = ['input', 'agent', 'tool', 'condition', 'transform', 'foreach', 'subworkflow', 'approval', 'output'] as const;
const TRIGGER_KINDS = ['interval', 'daily', 'cron', 'webhook'] as const;
const RUN_EVENT_TYPES = [
  'run.started',
  'run.finished',
  'step.started',
  'step.finished',
  'step.retry',
  'step.skipped',
  'step.reused',
  'llm.start',
  'llm.delta',
  'llm.thinking',
  'llm.message',
  'llm.snapshot',
  'tool.call',
  'tool.result',
  'foreach.item',
  'subrun.started',
  'approval.requested',
  'approval.decided',
  'log',
] as const;

const timestamps = { createdAt: dateTime(), updatedAt: dateTime() };

function domainSchemas(): Record<string, Schema> {
  const usage = obj({ promptTokens: int(), completionTokens: int(), llmCalls: int(), toolCalls: int() }, { description: 'Consumo acumulado.' });
  const stepStatus = enumOf(['pending', 'running', 'waiting', 'completed', 'failed', 'skipped', 'cancelled']);
  const workflowContent = {
    name: str(),
    description: str(),
    nodes: array(ref('WorkflowNode')),
    edges: array(ref('WorkflowEdge')),
    settings: ref('WorkflowSettings'),
  };
  const backupManifest = obj({
    format: enumOf(['agentforge.backup']),
    version: enumOf([1]),
    createdAt: dateTime(),
    appVersion: str(),
    schemaVersion: int(),
    counts: obj({ agents: int(), workflows: int(), runs: int(), workspaceFiles: int() }),
  });
  const pendingRestore = obj({ name: str(), preparedAt: dateTime(), manifest: ref('BackupManifest') });
  const exportedAgent = obj(
    {
      id: str('Identificador que tenía en origen.'),
      name: str(),
      role: str(),
      description: str(),
      color: str(),
      model: str(),
      systemPrompt: str(),
      temperature: num(),
      maxTokens: nullable(int()),
      maxIterations: int(),
      tools: array(str()),
      thinking: bool(),
      provider: str('Nombre del proveedor que usaba (descrito en `providers`).'),
    },
    { optional: ['provider'] },
  );

  return {
    // --- Errores ---
    Error: obj(
      {
        error: str('Mensaje legible, en español.'),
        code: { ...str('Clase del error, estable; ver la tabla de códigos.', { enum: Object.keys(ERROR_CODES) }), 'x-code-descriptions': ERROR_CODES },
        i18n: ref('ServerMessage'),
        issues: array(ref('FieldIssue'), 'Solo con `code: validation`: un elemento por campo que no cumple el esquema.'),
        details: { description: 'Datos extra según el error; p. ej. `{ issues: ValidationIssue[] }` al lanzar un workflow con errores (422).' },
      },
      {
        optional: ['issues', 'details'],
        description: 'Forma de todas las respuestas de error de la API. `error` es el texto en español; `i18n`, el código y los parámetros de ese mismo texto.',
      },
    ),
    ServerMessage: obj(
      {
        code: { ...str('Código del texto (los de `shared/server-messages.ts`; en una causa anidada, también los de la validación de workflows).') },
        params: {
          ...anyObject(
            'Valores con los que se rellena el texto. Cada uno es un texto, un número, otro `ServerMessage` (la causa de un fallo; lleva su texto en `message`) o una lista de ellos. Lo que viene de fuera (la respuesta de un proveedor o de una herramienta) va aquí tal cual.',
          ),
        },
        message: str('Solo en un mensaje anidado: su texto en español.'),
      },
      {
        optional: ['params', 'message'],
        description:
          'Referencia a un texto escrito por el servidor, para mostrarlo en otro idioma: acompaña siempre al texto en español (`error`, `lastError`, `warnings[i]`…), que sirve de respaldo a quien no traduzca.',
      },
    ),
    FieldIssue: obj(
      {
        path: str('Ruta del campo, separada por puntos (`nodes.0.id`). Vacía si afecta al cuerpo entero.'),
        message: str('Texto en español.'),
        code: str('Código del problema (`nameRequired`, `tooLong`…), para mostrarlo en otro idioma.'),
        params: anyObject('Parámetros del mensaje (`min`, `max`, `field`…).'),
      },
      { optional: ['params'], description: 'Problema de validación de un campo del cuerpo o de la consulta.' },
    ),
    ValidationIssue: obj(
      {
        level: enumOf(['error', 'warning']),
        nodeId: str('Nodo afectado, si lo hay.'),
        message: str('Texto en español.'),
        code: { ...str('Código del problema, para mostrarlo en otro idioma.', { enum: Object.keys(VALIDATION_MESSAGES) }) },
        params: anyObject('Parámetros del mensaje.'),
      },
      { optional: ['nodeId', 'code', 'params'], description: 'Problema que `validateWorkflow` encuentra en un workflow.' },
    ),

    // --- Sistema ---
    HealthStatus: obj({ ok: bool(), version: str(), uptimeSec: int() }),
    ReadyStatus: obj(
      {
        ok: bool(),
        version: str(),
        uptimeSec: int(),
        activeRuns: int(),
        queuedRuns: int(),
        checks: dict(obj({ ok: bool(), detail: str() }, { optional: ['detail'] }), 'Comprobaciones: `database`, `dataDir` y `scheduler`.'),
      },
      { description: 'Resultado de la sonda de disponibilidad.' },
    ),
    AuthStatus: obj({ required: bool('¿El servidor exige clave de acceso?'), authenticated: bool() }),
    OnboardingState: obj({
      agentRun: bool('¿Existe alguna ejecución de un agente?'),
      workflowCompleted: bool('¿Existe alguna ejecución de workflow completada?'),
      welcomeWorkflowId: nullable(str('Id del workflow de bienvenida, aunque se haya renombrado; `null` si no existe o se borró.')),
    }),
    WelcomeWorkflow: obj({ workflowId: str('Id del workflow de bienvenida.') }, { description: 'El workflow de bienvenida, creado si hacía falta.' }),
    DashboardStats: obj({
      counts: obj({ agents: int(), workflows: int(), tools: int(), providers: int(), runs: int() }),
      runsByStatus: obj(Object.fromEntries(RUN_STATUS.map((status) => [status, int()]))),
      activeRuns: int(),
      queuedRuns: int(),
      successRate: nullable(num('Fracción de 0 a 1.')),
      avgDurationMs: nullable(num()),
      tokens: obj({ prompt: int(), completion: int() }),
      llmCalls: int(),
      toolCalls: int(),
      daily: array(obj({ date: str(), completed: int(), failed: int(), cancelled: int() })),
      topAgents: array(obj({ agentId: str(), name: str(), steps: int(), completionTokens: int() })),
      topTools: array(obj({ name: str(), calls: int() })),
      recentRuns: array(ref('RunSummary')),
      system: obj({ version: str(), nodeVersion: str(), platform: str(), uptimeSec: int(), memoryMb: int(), dbSizeBytes: int(), dataDir: str() }),
    }),
    Settings: obj({
      maxConcurrentRuns: int('Ejecuciones simultáneas (1-10).'),
      allowPrivateNetwork: bool('Permite que las herramientas HTTP accedan a redes privadas y a localhost.'),
      allowCodeExecution: bool('Habilita la herramienta `run_javascript`.'),
      codeSandbox: enumOf(['process', 'container'], 'Cómo se aísla `run_javascript`.'),
      autoResume: bool('Reanuda sin preguntar, al arrancar, las ejecuciones que un apagado dejó a medias.'),
      retentionDays: int('Días que se conservan las ejecuciones terminadas (0 = sin límite).'),
      retentionMaxRuns: int('Número máximo de ejecuciones terminadas que se conservan (0 = sin límite).'),
    }),
    SandboxStatus: obj({
      process: obj({ networkBlocked: bool(), method: enumOf(['permission', 'lockdown']), nodeVersion: str() }),
      container: obj({
        available: bool(),
        engine: nullable(enumOf(['docker', 'podman'])),
        version: nullable(str()),
        image: str(),
        imagePresent: bool(),
        error: nullable(str()),
        errorI18n: nullable(ref('ServerMessage')),
      }),
    }),

    // --- Proveedores ---
    Provider: obj({
      id: str(),
      name: str(),
      kind: enumOf(['ollama', 'openai']),
      baseUrl: str(),
      hasApiKey: bool('Indica si hay clave guardada; la clave nunca se devuelve.'),
      defaultModel: str(),
      enabled: bool(),
      ...timestamps,
    }),
    ModelInfo: obj(
      { id: str(), sizeBytes: int(), parameterSize: str(), contextLength: int(), capabilities: array(str()) },
      { optional: ['sizeBytes', 'parameterSize', 'contextLength', 'capabilities'] },
    ),
    ProviderTestResult: obj(
      { ok: bool(), latencyMs: int(), modelCount: int(), error: str(), errorI18n: ref('ServerMessage') },
      { optional: ['modelCount', 'error', 'errorI18n'] },
    ),
    ProviderHealth: obj(
      {
        providerId: str(),
        name: str(),
        kind: enumOf(['ollama', 'openai']),
        ok: bool(),
        latencyMs: int(),
        modelCount: int(),
        error: str(),
        errorI18n: ref('ServerMessage'),
      },
      { optional: ['error', 'errorI18n'] },
    ),

    // --- Agentes ---
    Agent: obj({
      id: str(),
      name: str(),
      role: str(),
      description: str(),
      color: str('Color hexadecimal `#rrggbb`.'),
      providerId: str(),
      model: str(),
      systemPrompt: str(),
      temperature: num(),
      maxTokens: nullable(int('Máximo de tokens de salida por llamada; `null` = el del modelo.')),
      maxIterations: int('Máximo de vueltas modelo-herramientas por tarea.'),
      tools: array(str('Nombre de herramienta.')),
      thinking: bool('Activa el razonamiento en los modelos que lo soportan.'),
      ...timestamps,
    }),

    // --- Herramientas ---
    JsonSchemaProp: obj(
      {
        type: enumOf(['string', 'number', 'integer', 'boolean', 'object', 'array']),
        description: str(),
        enum: array({ oneOf: [{ type: 'string' }, { type: 'number' }] }),
        items: obj({ type: str() }),
        default: {},
      },
      { optional: ['description', 'enum', 'items', 'default'] },
    ),
    ToolParameters: obj(
      { type: enumOf(['object']), properties: dict(ref('JsonSchemaProp')), required: array(str()) },
      { optional: ['required'], description: 'Parámetros de la herramienta, como un esquema JSON simple.' },
    ),
    ToolInfo: obj(
      {
        name: str(),
        title: str(),
        description: str(),
        category: str(),
        parameters: ref('ToolParameters'),
        source: enumOf(['builtin', 'custom', 'mcp']),
        dangerous: bool(),
        enabled: bool(),
        customId: str('Identificador de la herramienta personalizada (`source: custom`).'),
        mcpServerId: str('Servidor MCP del que viene (`source: mcp`).'),
        mcpServerName: str(),
      },
      { optional: ['customId', 'mcpServerId', 'mcpServerName'] },
    ),
    CustomTool: obj({
      id: str(),
      name: str(),
      description: str(),
      parameters: ref('ToolParameters'),
      method: enumOf(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      urlTemplate: str(),
      headers: dict(str(), 'Cabeceras fijas. El valor de las secretas llega vacío.'),
      secretHeaders: array(str(), 'Cabeceras cuyo valor está guardado cifrado y no se devuelve.'),
      bodyTemplate: str(),
      enabled: bool(),
      ...timestamps,
    }),
    ToolInvokeResult: obj(
      {
        ok: bool(),
        durationMs: int(),
        result: str('Resultado como texto (si `ok`).'),
        error: str('Motivo del fallo (si no `ok`).'),
        errorI18n: ref('ServerMessage'),
      },
      { optional: ['result', 'error', 'errorI18n'], description: 'Un fallo de la herramienta no es un error HTTP: la respuesta es 200 con `ok: false`.' },
    ),
    WorkspaceFile: obj({ path: str('Ruta relativa al espacio de trabajo, con `/`.'), sizeBytes: int(), modifiedAt: dateTime() }),
    WorkspaceFileContent: obj({ path: str(), sizeBytes: int(), content: str('Como mucho los primeros 500 000 bytes, como texto UTF-8.'), truncated: bool() }),
    McpServer: obj({
      id: str(),
      name: str('Prefijo de sus herramientas (`nombre__herramienta`).'),
      transport: enumOf(['stdio', 'http']),
      command: str(),
      args: array(str()),
      envKeys: array(str(), 'Nombres de las variables de entorno definidas; los valores no salen del servidor.'),
      url: str(),
      headerKeys: array(str(), 'Nombres de las cabeceras definidas; los valores no salen del servidor.'),
      enabled: bool(),
      status: enumOf(['disabled', 'connecting', 'connected', 'error']),
      error: nullable(str('Motivo del último fallo de conexión.')),
      errorI18n: nullable(ref('ServerMessage')),
      tools: array(obj({ name: str(), description: str() }), 'Herramientas que ofrece.'),
      ...timestamps,
    }),

    // --- Workflows ---
    WorkflowNode: obj({
      id: str(),
      type: enumOf(NODE_TYPES),
      label: str(),
      position: obj({ x: num(), y: num() }),
      config: anyObject('Configuración según el tipo de nodo; se valida con `POST /api/workflows/validate`.'),
    }),
    WorkflowEdge: obj(
      { id: str(), source: str(), target: str(), sourceHandle: nullable(str('En condiciones y aprobaciones: `true` o `false`.')) },
      { optional: ['sourceHandle'] },
    ),
    WorkflowSettings: obj({
      maxConcurrency: int('Nodos en paralelo (1-16).'),
      maxDurationMs: int('Duración máxima de la ejecución (1 000 ms a 6 h).'),
      maxLlmCalls: int('Máximo de llamadas al modelo (1-500).'),
      onError: enumOf(['fail', 'continue']),
      defaultRetries: int('Reintentos por defecto de un nodo (0-5).'),
    }),
    Workflow: obj({ id: str(), ...workflowContent, ...timestamps }),
    WorkflowContent: obj(workflowContent, { description: 'Definición de un workflow sin identificador ni fechas (la que viaja en los archivos exportados).' }),
    WorkflowValidation: obj({ issues: array(ref('ValidationIssue')) }),

    // --- Ejecuciones ---
    Usage: usage,
    RunSummary: obj(
      {
        id: str(),
        kind: enumOf(['agent', 'workflow']),
        workflowId: nullable(str()),
        agentId: nullable(str()),
        name: str(),
        status: enumOf(RUN_STATUS, '`waiting`: detenida a la espera de una aprobación humana.'),
        input: str('Solo el principio del texto; el completo está en la ejecución.'),
        output: nullable(str()),
        error: nullable(str('Motivo del fallo o de la cancelación, en español.')),
        errorI18n: nullable(ref('ServerMessage')),
        usage: ref('Usage'),
        retryOf: nullable(str()),
        interrupted: bool('Quedó a medias por un apagado y aún no se ha reanudado ni descartado.'),
        scheduled: bool('La lanzó un disparador con horario.'),
        triggerKind: nullable(enumOf(TRIGGER_KINDS)),
        parentRunId: nullable(str('Si es la ejecución de un subworkflow: la ejecución que la lanzó.')),
        parentNodeId: nullable(str()),
        createdAt: dateTime(),
        startedAt: nullable(dateTime()),
        finishedAt: nullable(dateTime()),
      },
      {
        optional: ['interrupted', 'scheduled', 'triggerKind', 'parentRunId', 'parentNodeId'],
        description: 'Resumen de una ejecución (listas, panel, avisos en vivo).',
      },
    ),
    RunStep: obj(
      {
        runId: str(),
        nodeId: str(),
        nodeType: enumOf(NODE_TYPES),
        label: str(),
        agentId: nullable(str()),
        status: stepStatus,
        attempt: int(),
        input: nullable(str()),
        output: nullable(str()),
        error: nullable(str()),
        errorI18n: nullable(ref('ServerMessage')),
        usage: ref('Usage'),
        startedAt: nullable(dateTime()),
        finishedAt: nullable(dateTime()),
        partialOutput: nullable(str('Texto generado cuando el paso se canceló o falló a medias.')),
      },
      { optional: ['partialOutput'] },
    ),
    RunSnapshot: obj(
      {
        workflow: obj({ nodes: array(ref('WorkflowNode')), edges: array(ref('WorkflowEdge')), settings: ref('WorkflowSettings') }),
        agents: dict(ref('Agent'), 'Agentes usados, tal como eran al lanzar la ejecución.'),
        subworkflows: dict(obj({ name: str(), definition: anyObject() }), 'Workflows usados como subworkflow.'),
      },
      { optional: ['subworkflows'], description: 'Definición con la que se lanzó la ejecución.' },
    ),
    Run: {
      description: 'Ejecución completa: el resumen más la definición lanzada y sus pasos.',
      allOf: [
        ref('RunSummary'),
        obj({
          snapshot: ref('RunSnapshot'),
          steps: array(ref('RunStep')),
          lastSeq: int(
            'Número de secuencia del último evento guardado al leer la ejecución (0 si no hay). El estado de los pasos ya incluye todo lo ocurrido hasta él: el flujo en vivo se continúa con `?after=` este valor.',
          ),
        }),
      ],
    },
    RunList: obj(
      {
        items: array(ref('RunSummary')),
        total: int(),
        capped: bool('`true` si una búsqueda de texto solo ha examinado las coincidencias más recientes (`total` cuenta las examinadas).'),
      },
      { optional: ['capped'] },
    ),
    RunEvent: obj(
      {
        seq: nullable(int('Número de orden dentro de la ejecución; `null` en eventos transitorios (deltas de streaming), que no se guardan.')),
        runId: str(),
        ts: dateTime(),
        type: enumOf(RUN_EVENT_TYPES),
        nodeId: nullable(str()),
        data: anyObject('Contenido según el tipo de evento.'),
      },
      { description: 'Evento del registro de una ejecución.' },
    ),
    RunStepItem: obj(
      {
        index: int(),
        item: str(),
        status: enumOf(['completed', 'failed']),
        output: nullable(str()),
        error: nullable(str()),
        errorI18n: nullable(ref('ServerMessage')),
      },
      { description: 'Elemento de un nodo «para cada», con su resultado.' },
    ),
    Approval: obj({
      id: str(),
      runId: str(),
      nodeId: str(),
      runName: str(),
      nodeLabel: str(),
      message: str('Lo que se le pregunta a la persona.'),
      status: enumOf(['pending', 'approved', 'rejected', 'cancelled']),
      comment: str(),
      createdAt: dateTime(),
      decidedAt: nullable(dateTime()),
    }),

    // --- Disparadores ---
    Trigger: obj(
      {
        id: str(),
        workflowId: str(),
        kind: enumOf(TRIGGER_KINDS),
        name: str(),
        intervalMinutes: nullable(int('Solo en `interval`.')),
        time: nullable(str('Solo en `daily`: `HH:MM`.')),
        weekdays: array(int(), 'Solo en `daily`: 0 = domingo … 6 = sábado. Vacío = todos los días.'),
        cron: nullable(str('Solo en `cron`: expresión de cinco campos.')),
        timezone: nullable(str('Zona horaria IANA; `null` = la del equipo del servidor.')),
        input: str('Entrada de cada ejecución. En un webhook es una plantilla: `{{body}}` se sustituye por el cuerpo de la llamada.'),
        enabled: bool(),
        nextRunAt: nullable(dateTime()),
        lastRunAt: nullable(dateTime()),
        lastRunId: nullable(str()),
        lastError: nullable(str('Motivo por el que la última ocasión no llegó a lanzarse.')),
        lastErrorI18n: nullable(ref('ServerMessage')),
        ...timestamps,
      },
      { description: 'Lo que lanza un workflow sin que nadie pulse «Ejecutar». El secreto de un webhook nunca se devuelve aquí.' },
    ),
    TriggerWithSecret: {
      description: 'Disparador con su secreto, que solo se muestra al crear un webhook o al regenerar su secreto.',
      allOf: [ref('Trigger'), obj({ secret: str('Secreto del webhook (`whsec_…`). No se vuelve a mostrar.') }, { optional: ['secret'] })],
    },
    TriggerPreview: obj({ timezone: str('Zona horaria que se aplicará.'), next: array(dateTime(), 'Próximas ocasiones, en orden (hasta cinco).') }),
    WebhookAccepted: obj({ runId: str(), status: enumOf(RUN_STATUS) }),

    // --- Copias de seguridad ---
    BackupManifest: backupManifest,
    BackupInfo: obj(
      { name: str(), sizeBytes: int(), createdAt: dateTime(), manifest: nullable(ref('BackupManifest')) },
      { description: '`manifest` es `null` si el archivo no se puede leer (copia dañada).' },
    ),
    PendingRestore: pendingRestore,
    BackupState: obj({
      backups: array(ref('BackupInfo')),
      pending: nullable(ref('PendingRestore')),
      lastRestore: nullable({ allOf: [ref('PendingRestore'), obj({ appliedAt: dateTime(), replacedDir: str() })] }),
    }),
    CancelledRestore: obj({ cancelled: bool('`true` si había una restauración pendiente y se ha cancelado.') }),

    // --- Exportación e importación ---
    ExportedAgent: exportedAgent,
    ExportedProvider: obj({ name: str(), kind: enumOf(['ollama', 'openai']), baseUrl: str(), defaultModel: str() }, { description: 'Nunca lleva la clave.' }),
    ExportedTool: {
      allOf: [ref('CustomToolInput'), obj({ secretHeaders: array(str(), 'Cabeceras cuyo valor no se ha exportado y hay que volver a escribir.') })],
    },
    WorkflowExport: obj(
      {
        format: enumOf(['agentforge.workflow']),
        version: enumOf([1, 2]),
        exportedAt: dateTime(),
        workflow: ref('WorkflowContent'),
        agents: array(ref('ExportedAgent'), 'Agentes que usan los nodos del workflow y de sus subworkflows.'),
        providers: array(ref('ExportedProvider')),
        tools: array(ref('ExportedTool')),
        subworkflows: array(obj({ id: str('Identificador en origen (lo referencian los nodos).'), workflow: ref('WorkflowContent') })),
        triggers: array(ref('TriggerInput'), 'Los webhooks viajan sin secreto.'),
      },
      { optional: ['providers', 'tools', 'subworkflows', 'triggers'], description: 'Archivo portable de un workflow.' },
    ),
    AgentExport: obj(
      {
        format: enumOf(['agentforge.agent']),
        version: enumOf([2]),
        exportedAt: dateTime(),
        agents: array(ref('ExportedAgent')),
        providers: array(ref('ExportedProvider')),
        tools: array(ref('ExportedTool')),
      },
      { optional: ['providers', 'tools'], description: 'Archivo portable de uno o varios agentes.' },
    ),
    ImportItem: obj(
      {
        key: str('Identificador estable dentro del plan (`agent:<id>`, `tool:<nombre>`…): la clave de las decisiones.'),
        kind: enumOf(['provider', 'tool', 'agent', 'workflow']),
        name: str(),
        match: nullable(obj({ id: str(), name: str() })),
        differs: bool('Coincide con un elemento local, pero su contenido es distinto.'),
        actions: array(enumOf(['create', 'reuse', 'replace', 'skip']), 'Acciones posibles.'),
        recommended: enumOf(['create', 'reuse', 'replace', 'skip']),
        targets: array(obj({ id: str(), name: str() }), 'Elementos locales a los que se puede enlazar con `reuse`.'),
        recommendedTargetId: str(),
        notes: array(str()),
        notesI18n: array(ref('ServerMessage'), 'Código y parámetros de cada nota, en la misma posición que en `notes`.'),
      },
      { optional: ['targets', 'recommendedTargetId'] },
    ),
    ImportPlan: obj(
      {
        kind: enumOf(['workflow', 'agent']),
        name: str(),
        items: array(ref('ImportItem')),
        warnings: array(str()),
        warningsI18n: array(ref('ServerMessage'), 'Código y parámetros de cada aviso, en la misma posición que en `warnings`.'),
      },
      { description: 'Lo que haría una importación; no cambia nada.' },
    ),
    ImportResult: obj(
      {
        workflow: nullable(ref('Workflow')),
        createdAgents: array(ref('Agent')),
        reusedAgents: array(ref('Agent')),
        replacedAgents: array(ref('Agent')),
        createdProviders: array(ref('Provider')),
        createdTools: array(str()),
        replacedTools: array(str()),
        createdWorkflows: array(ref('Workflow'), 'Subworkflows creados.'),
        triggers: int('Disparadores creados (siempre en pausa).'),
        warnings: array(str()),
        warningsI18n: array(ref('ServerMessage'), 'Código y parámetros de cada aviso, en la misma posición que en `warnings`.'),
        issues: array(ref('ValidationIssue'), 'Problemas de validación del workflow importado.'),
      },
      { description: '`workflow` es `null` al importar agentes sueltos.' },
    ),
    WorkflowImportResult: { allOf: [ref('ImportResult'), obj({ workflow: ref('Workflow') })] },
  };
}

// ---------- Cuerpos de entrada (generados de los esquemas zod) ----------
function inputSchemas(): Record<string, Schema> {
  return {
    LoginInput: obj({ token: str('Clave de acceso del servidor.') }, { description: 'Credenciales de inicio de sesión.' }),
    SettingsInput: fromZod(settingsSchema, 'Cambio parcial de ajustes: solo se modifican los campos enviados.'),
    ProviderInput: fromZod(providerSchema, 'Datos de un proveedor.', {
      apiKey: 'Clave de la API. Omitida al editar = conservar la guardada; `null` o vacía = borrarla.',
      baseUrl: 'Dirección http(s) del proveedor.',
    }),
    ProviderProbeInput: fromZod(providerProbeSchema, 'Configuración de un proveedor para probarla sin guardarla.', {
      id: 'Proveedor que se está editando: si no se envía `apiKey`, se usa su clave guardada (solo hacia el mismo origen).',
    }),
    AgentInput: fromZod(agentSchema, 'Datos de un agente.', {
      providerId: 'Proveedor existente.',
      tools: 'Nombres de herramientas existentes (ver `GET /api/tools`).',
    }),
    CustomToolInput: fromZod(customToolSchema, 'Herramienta HTTP personalizada.', {
      name: 'Nombre único; no puede coincidir con una herramienta integrada.',
      urlTemplate: 'URL con parámetros `{{nombre}}`.',
      headers: 'Una cabecera secreta enviada con valor vacío al editar conserva el valor guardado.',
    }),
    ToolInvokeInput: fromZod(invokeToolSchema, 'Argumentos de la herramienta.'),
    McpServerInput: fromZod(mcpServerSchema, 'Servidor MCP. `stdio` exige `command`; `http`, una `url` http(s).', {
      env: 'Variables de entorno (stdio). Omitido al editar = conservar las guardadas; si cambia `command` hay que enviarlas de nuevo (400 `credential_required`).',
      headers:
        'Cabeceras (http). Omitido al editar = conservar las guardadas; si cambia el origen de `url` hay que enviarlas de nuevo (400 `credential_required`).',
    }),
    WorkflowInput: fromZod(workflowSchema, 'Definición de un workflow. Además de este esquema se comprueba el grafo con `POST /api/workflows/validate`.', {
      nodes: 'Hasta 100 nodos.',
      edges: 'Hasta 400 aristas.',
    }),
    TriggerInput: fromZod(triggerSchema, 'Disparador. `interval` exige `intervalMinutes`; `daily`, `time`; `cron`, `cron`. Un webhook no lleva horario.', {
      input: 'Entrada de cada ejecución; en un webhook, plantilla con `{{body}}`.',
      timezone: 'Zona horaria IANA (`Europe/Madrid`); vacía = la del equipo.',
    }),
    RunInput: fromZod(runInputSchema, 'Entrada de una ejecución. Para un agente no puede estar vacía.'),
    RetryInput: fromZod(retrySchema, 'Cómo reintentar: `all` desde cero; `failed` reutiliza los pasos que ya terminaron bien.'),
    RunIdsInput: fromZod(runIdsSchema, 'Ejecuciones interrumpidas a las que se aplica la acción; omitido = todas.'),
    ApprovalDecisionInput: fromZod(approvalDecisionSchema, 'Decisión sobre una aprobación pendiente.'),
    WorkflowBundle: fromZod(workflowImportSchema, 'Archivo de workflow exportado (formato `agentforge.workflow`, versiones 1 y 2).'),
    AgentBundle: fromZod(agentImportSchema, 'Archivo de agentes exportado (formato `agentforge.agent`, versiones 1 y 2).'),
    ImportDecisions: fromZod(importDecisionsSchema, 'Decisión por elemento del plan, indexada por su `key`. Las que falten usan la acción recomendada.'),
    ImportPlanRequest: obj({ bundle: { oneOf: [ref('WorkflowBundle'), ref('AgentBundle')], description: 'Contenido del archivo exportado.' } }),
    ImportRequest: obj(
      { bundle: { oneOf: [ref('WorkflowBundle'), ref('AgentBundle')], description: 'Contenido del archivo exportado.' }, decisions: ref('ImportDecisions') },
      { optional: ['decisions'] },
    ),
    WebhookBody: {
      type: 'object',
      additionalProperties: true,
      properties: { input: str('Si viene y es texto, es la entrada de la ejecución; si no, se usa el cuerpo entero como texto.') },
      description: 'Cuerpo JSON de la llamada. Se admite cualquier otro tipo de contenido: se usa como texto.',
    },
  };
}

// ---------- Rutas ----------
const T = {
  system: 'Sistema',
  session: 'Sesión',
  providers: 'Proveedores',
  agents: 'Agentes',
  tools: 'Herramientas',
  workspace: 'Espacio de trabajo',
  mcp: 'Servidores MCP',
  workflows: 'Workflows',
  triggers: 'Disparadores',
  webhooks: 'Webhooks',
  runs: 'Ejecuciones',
  approvals: 'Aprobaciones',
  transfer: 'Importación y exportación',
  backups: 'Copias de seguridad',
  settings: 'Ajustes',
  live: 'Eventos en vivo',
} as const;

const TAGS: Array<[string, string]> = [
  [T.system, 'Estado del servidor, sondas de salud, estadísticas y la propia especificación.'],
  [T.session, 'Inicio y cierre de sesión con la clave de acceso.'],
  [T.providers, 'Proveedores de modelos (Ollama, compatibles con OpenAI): alta, prueba y lista de modelos.'],
  [T.agents, 'Agentes: un modelo con su prompt, sus herramientas y sus límites. Se pueden ejecutar solos.'],
  [T.tools, 'Herramientas integradas, personalizadas (HTTP) y de servidores MCP.'],
  [T.workspace, 'Archivos que los agentes crean y leen en la carpeta de trabajo.'],
  [T.mcp, 'Servidores del Model Context Protocol que ofrecen herramientas a los agentes.'],
  [T.workflows, 'Grafos de nodos que encadenan agentes, herramientas, condiciones y aprobaciones.'],
  [T.triggers, 'Lo que lanza un workflow sin intervención: intervalo, hora diaria, cron o webhook.'],
  [T.webhooks, 'Receptor de llamadas externas que lanzan un workflow, autenticado con el secreto del disparador.'],
  [T.runs, 'Ejecuciones de agentes y de workflows: historial, cancelación, reintento y reanudación.'],
  [T.approvals, 'Aprobaciones humanas que detienen una ejecución hasta que alguien decide.'],
  [T.transfer, 'Archivos portables de workflows y agentes; la importación se hace en dos pasos (plan y aplicación).'],
  [T.backups, 'Copias completas de los datos (base de datos, clave maestra y espacio de trabajo) y su restauración.'],
  [T.settings, 'Ajustes globales y estado de los aislamientos de `run_javascript`.'],
  [T.live, 'Flujos de eventos del servidor (SSE) para interfaces en vivo.'],
];

const runsQuery: Param[] = [
  queryParam('status', 'Solo ejecuciones en este estado. `active` reúne las que no han terminado: en cola, en curso y en espera.', {
    type: 'string',
    enum: [...RUN_STATUS, 'active'],
  }),
  queryParam('kind', 'Solo de este tipo.', { type: 'string', enum: ['agent', 'workflow'] }),
  queryParam('workflowId', 'Solo las de este workflow.', { type: 'string', maxLength: 64 }),
  queryParam('agentId', 'Solo las ejecuciones directas de este agente (no las de workflows que lo usan).', { type: 'string', maxLength: 64 }),
  queryParam('from', 'Solo las creadas en este instante o después (ISO 8601 con zona horaria, p. ej. `2026-01-31T00:00:00Z`).', {
    type: 'string',
    format: 'date-time',
  }),
  queryParam('to', 'Solo las creadas en este instante o antes (ISO 8601 con zona horaria).', { type: 'string', format: 'date-time' }),
  queryParam('search', 'Texto a buscar en el nombre, la entrada, la salida y el error.', { type: 'string', maxLength: 200 }),
  queryParam('limit', 'Tamaño de página (1-200; por defecto 50).', { type: 'integer', minimum: 1, maximum: 200 }),
  queryParam('offset', 'Elementos a saltar (0 o más).', { type: 'integer', minimum: 0 }),
];

const afterParam = (what: string): Param =>
  queryParam('after', `Devuelve solo ${what} posteriores a este número de secuencia (0 o más).`, { type: 'integer', minimum: 0 });

const eventsQuery: Param[] = [
  afterParam('eventos'),
  queryParam('before', 'Devuelve solo eventos anteriores a este número de secuencia (0 o más).', { type: 'integer', minimum: 0 }),
  queryParam(
    'limit',
    'Tamaño de página (1-1000). Sin él se devuelven todos los eventos del tramo. Con `before`, la página son los últimos eventos anteriores a ese cursor; sin él, los primeros posteriores a `after`.',
    { type: 'integer', minimum: 1, maximum: 1000 },
  ),
];

const SSE_NOTE =
  'Flujo de eventos del servidor (`text/event-stream`): la conexión queda abierta. Cada ~15 s llega un comentario `: ping` para mantenerla viva y el servidor sugiere reconectar a los 2 s (`retry: 2000`). Si un cliente no lee y se le acumulan más de 8 MiB, se le corta la conexión.';

function routes(): Array<[string, Method, OpSpec]> {
  const R = (path: string, method: Method, spec: OpSpec): [string, Method, OpSpec] => [path, method, spec];
  const list = (schema: Schema) => array(schema);
  const created = { ok: 201 } as const;
  const removed = { ok: 204 } as const;

  return [
    // ----- Sistema -----
    R('/api/health', 'get', { tag: T.system, id: 'getHealth', summary: 'Estado del servidor y versión', response: ref('HealthStatus') }),
    R('/api/health/live', 'get', {
      tag: T.system,
      id: 'getHealthLive',
      summary: 'Sonda de vida: el proceso atiende peticiones',
      description: 'No toca la base de datos ni exige clave de acceso: pensada para un orquestador.',
      response: ref('HealthStatus'),
      access: 'public',
    }),
    R('/api/health/ready', 'get', {
      tag: T.system,
      id: 'getHealthReady',
      summary: 'Sonda de disponibilidad: base de datos, carpeta de datos y planificador',
      description: 'Responde 200 si todas las comprobaciones pasan y 503 (con el mismo cuerpo) si alguna falla.',
      response: ref('ReadyStatus'),
      extra: { '503': { description: 'Alguna comprobación ha fallado.', content: { 'application/json': { schema: ref('ReadyStatus') } } } },
    }),
    R('/api/stats', 'get', {
      tag: T.system,
      id: 'getStats',
      summary: 'Estadísticas del panel: totales, consumo, actividad diaria y sistema',
      response: ref('DashboardStats'),
    }),
    R('/api/onboarding', 'get', {
      tag: T.system,
      id: 'getOnboarding',
      summary: 'Qué pasos de la guía de primeros pasos están ya hechos',
      description:
        'Consulta ligera: comprueba si existe alguna ejecución, sin contar el historial. Incluye el id del workflow de bienvenida, que el servidor reconoce por una marca propia aunque el usuario lo renombre.',
      response: ref('OnboardingState'),
    }),
    R('/api/onboarding/welcome', 'post', {
      tag: T.system,
      id: 'ensureWelcomeWorkflow',
      summary: 'Crea el workflow de bienvenida si no existe y devuelve su id',
      description:
        'Idempotente: si ya existe (aunque se haya renombrado o editado) devuelve el mismo id sin tocarlo; si se borró, lo vuelve a crear con su agente «Guía» (o reutiliza el agente si sigue existiendo). Si no hay ningún proveedor configurado, crea antes el de Ollama local, como el primer arranque. No lleva cuerpo.',
      response: ref('WelcomeWorkflow'),
    }),
    R('/api/metrics', 'get', {
      tag: T.system,
      id: 'getMetrics',
      summary: 'Métricas en el formato de texto de Prometheus',
      description:
        'Ejecuciones por estado, en marcha y en cola; llamadas a modelos y a herramientas y tokens (acumulados); inventario; memoria del proceso, tamaño de la base de datos y respuestas HTTP por clase de estado. Exige la clave de acceso si está configurada.',
      okContent: { 'text/plain': { schema: { type: 'string' } } },
    }),
    R('/api/openapi.json', 'get', {
      tag: T.system,
      id: 'getOpenApi',
      summary: 'Esta especificación OpenAPI 3.1 en JSON',
      response: obj({ openapi: str(), info: anyObject(), paths: anyObject() }, { description: 'Documento OpenAPI 3.1.' }),
    }),

    // ----- Sesión -----
    R('/api/auth/status', 'get', {
      tag: T.session,
      id: 'getAuthStatus',
      summary: 'Indica si el servidor exige clave y si esta petición ya está autenticada',
      response: ref('AuthStatus'),
      access: 'public',
    }),
    R('/api/auth/login', 'post', {
      tag: T.session,
      id: 'login',
      summary: 'Inicia sesión con la clave de acceso y deja la cookie `af_session`',
      description: 'Si el servidor no tiene clave configurada responde 204 sin hacer nada. Límite propio de 10 intentos por minuto y cliente.',
      body: ref('LoginInput'),
      ok: 204,
      okDescription: 'Sesión iniciada: la respuesta trae `Set-Cookie: af_session=…` (HttpOnly, SameSite=Strict, 30 días).',
      errors: [401],
      access: 'public',
    }),
    R('/api/auth/logout', 'post', { tag: T.session, id: 'logout', summary: 'Cierra la sesión borrando la cookie `af_session`', ok: 204, access: 'public' }),

    // ----- Ajustes -----
    R('/api/settings', 'get', { tag: T.settings, id: 'getSettings', summary: 'Ajustes globales', response: ref('Settings') }),
    R('/api/settings', 'put', {
      tag: T.settings,
      id: 'updateSettings',
      summary: 'Modifica los ajustes indicados',
      description:
        'Un cambio en la retención se aplica en el momento. Elegir `codeSandbox: container` exige que haya un motor de contenedores disponible (409 si no).',
      body: ref('SettingsInput'),
      response: ref('Settings'),
      errors: [400, 409],
    }),
    R('/api/sandbox/status', 'get', {
      tag: T.settings,
      id: 'getSandboxStatus',
      summary: 'Estado real de los aislamientos de `run_javascript`',
      query: [forceParam],
      response: ref('SandboxStatus'),
    }),

    // ----- Copias de seguridad -----
    R('/api/backups', 'get', {
      tag: T.backups,
      id: 'listBackups',
      summary: 'Lista las copias, la restauración pendiente y la última aplicada',
      response: ref('BackupState'),
    }),
    R('/api/backups', 'post', {
      tag: T.backups,
      id: 'createBackup',
      summary: 'Crea una copia completa de los datos',
      description: 'No hace falta parar nada. Incluye la base de datos, la clave maestra y el espacio de trabajo.',
      ...created,
      response: ref('BackupInfo'),
      errors: [409],
    }),
    R('/api/backups/upload', 'post', {
      tag: T.backups,
      id: 'uploadBackup',
      summary: 'Sube un archivo de copia',
      description: 'El cuerpo es el archivo tal cual (`application/octet-stream`); se valida antes de aceptarlo y no se carga en memoria.',
      bodyContent: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
      ...created,
      response: ref('BackupInfo'),
      errors: [400, 413, 415],
    }),
    R('/api/backups/restore/pending', 'delete', {
      tag: T.backups,
      id: 'cancelPendingRestore',
      summary: 'Cancela la restauración preparada',
      response: ref('CancelledRestore'),
    }),
    R('/api/backups/{name}', 'delete', { tag: T.backups, id: 'deleteBackup', summary: 'Elimina una copia', ...removed, errors: [400, 404] }),
    R('/api/backups/{name}/download', 'get', {
      tag: T.backups,
      id: 'downloadBackup',
      summary: 'Descarga el archivo de una copia',
      okContent: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
      okDescription: 'El archivo, con `Content-Disposition: attachment`.',
      errors: [400, 404],
    }),
    R('/api/backups/{name}/restore', 'post', {
      tag: T.backups,
      id: 'prepareRestore',
      summary: 'Valida una copia y la deja preparada para restaurarla',
      description: 'Los datos se sustituyen en el próximo arranque del servidor.',
      ok: 202,
      response: ref('PendingRestore'),
      errors: [400, 404, 409],
    }),

    // ----- Proveedores -----
    R('/api/providers', 'get', { tag: T.providers, id: 'listProviders', summary: 'Lista los proveedores', response: list(ref('Provider')) }),
    R('/api/providers/health', 'get', {
      tag: T.providers,
      id: 'getProvidersHealth',
      summary: 'Estado de conexión de los proveedores activos',
      description: 'El resultado se guarda 10 s en caché; `force=1` lo ignora.',
      query: [forceParam],
      response: list(ref('ProviderHealth')),
    }),
    R('/api/providers', 'post', {
      tag: T.providers,
      id: 'createProvider',
      summary: 'Crea un proveedor',
      body: ref('ProviderInput'),
      ...created,
      response: ref('Provider'),
      errors: [400],
    }),
    R('/api/providers/test', 'post', {
      tag: T.providers,
      id: 'testProviderConfig',
      summary: 'Prueba una configuración de proveedor sin guardarla',
      description: 'Un fallo de conexión no es un error HTTP: la respuesta es 200 con `ok: false`.',
      body: ref('ProviderProbeInput'),
      response: ref('ProviderTestResult'),
      errors: [400],
    }),
    R('/api/providers/models', 'post', {
      tag: T.providers,
      id: 'listModelsOfConfig',
      summary: 'Lista los modelos de una configuración sin guardarla',
      body: ref('ProviderProbeInput'),
      response: list(ref('ModelInfo')),
      errors: [400, 502],
    }),
    R('/api/providers/{id}', 'put', {
      tag: T.providers,
      id: 'updateProvider',
      summary: 'Modifica un proveedor',
      body: ref('ProviderInput'),
      response: ref('Provider'),
      errors: [400, 404],
    }),
    R('/api/providers/{id}', 'delete', {
      tag: T.providers,
      id: 'deleteProvider',
      summary: 'Elimina un proveedor que ningún agente use',
      ...removed,
      errors: [404, 409],
    }),
    R('/api/providers/{id}/test', 'post', {
      tag: T.providers,
      id: 'testProvider',
      summary: 'Prueba un proveedor guardado',
      description: 'Un fallo de conexión no es un error HTTP: la respuesta es 200 con `ok: false`.',
      response: ref('ProviderTestResult'),
      errors: [404, 409],
    }),
    R('/api/providers/{id}/models', 'get', {
      tag: T.providers,
      id: 'listProviderModels',
      summary: 'Lista los modelos de un proveedor guardado',
      response: list(ref('ModelInfo')),
      errors: [404, 409, 502],
    }),

    // ----- Agentes -----
    R('/api/agents', 'get', { tag: T.agents, id: 'listAgents', summary: 'Lista los agentes', response: list(ref('Agent')) }),
    R('/api/agents/{id}', 'get', { tag: T.agents, id: 'getAgent', summary: 'Obtiene un agente', response: ref('Agent'), errors: [404] }),
    R('/api/agents', 'post', {
      tag: T.agents,
      id: 'createAgent',
      summary: 'Crea un agente',
      body: ref('AgentInput'),
      ...created,
      response: ref('Agent'),
      errors: [400],
    }),
    R('/api/agents/{id}', 'put', {
      tag: T.agents,
      id: 'updateAgent',
      summary: 'Modifica un agente',
      body: ref('AgentInput'),
      response: ref('Agent'),
      errors: [400, 404],
    }),
    R('/api/agents/{id}/duplicate', 'post', {
      tag: T.agents,
      id: 'duplicateAgent',
      summary: 'Duplica un agente (añade « (copia)» al nombre)',
      ...created,
      response: ref('Agent'),
      errors: [404],
    }),
    R('/api/agents/{id}', 'delete', { tag: T.agents, id: 'deleteAgent', summary: 'Elimina un agente que ningún workflow use', ...removed, errors: [404, 409] }),
    R('/api/agents/{id}/run', 'post', {
      tag: T.agents,
      id: 'runAgent',
      summary: 'Lanza el agente con una tarea',
      description: 'La ejecución sigue en segundo plano: se consulta con `GET /api/runs/{id}` o se sigue en vivo con `GET /api/runs/{id}/stream`.',
      body: ref('RunInput'),
      ok: 202,
      response: ref('Run'),
      errors: [400, 404],
    }),

    // ----- Herramientas -----
    R('/api/tools', 'get', {
      tag: T.tools,
      id: 'listTools',
      summary: 'Lista todas las herramientas (integradas, personalizadas y de servidores MCP)',
      response: list(ref('ToolInfo')),
    }),
    R('/api/tools/custom', 'get', { tag: T.tools, id: 'listCustomTools', summary: 'Lista las herramientas personalizadas', response: list(ref('CustomTool')) }),
    R('/api/tools/custom/{id}', 'get', {
      tag: T.tools,
      id: 'getCustomTool',
      summary: 'Obtiene una herramienta personalizada',
      response: ref('CustomTool'),
      errors: [404],
    }),
    R('/api/tools/custom', 'post', {
      tag: T.tools,
      id: 'createCustomTool',
      summary: 'Crea una herramienta personalizada',
      body: ref('CustomToolInput'),
      ...created,
      response: ref('CustomTool'),
      errors: [400, 409],
    }),
    R('/api/tools/custom/{id}', 'put', {
      tag: T.tools,
      id: 'updateCustomTool',
      summary: 'Modifica una herramienta personalizada',
      description:
        'Una cabecera secreta enviada vacía conserva el valor guardado, salvo que `urlTemplate` apunte a otro origen: entonces hay que escribirla de nuevo o quitarla (400 `credential_required`).',
      body: ref('CustomToolInput'),
      response: ref('CustomTool'),
      errors: [400, 404, 409],
    }),
    R('/api/tools/custom/{id}', 'delete', {
      tag: T.tools,
      id: 'deleteCustomTool',
      summary: 'Elimina una herramienta personalizada',
      ...removed,
      errors: [404],
    }),
    R('/api/tools/{name}/invoke', 'post', {
      tag: T.tools,
      id: 'invokeTool',
      summary: 'Ejecuta una herramienta a mano (banco de pruebas)',
      description: 'Tiene un límite de 30 s. Un fallo de la herramienta no es un error HTTP: la respuesta es 200 con `ok: false`.',
      body: ref('ToolInvokeInput'),
      response: ref('ToolInvokeResult'),
      errors: [400, 404],
    }),

    // ----- Servidores MCP -----
    R('/api/mcp/servers', 'get', {
      tag: T.mcp,
      id: 'listMcpServers',
      summary: 'Lista los servidores MCP con su estado y sus herramientas',
      response: list(ref('McpServer')),
    }),
    R('/api/mcp/servers', 'post', {
      tag: T.mcp,
      id: 'createMcpServer',
      summary: 'Añade un servidor MCP y espera (con tope) a que conecte',
      body: ref('McpServerInput'),
      ...created,
      response: ref('McpServer'),
      errors: [400, 409],
    }),
    R('/api/mcp/servers/{id}', 'put', {
      tag: T.mcp,
      id: 'updateMcpServer',
      summary: 'Modifica un servidor MCP y vuelve a conectarlo',
      body: ref('McpServerInput'),
      response: ref('McpServer'),
      errors: [400, 404, 409],
    }),
    R('/api/mcp/servers/{id}', 'delete', { tag: T.mcp, id: 'deleteMcpServer', summary: 'Elimina un servidor MCP y desconecta', ...removed, errors: [404] }),
    R('/api/mcp/servers/{id}/reconnect', 'post', {
      tag: T.mcp,
      id: 'reconnectMcpServer',
      summary: 'Vuelve a conectar y a leer la lista de herramientas',
      response: ref('McpServer'),
      errors: [404],
    }),

    // ----- Espacio de trabajo -----
    R('/api/workspace/files', 'get', {
      tag: T.workspace,
      id: 'listWorkspaceFiles',
      summary: 'Lista los archivos del espacio de trabajo',
      response: list(ref('WorkspaceFile')),
    }),
    R('/api/workspace/file', 'get', {
      tag: T.workspace,
      id: 'readWorkspaceFile',
      summary: 'Lee un archivo (como mucho los primeros 500 000 bytes)',
      query: [{ name: 'path', in: 'query', required: true, description: 'Ruta relativa al espacio de trabajo.', schema: { type: 'string' } }],
      response: ref('WorkspaceFileContent'),
      errors: [400, 404],
    }),
    R('/api/workspace/file', 'delete', {
      tag: T.workspace,
      id: 'deleteWorkspaceFile',
      summary: 'Elimina un archivo',
      query: [{ name: 'path', in: 'query', required: true, description: 'Ruta relativa al espacio de trabajo.', schema: { type: 'string' } }],
      ...removed,
      errors: [400, 404],
    }),

    // ----- Workflows -----
    R('/api/workflows', 'get', { tag: T.workflows, id: 'listWorkflows', summary: 'Lista los workflows', response: list(ref('Workflow')) }),
    R('/api/workflows/{id}', 'get', {
      tag: T.workflows,
      id: 'getWorkflow',
      summary: 'Obtiene un workflow con sus nodos y aristas',
      response: ref('Workflow'),
      errors: [404],
    }),
    R('/api/workflows', 'post', {
      tag: T.workflows,
      id: 'createWorkflow',
      summary: 'Crea un workflow',
      body: ref('WorkflowInput'),
      ...created,
      response: ref('Workflow'),
      errors: [400],
    }),
    R('/api/workflows/validate', 'post', {
      tag: T.workflows,
      id: 'validateWorkflow',
      summary: 'Valida un workflow sin guardarlo',
      description:
        'Comprueba el grafo contra los agentes, las herramientas y los demás workflows (subworkflows y ciclos). Acepta además un `id` opcional: el workflow que se está editando, para detectar que se llame a sí mismo.',
      body: ref('WorkflowInput'),
      response: ref('WorkflowValidation'),
      errors: [400],
    }),
    R('/api/workflows/{id}', 'put', {
      tag: T.workflows,
      id: 'updateWorkflow',
      summary: 'Modifica un workflow',
      body: ref('WorkflowInput'),
      response: ref('Workflow'),
      errors: [400, 404],
    }),
    R('/api/workflows/{id}/duplicate', 'post', {
      tag: T.workflows,
      id: 'duplicateWorkflow',
      summary: 'Duplica un workflow (añade « (copia)» al nombre)',
      ...created,
      response: ref('Workflow'),
      errors: [404],
    }),
    R('/api/workflows/{id}', 'delete', {
      tag: T.workflows,
      id: 'deleteWorkflow',
      summary: 'Elimina un workflow que ningún otro use como subworkflow',
      ...removed,
      errors: [404, 409],
    }),
    R('/api/workflows/{id}/run', 'post', {
      tag: T.workflows,
      id: 'runWorkflow',
      summary: 'Lanza un workflow con una entrada',
      description: 'Se valida antes: con errores responde 422 y `details.issues` lista los problemas.',
      body: ref('RunInput'),
      ok: 202,
      response: ref('Run'),
      errors: [400, 404, 422],
    }),

    // ----- Importación y exportación -----
    R('/api/workflows/{id}/export', 'get', {
      tag: T.transfer,
      id: 'exportWorkflow',
      summary: 'Exporta un workflow con los agentes, herramientas y disparadores que usa (sin claves)',
      response: ref('WorkflowExport'),
      errors: [404],
    }),
    R('/api/agents/{id}/export', 'get', {
      tag: T.transfer,
      id: 'exportAgent',
      summary: 'Exporta un agente con sus herramientas HTTP y su proveedor (sin claves)',
      response: ref('AgentExport'),
      errors: [404],
    }),
    R('/api/import/plan', 'post', {
      tag: T.transfer,
      id: 'planImport',
      summary: 'Primer paso de una importación: qué trae el archivo y cómo encaja con lo que ya hay',
      description: 'No cambia nada.',
      body: ref('ImportPlanRequest'),
      response: ref('ImportPlan'),
      errors: [400],
    }),
    R('/api/import', 'post', {
      tag: T.transfer,
      id: 'applyImport',
      summary: 'Segundo paso: aplica la importación con las decisiones tomadas',
      description: 'Es atómica: si algo falla, no se crea nada. Las decisiones que falten usan la acción recomendada del plan.',
      body: ref('ImportRequest'),
      ...created,
      response: ref('ImportResult'),
      errors: [400],
    }),
    R('/api/workflows/import', 'post', {
      tag: T.transfer,
      id: 'importWorkflow',
      summary: 'Importa un workflow exportado con las acciones recomendadas, sin revisión previa',
      description: 'Pensada para automatizar y por compatibilidad; la interfaz usa `POST /api/import/plan` y `POST /api/import`.',
      body: ref('WorkflowBundle'),
      ...created,
      response: ref('WorkflowImportResult'),
      errors: [400],
    }),

    // ----- Disparadores -----
    R('/api/triggers', 'get', {
      tag: T.triggers,
      id: 'listTriggers',
      summary: 'Lista los disparadores de todos los workflows',
      response: list(ref('Trigger')),
    }),
    R('/api/workflows/{id}/triggers', 'get', {
      tag: T.triggers,
      id: 'listWorkflowTriggers',
      summary: 'Lista los disparadores de un workflow',
      response: list(ref('Trigger')),
      errors: [404],
    }),
    R('/api/triggers/preview', 'post', {
      tag: T.triggers,
      id: 'previewTrigger',
      summary: 'Calcula las próximas cinco ocasiones de un horario sin guardarlo',
      body: ref('TriggerInput'),
      response: ref('TriggerPreview'),
      errors: [400],
    }),
    R('/api/workflows/{id}/triggers', 'post', {
      tag: T.triggers,
      id: 'createTrigger',
      summary: 'Crea un disparador para un workflow',
      description: 'Un workflow admite como máximo 20. Al crear un webhook la respuesta trae su `secret`, que no se vuelve a mostrar.',
      body: ref('TriggerInput'),
      ...created,
      response: ref('TriggerWithSecret'),
      errors: [400, 404, 409],
    }),
    R('/api/triggers/{id}', 'put', {
      tag: T.triggers,
      id: 'updateTrigger',
      summary: 'Modifica un disparador',
      description: 'Un webhook no se puede convertir en uno con horario, ni al revés (400).',
      body: ref('TriggerInput'),
      response: ref('Trigger'),
      errors: [400, 404],
    }),
    R('/api/triggers/{id}', 'delete', { tag: T.triggers, id: 'deleteTrigger', summary: 'Elimina un disparador', ...removed, errors: [404] }),
    R('/api/triggers/{id}/run', 'post', {
      tag: T.triggers,
      id: 'runTrigger',
      summary: 'Lanza ahora un disparador con su entrada guardada',
      description: 'Sirve para probarlo sin esperar a la hora. Responde 422 si no se puede lanzar (workflow con errores o borrado).',
      ok: 202,
      response: ref('Run'),
      errors: [404, 422],
    }),
    R('/api/triggers/{id}/secret', 'post', {
      tag: T.triggers,
      id: 'renewTriggerSecret',
      summary: 'Regenera el secreto de un webhook',
      description: 'El anterior deja de valer y el nuevo solo se devuelve aquí.',
      response: ref('TriggerWithSecret'),
      errors: [400, 404],
    }),

    // ----- Webhooks -----
    R('/api/hooks/{id}', 'post', {
      tag: T.webhooks,
      id: 'callWebhook',
      summary: 'Lanza el workflow de un disparador de tipo webhook',
      description: [
        'No exige la clave de acceso de la interfaz: se autentica con el secreto del disparador, de una de estas formas:',
        '',
        '- `X-AgentForge-Secret: <secreto>`.',
        '- `Authorization: Bearer <secreto>`.',
        '- `X-AgentForge-Signature: sha256=<firma>`: HMAC-SHA256 en hexadecimal del cuerpo en bruto, con el secreto como clave. Si viene, se usa esta y no las anteriores.',
        '',
        'El cuerpo (hasta 1 MiB) se lee en bruto, sea del tipo que sea. La entrada de la ejecución es el campo `input` de un cuerpo JSON si es texto y, si no, el cuerpo como texto (máximo 100 000 caracteres). Si el disparador tiene una plantilla de entrada, `{{body}}` se sustituye por ese texto. Un secreto incorrecto y un webhook inexistente dan la misma respuesta 401.',
      ].join('\n'),
      bodyContent: { 'application/json': { schema: ref('WebhookBody') }, '*/*': { schema: { type: 'string', format: 'binary' } } },
      ok: 202,
      okDescription: 'Ejecución aceptada.',
      response: ref('WebhookAccepted'),
      errors: [401, 409, 413, 422],
      access: 'webhook',
    }),

    // ----- Ejecuciones -----
    R('/api/runs', 'get', {
      tag: T.runs,
      id: 'listRuns',
      summary: 'Historial de ejecuciones, con filtros y paginación',
      query: runsQuery,
      response: ref('RunList'),
      errors: [400],
    }),
    R('/api/runs/interrupted', 'get', {
      tag: T.runs,
      id: 'listInterruptedRuns',
      summary: 'Ejecuciones que un apagado dejó a medias y siguen pendientes',
      response: list(ref('RunSummary')),
    }),
    R('/api/runs/interrupted/resume', 'post', {
      tag: T.runs,
      id: 'resumeInterruptedRuns',
      summary: 'Reanuda las ejecuciones interrumpidas indicadas (o todas)',
      description: 'Reutiliza los pasos que ya habían terminado y devuelve las ejecuciones nuevas.',
      body: ref('RunIdsInput'),
      bodyRequired: false,
      ok: 202,
      response: list(ref('Run')),
      errors: [400],
    }),
    R('/api/runs/interrupted/dismiss', 'post', {
      tag: T.runs,
      id: 'dismissInterruptedRuns',
      summary: 'Descarta el aviso de reanudación: las ejecuciones quedan como fallidas',
      body: ref('RunIdsInput'),
      bodyRequired: false,
      response: obj({ dismissed: int('Ejecuciones descartadas.') }),
      errors: [400],
    }),
    R('/api/runs', 'delete', { tag: T.runs, id: 'deleteFinishedRuns', summary: 'Elimina todas las ejecuciones terminadas', response: obj({ deleted: int() }) }),
    R('/api/runs/{id}', 'get', {
      tag: T.runs,
      id: 'getRun',
      summary: 'Obtiene una ejecución completa, con su definición y sus pasos',
      response: ref('Run'),
      errors: [404],
    }),
    R('/api/runs/{id}/events', 'get', {
      tag: T.runs,
      id: 'listRunEvents',
      summary: 'Eventos guardados de una ejecución, por orden y por páginas',
      description:
        'Siempre por orden de secuencia. Para recorrer una ejecución larga hacia atrás: `?before=<lastSeq + 1>&limit=200` da la página más reciente y `?before=<seq del primero recibido>&limit=200`, la anterior; hacia delante, `?after=<seq del último recibido>&limit=200`.',
      query: eventsQuery,
      response: list(ref('RunEvent')),
      errors: [400, 404],
    }),
    R('/api/runs/{id}/cancel', 'post', {
      tag: T.runs,
      id: 'cancelRun',
      summary: 'Cancela una ejecución en curso',
      response: obj({ ok: bool() }),
      errors: [404, 409],
    }),
    R('/api/runs/{id}/retry', 'post', {
      tag: T.runs,
      id: 'retryRun',
      summary: 'Reintenta una ejecución terminada, desde cero o solo lo que falló',
      body: ref('RetryInput'),
      bodyRequired: false,
      ok: 202,
      response: ref('Run'),
      errors: [400, 404, 409],
    }),
    R('/api/runs/{id}', 'delete', { tag: T.runs, id: 'deleteRun', summary: 'Elimina una ejecución terminada', ...removed, errors: [404, 409] }),
    R('/api/runs/{id}/children', 'get', {
      tag: T.runs,
      id: 'listChildRuns',
      summary: 'Subejecuciones (subworkflows) que lanzó una ejecución',
      description: 'De la más antigua a la más reciente.',
      response: list(ref('RunSummary')),
      errors: [404],
    }),
    R('/api/runs/{id}/steps/{nodeId}/items', 'get', {
      tag: T.runs,
      id: 'listStepItems',
      summary: 'Resultado de cada elemento de un nodo «para cada»',
      response: list(ref('RunStepItem')),
      errors: [404],
    }),

    // ----- Aprobaciones -----
    R('/api/approvals', 'get', {
      tag: T.approvals,
      id: 'listApprovals',
      summary: 'Aprobaciones pendientes o, con `runId`, todas las de una ejecución',
      query: [
        queryParam('runId', 'Si se indica, devuelve todas las aprobaciones de esa ejecución (con su decisión); si no, solo las pendientes.', {
          type: 'string',
        }),
      ],
      response: list(ref('Approval')),
    }),
    R('/api/approvals/{id}/decide', 'post', {
      tag: T.approvals,
      id: 'decideApproval',
      summary: 'Aprueba o rechaza una aprobación pendiente',
      description: 'Responde 409 si la aprobación ya no está pendiente (decidida, cancelada o sin ejecución esperando).',
      body: ref('ApprovalDecisionInput'),
      response: ref('Approval'),
      errors: [400, 404, 409],
    }),

    // ----- Eventos en vivo -----
    R('/api/stream/approvals', 'get', {
      tag: T.live,
      id: 'streamApprovals',
      summary: 'Avisa cada vez que cambia el conjunto de aprobaciones pendientes',
      description: `${SSE_NOTE}\n\nEvento \`approvals\`: \`data\` es el array completo de aprobaciones pendientes (\`Approval[]\`). Se envía una vez al conectar y otra con cada cambio. Los eventos no llevan \`id\`.`,
      okContent: SSE('Eventos `approvals` con `Approval[]` en `data`.'),
    }),
    R('/api/stream/runs', 'get', {
      tag: T.live,
      id: 'streamRuns',
      summary: 'Cambios de estado de todas las ejecuciones (listas y panel en vivo)',
      description: `${SSE_NOTE}\n\nEvento \`run\`: \`data\` es el \`RunSummary\` de la ejecución que ha cambiado. Al conectar no se envía el estado actual: se consulta con \`GET /api/runs\`. Los eventos no llevan \`id\`.`,
      okContent: SSE('Eventos `run` con un `RunSummary` en `data`.'),
    }),
    R('/api/runs/{id}/stream', 'get', {
      tag: T.live,
      id: 'streamRun',
      summary: 'Eventos de una ejecución en tiempo real, con reproducción del historial',
      description: [
        SSE_NOTE,
        '',
        'Evento `run-event`: `data` es un `RunEvent` y `id` su `seq`. Al conectar se reproduce primero el historial guardado, por tandas de 500, a partir del número indicado en la cabecera `Last-Event-ID` o, si no viene, en `?after=` (0 por defecto); después llegan los eventos nuevos sin perder ni repetir ninguno. Un valor no válido en cualquiera de los dos se rechaza con 400.',
        'Para no reproducir el historial entero, se parte de `GET /api/runs/{id}` (que ya trae el estado de los pasos) y se conecta con `?after=` su `lastSeq`.',
        'Un navegador (`EventSource`) reconecta solo y envía `Last-Event-ID` con el último `id` recibido.',
        'Tras el historial se envían eventos `llm.snapshot` (con `seq: null` y sin `id`) con el texto que cada nodo lleva generado, y los deltas de streaming (`llm.delta`) también tienen `seq: null`.',
        'La conexión no se cierra al terminar la ejecución: el evento `run.finished` marca el final.',
      ].join('\n'),
      query: [
        afterParam('eventos'),
        {
          name: 'Last-Event-ID',
          in: 'header',
          description: 'Último `seq` recibido; tiene prioridad sobre `?after=`.',
          schema: { type: 'integer', minimum: 0 },
        },
      ],
      okContent: SSE('Eventos `run-event` con un `RunEvent` en `data`.'),
      errors: [400, 404],
    }),
  ];
}

// ---------- Documento ----------
/** Construye el documento OpenAPI 3.1 de la API. `version` es la de la aplicación. */
export function buildOpenApi(version: string): object {
  const paths: Record<string, Record<string, Schema>> = {};
  for (const [path, method, spec] of routes()) {
    paths[path] ??= {};
    paths[path][method] = operation(path, spec);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'API de AgentForge',
      version,
      description: [
        'API HTTP de AgentForge: agentes de IA, herramientas y workflows que se ejecutan en tu equipo.',
        '',
        '**Autenticación.** Si el servidor se arranca con `AGENTFORGE_TOKEN`, toda la API (salvo `/api/auth/*`, `/api/health/live` y los webhooks) exige la clave: envíala como `Authorization: Bearer <clave>` o inicia sesión con `POST /api/auth/login` para recibir la cookie `af_session`. Sin clave configurada (por defecto, escuchando solo en `127.0.0.1`) no hace falta nada. Los webhooks se autentican con el secreto de su disparador.',
        '',
        '**Errores.** Toda respuesta de error es `{ "error": string, "code": string, "i18n": ServerMessage }`, más `issues` (validación) o `details` según el caso. Antes de llegar a las rutas, una petición con un `Host` no permitido o que procede de otro sitio web se rechaza con 403 y `{ "error": string }` sin `code`.',
        '',
        '**Idiomas.** El servidor escribe sus textos en español. Los que llegan a la pantalla (errores, problemas de validación, motivo de fallo de una ejecución o de un paso, avisos de una importación) van acompañados de su código y sus parámetros (`ServerMessage`: `i18n`, `errorI18n`, `lastErrorI18n`, `warningsI18n`…), con los que un cliente puede mostrarlos en otro idioma; el texto en español sigue ahí como respaldo. Los datos anteriores a esta versión no tienen referencia (`null`).',
        '',
        '**Límite de tasa.** 1 200 peticiones por minuto y cliente (`AGENTFORGE_RATE_LIMIT`; 0 lo desactiva), un décimo (mínimo 30) en las rutas costosas (lanzar, probar, reintentar, invocar, reconectar y webhooks) y 10 intentos por minuto en el inicio de sesión. Al superarlo, 429 con `Retry-After`.',
      ].join('\n'),
    },
    servers: [{ url: 'http://127.0.0.1:4310', description: 'Servidor local por defecto' }],
    tags: TAGS.map(([name, description]) => ({ name, description })),
    security: [{ bearerAuth: [] }, { sessionCookie: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Clave de acceso del servidor (`AGENTFORGE_TOKEN`) en `Authorization: Bearer <clave>`.' },
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'af_session',
          description: 'Cookie de sesión que deja `POST /api/auth/login` (HttpOnly, SameSite=Strict, 30 días).',
        },
        webhookSecret: {
          type: 'apiKey',
          in: 'header',
          name: 'X-AgentForge-Secret',
          description: 'Secreto del disparador de tipo webhook (`whsec_…`), enviado tal cual.',
        },
        webhookBearer: {
          type: 'http',
          scheme: 'bearer',
          description: 'Secreto del disparador de tipo webhook en `Authorization: Bearer <secreto>` (no es la clave de acceso del servidor).',
        },
        webhookSignature: {
          type: 'apiKey',
          in: 'header',
          name: 'X-AgentForge-Signature',
          description: 'Firma HMAC-SHA256 en hexadecimal del cuerpo en bruto, con el secreto del webhook como clave. Admite el prefijo `sha256=`.',
        },
      },
      schemas: { ...domainSchemas(), ...inputSchemas() },
    },
  };
}
