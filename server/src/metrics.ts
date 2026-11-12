// Métricas en el formato de texto de Prometheus (GET /api/metrics). Son las mismas cifras que enseña el panel,
// más las del proceso y un recuento de respuestas HTTP: sirven para vigilar una instalación sin abrir la interfaz.

/** Recuento de respuestas HTTP de la API por clase de estado, desde que arrancó el proceso. */
export class HttpCounters {
  private readonly byClass = new Map<string, number>();

  record(statusCode: number): void {
    const key = `${Math.floor(statusCode / 100)}xx`;
    this.byClass.set(key, (this.byClass.get(key) ?? 0) + 1);
  }

  snapshot(): Array<[statusClass: string, count: number]> {
    return [...this.byClass.entries()].sort(([a], [b]) => a.localeCompare(b));
  }
}

export interface MetricsInput {
  version: string;
  nodeVersion: string;
  uptimeSec: number;
  schemaVersion: number;
  counts: { agents: number; workflows: number; providers: number; tools: number; runs: number };
  runsByStatus: Record<string, number>;
  activeRuns: number;
  queuedRuns: number;
  llmCalls: number;
  toolCalls: number;
  tokens: { prompt: number; completion: number };
  memoryBytes: number;
  dbSizeBytes: number;
  schedulerRunning: boolean;
  http: Array<[statusClass: string, count: number]>;
}

type Sample = { labels?: Record<string, string>; value: number };

/** Los valores de las etiquetas se escapan como pide el formato (barra invertida, comillas y saltos de línea). */
const escapeLabel = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

function metric(name: string, type: 'gauge' | 'counter', help: string, samples: Sample[]): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const { labels, value } of samples) {
    const pairs = Object.entries(labels ?? {}).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
    lines.push(`${name}${pairs.length ? `{${pairs.join(',')}}` : ''} ${Number.isFinite(value) ? value : 0}`);
  }
  return lines.join('\n');
}

/** Texto de las métricas. Los contadores (`_total`) no bajan al borrar historial; los demás son el valor actual. */
export function renderMetrics(m: MetricsInput): string {
  const one = (value: number): Sample[] => [{ value }];
  return (
    [
      metric('agentforge_info', 'gauge', 'Versión de AgentForge, de Node y del esquema de la base de datos.', [
        { labels: { version: m.version, node: m.nodeVersion, schema: String(m.schemaVersion) }, value: 1 },
      ]),
      metric('agentforge_uptime_seconds', 'gauge', 'Segundos desde que arrancó el servidor.', one(m.uptimeSec)),
      metric('agentforge_runs', 'gauge', 'Ejecuciones guardadas en el historial, por estado.', [
        ...Object.entries(m.runsByStatus)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([status, value]) => ({ labels: { status }, value })),
      ]),
      metric('agentforge_runs_active', 'gauge', 'Ejecuciones en marcha ahora mismo.', one(m.activeRuns)),
      metric('agentforge_runs_queued', 'gauge', 'Ejecuciones esperando en la cola.', one(m.queuedRuns)),
      metric('agentforge_llm_calls_total', 'counter', 'Llamadas a modelos de lenguaje (acumulado).', one(m.llmCalls)),
      metric('agentforge_tool_calls_total', 'counter', 'Llamadas a herramientas (acumulado).', one(m.toolCalls)),
      metric('agentforge_tokens_total', 'counter', 'Tokens consumidos (acumulado), por tipo.', [
        { labels: { kind: 'prompt' }, value: m.tokens.prompt },
        { labels: { kind: 'completion' }, value: m.tokens.completion },
      ]),
      metric('agentforge_agents', 'gauge', 'Agentes definidos.', one(m.counts.agents)),
      metric('agentforge_workflows', 'gauge', 'Workflows definidos.', one(m.counts.workflows)),
      metric('agentforge_providers', 'gauge', 'Proveedores de modelos configurados.', one(m.counts.providers)),
      metric('agentforge_tools_enabled', 'gauge', 'Herramientas activas en el catálogo.', one(m.counts.tools)),
      metric('agentforge_scheduler_running', 'gauge', 'El planificador de disparadores está en marcha (1) o no (0).', one(m.schedulerRunning ? 1 : 0)),
      metric('agentforge_process_resident_memory_bytes', 'gauge', 'Memoria residente del proceso, en bytes.', one(m.memoryBytes)),
      metric('agentforge_db_size_bytes', 'gauge', 'Tamaño de la base de datos y de su diario, en bytes.', one(m.dbSizeBytes)),
      metric(
        'agentforge_http_responses_total',
        'counter',
        'Respuestas de la API desde que arrancó el proceso, por clase de estado.',
        m.http.map(([statusClass, value]) => ({ labels: { class: statusClass }, value })),
      ),
    ].join('\n') + '\n'
  );
}
