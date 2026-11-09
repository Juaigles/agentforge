import type { JsonSchema, Settings } from '../../../shared/types';

/** Contexto que recibe cada herramienta al ejecutarse. */
export interface ToolContext {
  runId: string;
  nodeId: string;
  signal: AbortSignal;
  /** Directorio aislado donde las herramientas de archivos pueden leer y escribir. */
  workspaceDir: string;
  settings: Settings;
  /** Memoria compartida entre todos los agentes de una misma ejecución. */
  memory: Map<string, string>;
  agentName?: string;
  /** Delega una tarea en otro agente (solo disponible dentro de una ejecución de agente). */
  delegate?: (agent: string, task: string) => Promise<string>;
}

/**
 * Contrato de una herramienta. Para añadir una nueva basta con crear un objeto que lo cumpla
 * y registrarlo con `registry.register(...)` (ver tools/builtin.ts).
 */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  category: string;
  parameters: JsonSchema;
  dangerous?: boolean;
  execute(args: Record<string, any>, ctx: ToolContext): Promise<unknown>;
}
