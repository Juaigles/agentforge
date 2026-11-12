// Tipos del dominio compartidos entre el servidor y el frontend.
import type { ServerMessage } from './server-messages';
import type { IssueParams, ValidationCode } from './validation-messages';

// ---------- Proveedores LLM ----------
export type ProviderKind = 'ollama' | 'openai';

export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  /** Nunca se devuelve la clave; solo si existe. */
  hasApiKey: boolean;
  defaultModel: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderInput {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  /** undefined = conservar la actual; null o '' = borrar. */
  apiKey?: string | null;
  defaultModel?: string;
  enabled?: boolean;
}

export interface ModelInfo {
  id: string;
  sizeBytes?: number;
  parameterSize?: string;
  contextLength?: number;
  capabilities?: string[];
}

export interface ProviderTestResult {
  /** Código y parámetros de `error`, para mostrarlo en otro idioma. */
  errorI18n?: ServerMessage;
  ok: boolean;
  latencyMs: number;
  modelCount?: number;
  error?: string;
}

// ---------- Agentes ----------
export interface Agent {
  id: string;
  name: string;
  role: string;
  description: string;
  color: string;
  providerId: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  /** Máximo de tokens de salida por llamada (null = por defecto del modelo). */
  maxTokens: number | null;
  /** Máximo de vueltas LLM↔herramientas por tarea. */
  maxIterations: number;
  tools: string[];
  /** Activa el razonamiento ("thinking") en modelos que lo soportan. */
  thinking: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AgentInput = Omit<Agent, 'id' | 'createdAt' | 'updatedAt'>;

// ---------- Herramientas ----------
export interface JsonSchemaProp {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  description?: string;
  enum?: Array<string | number>;
  items?: { type: string };
  default?: unknown;
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProp>;
  required?: string[];
}

export interface ToolInfo {
  name: string;
  title: string;
  description: string;
  category: string;
  parameters: JsonSchema;
  source: 'builtin' | 'custom' | 'mcp';
  dangerous: boolean;
  enabled: boolean;
  customId?: string;
  /** Si viene de un servidor MCP: su id y su nombre. */
  mcpServerId?: string;
  mcpServerName?: string;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CustomTool {
  id: string;
  name: string;
  description: string;
  parameters: JsonSchema;
  method: HttpMethod;
  urlTemplate: string;
  /** Cabeceras fijas. El valor de las secretas (ver `secretHeaders`) no sale del servidor: llega vacío. */
  headers: Record<string, string>;
  /** Nombres de las cabeceras cuyo valor está guardado cifrado y no se devuelve. */
  secretHeaders: string[];
  bodyTemplate: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Al editar, una cabecera secreta enviada con el valor vacío conserva el valor guardado. */
export type CustomToolInput = Omit<CustomTool, 'id' | 'createdAt' | 'updatedAt' | 'secretHeaders'>;

/**
 * ¿El nombre de la cabecera indica que su valor es una credencial (Authorization, Cookie, X-API-Key, …-Token…)?
 * Esas cabeceras se guardan cifradas, no se devuelven por la API y no viajan en los archivos exportados.
 */
export function isSecretHeaderName(name: string): boolean {
  return /authorization|cookie|token|secret|password|passwd|credential|session|signature|api[-_]?key|[-_]key$|^key$/i.test(name.trim());
}

// ---------- Workflows ----------
export type NodeType = 'input' | 'agent' | 'tool' | 'condition' | 'transform' | 'foreach' | 'subworkflow' | 'approval' | 'output';

export type ConditionOperator = 'contains' | 'not_contains' | 'equals' | 'not_equals' | 'matches' | 'gt' | 'lt' | 'is_empty' | 'not_empty';

export interface InputNodeConfig {
  description?: string;
  defaultValue?: string;
}
export interface AgentNodeConfig {
  agentId: string;
  prompt: string;
  retries?: number;
  timeoutMs?: number;
}
export interface ToolNodeConfig {
  tool: string;
  args: Record<string, unknown>;
  retries?: number;
  timeoutMs?: number;
}
export interface ConditionNodeConfig {
  left: string;
  operator: ConditionOperator;
  right: string;
}
export interface TransformNodeConfig {
  template: string;
}
/** Qué se ejecuta con cada elemento de un «para cada». */
export type ForeachBody = 'agent' | 'tool' | 'subworkflow';

/** «Para cada»: ejecuta un agente, una herramienta o un subworkflow una vez por cada elemento de una lista. */
export interface ForeachNodeConfig {
  /** Por defecto, 'agent'. */
  body?: ForeachBody;
  /** Con body 'agent'. */
  agentId: string;
  /** Con body 'tool': la herramienta y sus argumentos (admiten {{item}}, {{index}} y {{total}}). */
  tool?: string;
  args?: Record<string, unknown>;
  /** Con body 'subworkflow': el workflow que se lanza con cada elemento y su entrada (por defecto, {{item}}). */
  workflowId?: string;
  input?: string;
  /** Qué hacer si falla un elemento: detener el nodo ('fail', por defecto) o seguir con los demás ('continue'). */
  onItemError?: 'fail' | 'continue';
  /** Plantilla que produce la lista (array JSON o un elemento por línea). Por defecto, {{upstream}}. */
  items: string;
  /** Tarea para cada elemento; admite {{item}}, {{index}} y {{total}} además de las referencias habituales. */
  prompt: string;
  /** Elementos procesados a la vez (1-8). */
  concurrency?: number;
  /** Tope de elementos admitidos (1-100); si la lista es mayor, el nodo falla. */
  maxItems?: number;
  /** 'sections' = un apartado por elemento; 'json' = array JSON con los resultados. */
  format?: 'sections' | 'json';
  retries?: number;
  timeoutMs?: number;
}
export const FOREACH_DEFAULTS = { concurrency: 2, maxItems: 20, maxConcurrency: 8, hardMaxItems: 100 } as const;

/** Ejecuta otro workflow como un paso de este y devuelve su resultado. */
export interface SubworkflowNodeConfig {
  workflowId: string;
  /** Entrada del subworkflow. Por defecto, {{upstream}}. */
  input?: string;
  retries?: number;
  timeoutMs?: number;
}

/**
 * Aprobación humana: la ejecución se detiene hasta que una persona aprueba o rechaza. Como una condición, tiene
 * dos salidas: «sí» (aprobado) y «no» (rechazado). El comentario queda disponible como {{id_nodo.comment}}.
 */
export interface ApprovalNodeConfig {
  /** Qué se le pregunta a la persona (admite plantillas). */
  message: string;
  /** Tiempo máximo de espera; pasado ese tiempo el nodo falla. 0 o ausente = sin límite. */
  timeoutMs?: number;
}

/** Profundidad máxima de workflows anidados (un subworkflow que lanza otro, etc.). */
export const MAX_SUBWORKFLOW_DEPTH = 5;

export interface OutputNodeConfig {
  template?: string;
}

export interface WorkflowNode {
  id: string;
  type: NodeType;
  label: string;
  position: { x: number; y: number };
  // Forma según `type` (ver *NodeConfig). Se valida semánticamente con validateWorkflow.
  config: Record<string, any>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /** Solo para nodos condición: 'true' | 'false'. */
  sourceHandle?: string | null;
}

export interface WorkflowSettings {
  maxConcurrency: number;
  maxDurationMs: number;
  maxLlmCalls: number;
  onError: 'fail' | 'continue';
  defaultRetries: number;
}

export const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = {
  maxConcurrency: 4,
  maxDurationMs: 15 * 60_000,
  maxLlmCalls: 40,
  onError: 'fail',
  defaultRetries: 1,
};

export interface WorkflowDefinition {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  settings: WorkflowSettings;
}

export interface Workflow extends WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export type WorkflowInput = Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'>;

export interface ValidationIssue {
  level: 'error' | 'warning';
  nodeId?: string;
  /** Texto en español. */
  message: string;
  /** Código y parámetros del problema, para mostrarlo en otro idioma (ver shared/validation-messages.ts). */
  code?: ValidationCode;
  params?: IssueParams;
}

// ---------- Ejecuciones ----------
/** 'waiting': detenida a la espera de una aprobación humana (no ocupa un hueco de ejecución). */
export type RunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'skipped' | 'cancelled';
export type RunKind = 'agent' | 'workflow';

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  llmCalls: number;
  toolCalls: number;
}

export const ZERO_USAGE: Usage = { promptTokens: 0, completionTokens: 0, llmCalls: 0, toolCalls: 0 };

export interface RunSnapshot {
  workflow: WorkflowDefinition;
  agents: Record<string, Agent>;
  /** Workflows que este usa como subworkflow (directa o indirectamente), tal como eran al lanzar la ejecución. */
  subworkflows?: Record<string, { name: string; definition: WorkflowDefinition }>;
}

/**
 * Resumen de una ejecución (listas, panel, avisos en vivo). `input`, `output` y `error` llevan solo el principio
 * del texto; el contenido completo está en `Run` (GET /api/runs/:id).
 */
export interface RunSummary {
  id: string;
  kind: RunKind;
  workflowId: string | null;
  agentId: string | null;
  name: string;
  status: RunStatus;
  input: string;
  output: string | null;
  error: string | null;
  /** Código y parámetros de `error`, para mostrarlo en otro idioma (null en lo anterior a la 1.0 o si el texto viene de fuera). */
  errorI18n?: ServerMessage | null;
  usage: Usage;
  retryOf: string | null;
  /** Quedó a medias por un apagado del servidor y aún no se ha reanudado ni descartado. */
  interrupted?: boolean;
  /** La lanzó un disparador con horario, no una persona. */
  scheduled?: boolean;
  /** Tipo de disparador que la lanzó (también 'webhook'), si lo hubo. */
  triggerKind?: TriggerKind | null;
  /** Si es la ejecución de un subworkflow: la ejecución y el nodo que la lanzaron. */
  parentRunId?: string | null;
  parentNodeId?: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunStep {
  runId: string;
  nodeId: string;
  nodeType: NodeType;
  label: string;
  agentId: string | null;
  status: StepStatus;
  attempt: number;
  input: string | null;
  output: string | null;
  error: string | null;
  /** Código y parámetros de `error`, para mostrarlo en otro idioma (null en lo anterior a la 1.0 o si el texto viene de fuera). */
  errorI18n?: ServerMessage | null;
  usage: Usage;
  startedAt: string | null;
  finishedAt: string | null;
  /** Texto que el modelo llevaba generado cuando el paso se canceló o falló a medias. */
  partialOutput?: string | null;
}

/** Elemento de un nodo «para cada», con su resultado. */
export interface RunStepItem {
  index: number;
  item: string;
  status: 'completed' | 'failed';
  output: string | null;
  error: string | null;
  /** Código y parámetros de `error`, para mostrarlo en otro idioma. */
  errorI18n?: ServerMessage | null;
}

/** Petición de aprobación humana de una ejecución. */
export interface Approval {
  id: string;
  runId: string;
  nodeId: string;
  /** Nombre de la ejecución y etiqueta del nodo, para mostrarla sin más consultas. */
  runName: string;
  nodeLabel: string;
  message: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  comment: string;
  createdAt: string;
  decidedAt: string | null;
}

export interface Run extends RunSummary {
  snapshot: RunSnapshot;
  steps: RunStep[];
  /**
   * Número de secuencia del último evento guardado cuando se leyó la ejecución (0 si no hay ninguno). El estado de
   * los pasos ya incluye todo lo ocurrido hasta ese evento: quien sigue la ejecución en vivo continúa desde ahí.
   */
  lastSeq: number;
}

export type RunEventType =
  | 'run.started'
  | 'run.finished'
  | 'step.started'
  | 'step.finished'
  | 'step.retry'
  | 'step.skipped'
  | 'step.reused'
  | 'llm.start'
  | 'llm.delta'
  | 'llm.thinking'
  | 'llm.message'
  | 'llm.snapshot'
  | 'tool.call'
  | 'tool.result'
  | 'foreach.item'
  | 'subrun.started'
  | 'approval.requested'
  | 'approval.decided'
  | 'log';

export interface RunEvent {
  /** null en eventos transitorios (deltas de streaming), que no se persisten. */
  seq: number | null;
  runId: string;
  ts: string;
  type: RunEventType;
  nodeId: string | null;
  data: Record<string, any>;
}

// ---------- Ajustes y sistema ----------
export interface Settings {
  maxConcurrentRuns: number;
  /** Permite que las herramientas HTTP accedan a redes privadas/localhost. */
  allowPrivateNetwork: boolean;
  /** Habilita la herramienta run_javascript. */
  allowCodeExecution: boolean;
  /** Cómo se aísla run_javascript: en un proceso de Node restringido o en un contenedor sin red (Docker/Podman). */
  codeSandbox: 'process' | 'container';
  /** Reanuda sin preguntar, al arrancar, las ejecuciones que un apagado dejó a medias. */
  autoResume: boolean;
  /** Días que se conservan las ejecuciones terminadas (0 = sin límite). */
  retentionDays: number;
  /** Número máximo de ejecuciones terminadas que se conservan (0 = sin límite). */
  retentionMaxRuns: number;
}

export const DEFAULT_SETTINGS: Settings = {
  maxConcurrentRuns: 3,
  allowPrivateNetwork: false,
  allowCodeExecution: false,
  codeSandbox: 'process',
  autoResume: false,
  retentionDays: 0,
  retentionMaxRuns: 0,
};

// ---------- Disparadores ----------
/**
 * Qué lanza un workflow sin que nadie pulse «Ejecutar»:
 * - `interval`: cada N minutos.
 * - `daily`: a una hora, todos los días o solo algunos días de la semana.
 * - `cron`: una expresión cron de cinco campos.
 * - `webhook`: una petición HTTP de otro programa, autenticada con un secreto.
 */
export type TriggerKind = 'interval' | 'daily' | 'cron' | 'webhook';
export const TRIGGER_KINDS: TriggerKind[] = ['interval', 'daily', 'cron', 'webhook'];
export const MAX_TRIGGERS_PER_WORKFLOW = 20;

export interface Trigger {
  id: string;
  workflowId: string;
  kind: TriggerKind;
  /** Nombre para distinguirlo cuando un workflow tiene varios. */
  name: string;
  /** Solo en 'interval'. */
  intervalMinutes: number | null;
  /** Solo en 'daily': "HH:MM". */
  time: string | null;
  /** Solo en 'daily': días de la semana (0 = domingo … 6 = sábado). Vacío = todos los días. */
  weekdays: number[];
  /** Solo en 'cron': expresión de cinco campos. */
  cron: string | null;
  /** Zona horaria IANA de 'daily' y 'cron' («Europe/Madrid»). Null = la del equipo donde corre el servidor. */
  timezone: string | null;
  /**
   * Texto de entrada de cada ejecución. En un webhook es una plantilla: `{{body}}` se sustituye por el cuerpo
   * de la petición; si se deja vacía, la entrada es el cuerpo tal cual.
   */
  input: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunId: string | null;
  /** Motivo por el que la última ocasión no llegó a lanzarse (workflow con errores, solape…). */
  lastError: string | null;
  /** Código y parámetros de `lastError`, para mostrarlo en otro idioma. */
  lastErrorI18n?: ServerMessage | null;
  createdAt: string;
  updatedAt: string;
}

export type TriggerInput = Pick<Trigger, 'kind' | 'name' | 'intervalMinutes' | 'time' | 'weekdays' | 'cron' | 'timezone' | 'input' | 'enabled'>;

/** Respuesta al crear un webhook o regenerar su secreto: el secreto solo se muestra esta vez. */
export interface TriggerWithSecret extends Trigger {
  secret?: string;
}

/** Vista previa de una programación antes de guardarla. */
export interface TriggerPreview {
  /** Zona horaria que se aplicará. */
  timezone: string;
  /** Próximas ocasiones (ISO), en orden. */
  next: string[];
}

// ---------- Servidores MCP ----------
export type McpTransport = 'stdio' | 'http';
export type McpStatus = 'disabled' | 'connecting' | 'connected' | 'error';

/** Servidor MCP (Model Context Protocol): un programa externo que ofrece herramientas a los agentes. */
export interface McpServer {
  id: string;
  /** Prefijo de sus herramientas (`nombre__herramienta`). */
  name: string;
  transport: McpTransport;
  /** stdio: programa que se arranca y sus argumentos. */
  command: string;
  args: string[];
  /** stdio: nombres de las variables de entorno definidas (los valores no salen del servidor). */
  envKeys: string[];
  /** http: dirección del servidor. */
  url: string;
  /** http: nombres de las cabeceras definidas (los valores no salen del servidor). */
  headerKeys: string[];
  enabled: boolean;
  status: McpStatus;
  /** Código y parámetros de `error` cuando el texto es del propio AgentForge (lo que responde el servidor MCP no los tiene). */
  errorI18n?: ServerMessage | null;
  /** Motivo del último fallo de conexión. */
  error: string | null;
  /** Herramientas que ofrece (nombre con el que las ven los agentes). */
  tools: Array<{ name: string; description: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerInput {
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  /** Si se omite al editar, se conservan las variables guardadas. */
  env?: Record<string, string>;
  url: string;
  /** Si se omite al editar, se conservan las cabeceras guardadas. */
  headers?: Record<string, string>;
  enabled: boolean;
}

// ---------- Exportación / importación ----------
export const WORKFLOW_EXPORT_FORMAT = 'agentforge.workflow';
export const AGENT_EXPORT_FORMAT = 'agentforge.agent';
/** Versión actual del formato de los archivos exportados. La 1 (solo workflow y agentes) se sigue pudiendo importar. */
export const EXPORT_VERSION = 2;

/** Agente tal como viaja en un archivo exportado: sin el id del proveedor, que se resuelve al importar. */
export type ExportedAgent = Pick<
  Agent,
  'id' | 'name' | 'role' | 'description' | 'color' | 'model' | 'systemPrompt' | 'temperature' | 'maxTokens' | 'maxIterations' | 'tools' | 'thinking'
> & {
  /** Nombre del proveedor que usaba (descrito en `providers`). */
  provider?: string;
};

/** Proveedor en un archivo exportado: nunca lleva la clave. */
export interface ExportedProvider {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  defaultModel: string;
}

/** Herramienta HTTP en un archivo exportado: las cabeceras secretas viajan sin valor. */
export interface ExportedTool extends CustomToolInput {
  /** Cabeceras cuyo valor no se ha exportado y hay que volver a escribir. */
  secretHeaders: string[];
}

/** Otro workflow usado como subworkflow por el exportado. `id` es el que tenía en origen (lo referencian los nodos). */
export interface ExportedWorkflow {
  id: string;
  workflow: WorkflowInput;
}

export interface WorkflowExport {
  format: typeof WORKFLOW_EXPORT_FORMAT;
  version: 1 | 2;
  exportedAt: string;
  workflow: WorkflowInput;
  /** Agentes que usan los nodos del workflow y de sus subworkflows. */
  agents: ExportedAgent[];
  /** Proveedores de esos agentes, sin claves. */
  providers?: ExportedProvider[];
  /** Herramientas HTTP personalizadas que usan los agentes y los nodos de herramienta. */
  tools?: ExportedTool[];
  /** Workflows que este usa como subworkflow (también los que usan ellos). */
  subworkflows?: ExportedWorkflow[];
  /** Disparadores del workflow. Los webhooks viajan sin secreto. */
  triggers?: TriggerInput[];
}

/** Uno o varios agentes sueltos, con sus herramientas HTTP y sus proveedores (sin claves). */
export interface AgentExport {
  format: typeof AGENT_EXPORT_FORMAT;
  version: 2;
  exportedAt: string;
  agents: ExportedAgent[];
  providers?: ExportedProvider[];
  tools?: ExportedTool[];
}

export type ExportBundle = WorkflowExport | AgentExport;

export type ImportItemKind = 'provider' | 'tool' | 'agent' | 'workflow';
/** Qué hacer con un elemento del archivo: crearlo, usar el que ya hay, sustituir el que hay o no importarlo. */
export type ImportAction = 'create' | 'reuse' | 'replace' | 'skip';

/** Un elemento del archivo y cómo encaja con lo que ya existe aquí. */
export interface ImportItem {
  /** Identificador estable dentro del plan (`agent:<id>`, `tool:<nombre>`…): la clave de las decisiones. */
  key: string;
  kind: ImportItemKind;
  name: string;
  /** Elemento local con el que coincide (mismo id o mismo nombre). */
  match: { id: string; name: string } | null;
  /** Coincide con uno local, pero su contenido es distinto. */
  differs: boolean;
  /** Acciones posibles, y la que se aplica si no se decide otra cosa. */
  actions: ImportAction[];
  recommended: ImportAction;
  /** Elementos locales con los que se puede enlazar al elegir «reuse» (proveedores). */
  targets?: Array<{ id: string; name: string }>;
  recommendedTargetId?: string;
  /** Explicaciones para quien decide. */
  notes: string[];
  /** Código y parámetros de cada nota (misma posición que en `notes`), para mostrarlas en otro idioma. */
  notesI18n?: ServerMessage[];
}

/** Lo que haría una importación, para revisarlo antes de aplicarla. */
export interface ImportPlan {
  kind: 'workflow' | 'agent';
  /** Nombre del workflow (o del agente) principal del archivo. */
  name: string;
  items: ImportItem[];
  warnings: string[];
  /** Código y parámetros de cada aviso (misma posición que en `warnings`), para mostrarlos en otro idioma. */
  warningsI18n?: ServerMessage[];
}

export interface ImportDecision {
  action: ImportAction;
  /** Con «reuse»: el elemento local elegido, si no es el que coincide. */
  targetId?: string;
}

export interface ImportResult {
  /** Workflow creado (null al importar agentes sueltos). */
  workflow: Workflow | null;
  /** Agentes creados porque no existían o porque se pidió una copia. */
  createdAgents: Agent[];
  /** Agentes del archivo que se han enlazado con uno ya existente. */
  reusedAgents: Agent[];
  /** Agentes locales sustituidos por la versión del archivo. */
  replacedAgents: Agent[];
  createdProviders: Provider[];
  /** Nombres de las herramientas HTTP creadas y sustituidas. */
  createdTools: string[];
  replacedTools: string[];
  /** Subworkflows creados. */
  createdWorkflows: Workflow[];
  /** Disparadores creados (siempre en pausa). */
  triggers: number;
  /** Avisos de la importación (herramientas que no existen aquí, cabeceras por rellenar, agentes sin proveedor…). */
  warnings: string[];
  /** Código y parámetros de cada aviso (misma posición que en `warnings`), para mostrarlos en otro idioma. */
  warningsI18n?: ServerMessage[];
  /** Problemas de validación del workflow importado. */
  issues: ValidationIssue[];
}

export type WorkflowImportResult = ImportResult & { workflow: Workflow };

export interface ProviderHealth {
  providerId: string;
  name: string;
  kind: ProviderKind;
  ok: boolean;
  latencyMs: number;
  modelCount: number;
  error?: string;
  /** Código y parámetros de `error`, para mostrarlo en otro idioma. */
  errorI18n?: ServerMessage;
}

export interface DashboardStats {
  counts: { agents: number; workflows: number; tools: number; providers: number; runs: number };
  runsByStatus: Record<RunStatus, number>;
  activeRuns: number;
  queuedRuns: number;
  successRate: number | null;
  avgDurationMs: number | null;
  tokens: { prompt: number; completion: number };
  llmCalls: number;
  toolCalls: number;
  daily: Array<{ date: string; completed: number; failed: number; cancelled: number }>;
  topAgents: Array<{ agentId: string; name: string; steps: number; completionTokens: number }>;
  topTools: Array<{ name: string; calls: number }>;
  recentRuns: RunSummary[];
  system: {
    version: string;
    nodeVersion: string;
    platform: string;
    uptimeSec: number;
    memoryMb: number;
    dbSizeBytes: number;
    dataDir: string;
  };
}

export interface WorkspaceFile {
  path: string;
  sizeBytes: number;
  modifiedAt: string;
}

/** Estado real de los dos aislamientos de run_javascript (se comprueba en el servidor, no se supone). */
export interface SandboxStatus {
  process: {
    /** ¿El proceso aislado se queda sin red? Comprobado con una conexión real. */
    networkBlocked: boolean;
    /** 'permission' = lo impide el modelo de permisos de Node; 'lockdown' = lo impide el propio proceso al arrancar. */
    method: 'permission' | 'lockdown';
    nodeVersion: string;
  };
  container: {
    available: boolean;
    engine: 'docker' | 'podman' | null;
    version: string | null;
    image: string;
    imagePresent: boolean;
    error: string | null;
    /** Código y parámetros de `error`, para mostrarlo en otro idioma. */
    errorI18n?: ServerMessage | null;
  };
}

export interface AuthStatus {
  /** ¿El servidor exige clave de acceso? */
  required: boolean;
  authenticated: boolean;
}

// ---------- Copias de seguridad ----------
export interface BackupManifest {
  format: 'agentforge.backup';
  version: 1;
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  counts: { agents: number; workflows: number; runs: number; workspaceFiles: number };
}

export interface BackupInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
  /** null si el archivo no se puede leer (copia dañada). */
  manifest: BackupManifest | null;
}

export interface PendingRestore {
  name: string;
  preparedAt: string;
  manifest: BackupManifest;
}

export interface BackupState {
  backups: BackupInfo[];
  /** Restauración ya validada que se aplicará al reiniciar el servidor. */
  pending: PendingRestore | null;
  /** Última restauración aplicada en un arranque. */
  lastRestore: (PendingRestore & { appliedAt: string; replacedDir: string }) | null;
}
