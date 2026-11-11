// Tipos del dominio compartidos entre el servidor y el frontend.

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
  source: 'builtin' | 'custom';
  dangerous: boolean;
  enabled: boolean;
  customId?: string;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CustomTool {
  id: string;
  name: string;
  description: string;
  parameters: JsonSchema;
  method: HttpMethod;
  urlTemplate: string;
  headers: Record<string, string>;
  bodyTemplate: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CustomToolInput = Omit<CustomTool, 'id' | 'createdAt' | 'updatedAt'>;

// ---------- Workflows ----------
export type NodeType = 'input' | 'agent' | 'tool' | 'condition' | 'transform' | 'foreach' | 'output';

export type ConditionOperator =
  | 'contains'
  | 'not_contains'
  | 'equals'
  | 'not_equals'
  | 'matches'
  | 'gt'
  | 'lt'
  | 'is_empty'
  | 'not_empty';

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
/** «Para cada»: ejecuta un agente una vez por cada elemento de una lista, con concurrencia limitada. */
export interface ForeachNodeConfig {
  agentId: string;
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
  message: string;
}

// ---------- Ejecuciones ----------
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';
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
}

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
  usage: Usage;
  retryOf: string | null;
  /** Quedó a medias por un apagado del servidor y aún no se ha reanudado ni descartado. */
  interrupted?: boolean;
  /** La lanzó la programación del workflow, no una persona. */
  scheduled?: boolean;
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
  usage: Usage;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Run extends RunSummary {
  snapshot: RunSnapshot;
  steps: RunStep[];
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
  retentionDays: 0,
  retentionMaxRuns: 0,
};

// ---------- Programación ----------
export type ScheduleKind = 'interval' | 'daily';

/** Programación de un workflow: cada N minutos o todos los días a una hora (hora local del servidor). */
export interface Schedule {
  workflowId: string;
  kind: ScheduleKind;
  /** Solo en 'interval'. */
  intervalMinutes: number | null;
  /** Solo en 'daily': "HH:MM". */
  time: string | null;
  /** Texto de entrada con el que se lanza cada ejecución. */
  input: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunId: string | null;
  /** Motivo por el que la última cita no llegó a lanzarse (workflow con errores, solape…). */
  lastError: string | null;
}

export type ScheduleInput = Pick<Schedule, 'kind' | 'intervalMinutes' | 'time' | 'input' | 'enabled'>;

// ---------- Exportación / importación ----------
export const WORKFLOW_EXPORT_FORMAT = 'agentforge.workflow';

/** Agente tal como viaja en un archivo exportado (sin el proveedor: se reasigna al importar). */
export type ExportedAgent = Pick<
  Agent,
  'id' | 'name' | 'role' | 'description' | 'color' | 'model' | 'systemPrompt' | 'temperature' | 'maxTokens' | 'maxIterations' | 'tools' | 'thinking'
>;

export interface WorkflowExport {
  format: typeof WORKFLOW_EXPORT_FORMAT;
  version: 1;
  exportedAt: string;
  workflow: WorkflowInput;
  /** Agentes que usan los nodos del workflow. */
  agents: ExportedAgent[];
}

export interface WorkflowImportResult {
  workflow: Workflow;
  /** Agentes creados porque no existían (ni por id ni por nombre). */
  createdAgents: Agent[];
  /** Agentes del archivo que se han enlazado con uno ya existente. */
  reusedAgents: Agent[];
  /** Avisos de la importación (herramientas que no existen aquí, agentes sin proveedor…). */
  warnings: string[];
  /** Problemas de validación del workflow importado. */
  issues: ValidationIssue[];
}

export interface ProviderHealth {
  providerId: string;
  name: string;
  kind: ProviderKind;
  ok: boolean;
  latencyMs: number;
  modelCount: number;
  error?: string;
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
  };
}

export interface AuthStatus {
  /** ¿El servidor exige clave de acceso? */
  required: boolean;
  authenticated: boolean;
}
