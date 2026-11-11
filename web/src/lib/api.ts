// Cliente tipado de la API de AgentForge.
import { ref } from 'vue';
import type {
  Agent,
  AgentInput,
  AuthStatus,
  CustomTool,
  CustomToolInput,
  DashboardStats,
  ModelInfo,
  Provider,
  ProviderHealth,
  ProviderInput,
  ProviderTestResult,
  Run,
  RunEvent,
  RunKind,
  RunStatus,
  RunSummary,
  SandboxStatus,
  Schedule,
  ScheduleInput,
  Settings,
  ToolInfo,
  ValidationIssue,
  Workflow,
  WorkflowExport,
  WorkflowImportResult,
  WorkflowInput,
  WorkspaceFile,
} from '@shared/types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: Array<{ path: string; message: string }> = [],
    readonly details?: { issues?: ValidationIssue[] },
  ) {
    super(message);
    this.name = 'ApiError';
  }
  /** Mensaje de validación del campo indicado, si lo hay. */
  field(path: string): string | undefined {
    return this.issues.find((i) => i.path === path)?.message;
  }
}

/** true cuando el servidor ha rechazado una petición por falta de clave de acceso: la aplicación muestra la pantalla de entrada. */
export const authRequired = ref(false);

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('No se pudo conectar con el servidor de AgentForge. ¿Está en marcha?', 0);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* respuesta no JSON (p. ej. el proxy cuando la API está caída) */
  }
  if (res.status === 401 && json?.code === 'auth_required') authRequired.value = true;
  if (!res.ok) {
    const message = json?.error ?? (res.status >= 500 ? 'El servidor de AgentForge no responde.' : `Error ${res.status}`);
    throw new ApiError(message, res.status, json?.issues ?? [], json?.details);
  }
  return json as T;
}

const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, body: unknown = {}) => request<T>('POST', path, body);
const put = <T>(path: string, body: unknown) => request<T>('PUT', path, body);
const del = <T = void>(path: string) => request<T>('DELETE', path);

export interface RunQuery {
  status?: RunStatus | '';
  kind?: RunKind | '';
  workflowId?: string;
  agentId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ToolInvokeResult {
  ok: boolean;
  durationMs: number;
  result?: string;
  error?: string;
}

export const api = {
  health: () => get<{ ok: boolean; version: string; uptimeSec: number }>('/api/health'),
  stats: () => get<DashboardStats>('/api/stats'),
  auth: {
    status: () => get<AuthStatus>('/api/auth/status'),
    login: (token: string) => post<void>('/api/auth/login', { token }),
    logout: () => post<void>('/api/auth/logout'),
  },
  settings: {
    get: () => get<Settings>('/api/settings'),
    update: (patch: Partial<Settings>) => put<Settings>('/api/settings', patch),
  },
  /** Estado real de los dos aislamientos de run_javascript. */
  sandboxStatus: (force = false) => get<SandboxStatus>(`/api/sandbox/status${force ? '?force=1' : ''}`),
  providers: {
    list: () => get<Provider[]>('/api/providers'),
    create: (input: ProviderInput) => post<Provider>('/api/providers', input),
    update: (id: string, input: ProviderInput) => put<Provider>(`/api/providers/${id}`, input),
    remove: (id: string) => del(`/api/providers/${id}`),
    test: (id: string) => post<ProviderTestResult>(`/api/providers/${id}/test`),
    testConfig: (input: ProviderInput & { id?: string }) => post<ProviderTestResult>('/api/providers/test', input),
    models: (id: string) => get<ModelInfo[]>(`/api/providers/${id}/models`),
    /** Modelos de una configuración aún sin guardar (con `id`, usa la clave guardada si no se envía otra). */
    modelsOf: (input: ProviderInput & { id?: string }) => post<ModelInfo[]>('/api/providers/models', input),
    health: (force = false) => get<ProviderHealth[]>(`/api/providers/health${force ? '?force=1' : ''}`),
  },
  agents: {
    list: () => get<Agent[]>('/api/agents'),
    get: (id: string) => get<Agent>(`/api/agents/${id}`),
    create: (input: AgentInput) => post<Agent>('/api/agents', input),
    update: (id: string, input: AgentInput) => put<Agent>(`/api/agents/${id}`, input),
    duplicate: (id: string) => post<Agent>(`/api/agents/${id}/duplicate`),
    remove: (id: string) => del(`/api/agents/${id}`),
    run: (id: string, input: string) => post<Run>(`/api/agents/${id}/run`, { input }),
  },
  tools: {
    list: () => get<ToolInfo[]>('/api/tools'),
    getCustom: (id: string) => get<CustomTool>(`/api/tools/custom/${id}`),
    createCustom: (input: CustomToolInput) => post<CustomTool>('/api/tools/custom', input),
    updateCustom: (id: string, input: CustomToolInput) => put<CustomTool>(`/api/tools/custom/${id}`, input),
    removeCustom: (id: string) => del(`/api/tools/custom/${id}`),
    invoke: (name: string, args: Record<string, unknown>) => post<ToolInvokeResult>(`/api/tools/${name}/invoke`, { args }),
  },
  workspace: {
    files: () => get<WorkspaceFile[]>('/api/workspace/files'),
    read: (path: string) =>
      get<{ path: string; sizeBytes: number; content: string; truncated: boolean }>(
        `/api/workspace/file?path=${encodeURIComponent(path)}`,
      ),
    remove: (path: string) => del(`/api/workspace/file?path=${encodeURIComponent(path)}`),
  },
  workflows: {
    list: () => get<Workflow[]>('/api/workflows'),
    get: (id: string) => get<Workflow>(`/api/workflows/${id}`),
    create: (input: WorkflowInput) => post<Workflow>('/api/workflows', input),
    update: (id: string, input: WorkflowInput) => put<Workflow>(`/api/workflows/${id}`, input),
    duplicate: (id: string) => post<Workflow>(`/api/workflows/${id}/duplicate`),
    remove: (id: string) => del(`/api/workflows/${id}`),
    run: (id: string, input: string) => post<Run>(`/api/workflows/${id}/run`, { input }),
    /** Archivo portable: la definición y los agentes que usa. */
    export: (id: string) => get<WorkflowExport>(`/api/workflows/${id}/export`),
    import: (bundle: unknown) => post<WorkflowImportResult>('/api/workflows/import', bundle),
    schedule: {
      get: (id: string) => get<Schedule | null>(`/api/workflows/${id}/schedule`),
      save: (id: string, input: ScheduleInput) => put<Schedule>(`/api/workflows/${id}/schedule`, input),
      remove: (id: string) => del(`/api/workflows/${id}/schedule`),
      runNow: (id: string) => post<Run>(`/api/workflows/${id}/schedule/run`),
    },
  },
  schedules: {
    list: () => get<Schedule[]>('/api/schedules'),
  },
  runs: {
    list: (q: RunQuery = {}) => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') params.set(k, String(v));
      return get<{ items: RunSummary[]; total: number }>(`/api/runs?${params}`);
    },
    get: (id: string) => get<Run>(`/api/runs/${id}`),
    events: (id: string, after = 0) => get<RunEvent[]>(`/api/runs/${id}/events?after=${after}`),
    cancel: (id: string) => post<{ ok: boolean }>(`/api/runs/${id}/cancel`),
    retry: (id: string, mode: 'all' | 'failed') => post<Run>(`/api/runs/${id}/retry`, { mode }),
    remove: (id: string) => del(`/api/runs/${id}`),
    clearFinished: () => del<{ deleted: number }>('/api/runs'),
    /** Ejecuciones que un apagado del servidor dejó a medias y siguen pendientes de reanudar o descartar. */
    interrupted: () => get<RunSummary[]>('/api/runs/interrupted'),
    resumeInterrupted: (ids?: string[]) => post<Run[]>('/api/runs/interrupted/resume', ids ? { ids } : {}),
    dismissInterrupted: (ids?: string[]) => post<{ dismissed: number }>('/api/runs/interrupted/dismiss', ids ? { ids } : {}),
  },
};

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
