// Esquemas de validación (zod) de los cuerpos de la API.
import { z } from 'zod';
import { DEFAULT_WORKFLOW_SETTINGS } from '../../../shared/types';
import { CronError, isValidTimeZone, parseCron } from '../engine/cron';
import { nextOccurrence } from '../engine/scheduler';
import { TOOL_NAME_RE } from '../tools/registry';

const httpUrl = z
  .string()
  .trim()
  .min(1, 'La URL es obligatoria')
  .refine((v) => {
    try {
      return ['http:', 'https:'].includes(new URL(v).protocol);
    } catch {
      return false;
    }
  }, 'Debe ser una URL http(s) válida');

export const providerSchema = z.object({
  name: z.string().trim().min(1, 'El nombre es obligatorio').max(80),
  kind: z.enum(['ollama', 'openai']),
  baseUrl: httpUrl,
  apiKey: z.string().max(500).nullable().optional(),
  defaultModel: z.string().trim().max(200).default(''),
  enabled: z.boolean().default(true),
});

/** Prueba de una configuración sin guardar: `id` indica qué proveedor se está editando (para usar su clave guardada). */
export const providerProbeSchema = providerSchema.extend({ id: z.string().min(1).max(64).optional() });

export const agentSchema = z.object({
  name: z.string().trim().min(1, 'El nombre es obligatorio').max(80),
  role: z.string().trim().max(160).default(''),
  description: z.string().trim().max(1000).default(''),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Color hexadecimal no válido')
    .default('#6366f1'),
  providerId: z.string().min(1, 'Selecciona un proveedor'),
  model: z.string().trim().min(1, 'Selecciona un modelo').max(200),
  systemPrompt: z.string().max(20_000).default(''),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().min(16).max(200_000).nullable().default(null),
  maxIterations: z.number().int().min(1).max(30).default(8),
  tools: z.array(z.string()).max(50).default([]),
  thinking: z.boolean().default(false),
});

/** ¿El valor es del tipo JSON Schema indicado? */
function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    default:
      return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

const jsonSchemaProp = z
  .object({
    type: z.enum(['string', 'number', 'integer', 'boolean', 'object', 'array']),
    description: z.string().max(500).optional(),
    enum: z.array(z.union([z.string(), z.number()])).min(1).max(100).optional(),
    default: z.unknown().optional(),
    items: z.object({ type: z.string() }).optional(),
  })
  .superRefine((prop, ctx) => {
    if (prop.enum) {
      if (!['string', 'number', 'integer'].includes(prop.type)) {
        ctx.addIssue({ code: 'custom', path: ['enum'], message: 'Solo los parámetros de texto o numéricos admiten valores permitidos' });
      } else if (!prop.enum.every((v) => matchesType(prop.type, v))) {
        ctx.addIssue({ code: 'custom', path: ['enum'], message: 'Los valores permitidos deben ser del tipo del parámetro' });
      }
    }
    if (prop.default !== undefined && prop.default !== null) {
      if (!matchesType(prop.type, prop.default)) {
        ctx.addIssue({ code: 'custom', path: ['default'], message: 'El valor por defecto debe ser del tipo del parámetro' });
      } else if (prop.enum && !prop.enum.includes(prop.default as string | number)) {
        ctx.addIssue({ code: 'custom', path: ['default'], message: 'El valor por defecto debe ser uno de los valores permitidos' });
      }
    }
  });

export const customToolSchema = z.object({
  name: z.string().regex(TOOL_NAME_RE, 'Usa minúsculas, números y guiones bajos (2-49 caracteres, empieza por letra)'),
  description: z.string().trim().min(5, 'Describe qué hace la herramienta (el modelo lo usa para decidir)').max(1000),
  parameters: z.object({
    type: z.literal('object'),
    properties: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), jsonSchemaProp),
    required: z.array(z.string()).optional(),
  }),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  urlTemplate: z.string().trim().min(1, 'La URL es obligatoria').max(2000),
  headers: z.record(z.string(), z.string()).default({}),
  bodyTemplate: z.string().max(20_000).default(''),
  enabled: z.boolean().default(true),
});

/** Tope del tiempo máximo de un nodo (6 h): por encima, el temporizador del motor no es representable. */
const MAX_NODE_TIMEOUT_MS = 6 * 3_600_000;

const nodeSchema = z
  .object({
    id: z.string().min(1).max(64),
    type: z.enum(['input', 'agent', 'tool', 'condition', 'transform', 'foreach', 'subworkflow', 'approval', 'output']),
    label: z.string().max(80).default(''),
    position: z.object({ x: z.number(), y: z.number() }),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((node, ctx) => {
    // Límites numéricos de la configuración: un valor absurdo no debe llegar al motor (también al importar).
    const bounded = (key: string, min: number, max: number, what: string) => {
      const value = node.config[key];
      if (value === undefined || value === null || value === '') return;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        ctx.addIssue({ code: 'custom', path: ['config', key], message: `${what} debe ser un número entero entre ${min} y ${max}` });
      }
    };
    bounded('timeoutMs', 0, MAX_NODE_TIMEOUT_MS, 'El tiempo máximo (en milisegundos)');
    bounded('retries', 0, 5, 'El número de reintentos');
    bounded('concurrency', 1, 8, 'El número de elementos a la vez');
    bounded('maxItems', 1, 100, 'El máximo de elementos');
  });

const edgeSchema = z.object({
  id: z.string().min(1).max(200),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().nullable().optional(),
});

export const workflowSettingsSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(16).default(DEFAULT_WORKFLOW_SETTINGS.maxConcurrency),
  maxDurationMs: z.number().int().min(1000).max(6 * 3600_000).default(DEFAULT_WORKFLOW_SETTINGS.maxDurationMs),
  maxLlmCalls: z.number().int().min(1).max(500).default(DEFAULT_WORKFLOW_SETTINGS.maxLlmCalls),
  onError: z.enum(['fail', 'continue']).default(DEFAULT_WORKFLOW_SETTINGS.onError),
  defaultRetries: z.number().int().min(0).max(5).default(DEFAULT_WORKFLOW_SETTINGS.defaultRetries),
});

export const workflowSchema = z.object({
  name: z.string().trim().min(1, 'El nombre es obligatorio').max(120),
  description: z.string().trim().max(2000).default(''),
  nodes: z.array(nodeSchema).max(100),
  edges: z.array(edgeSchema).max(400),
  settings: workflowSettingsSchema.default(DEFAULT_WORKFLOW_SETTINGS),
});

export const triggerSchema = z
  .object({
    kind: z.enum(['interval', 'daily', 'cron', 'webhook']),
    name: z.string().trim().max(80).default(''),
    intervalMinutes: z.number().int().min(1, 'El intervalo mínimo es 1 minuto').max(43_200, 'El intervalo máximo son 30 días').nullable().default(null),
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'La hora debe tener el formato HH:MM')
      .nullable()
      .default(null),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    cron: z.string().trim().max(200).nullable().default(null),
    timezone: z
      .string()
      .trim()
      .max(64)
      .nullable()
      .default(null)
      .transform((v) => v || null),
    input: z.string().max(100_000).default(''),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'interval' && value.intervalMinutes === null) ctx.addIssue({ code: 'custom', path: ['intervalMinutes'], message: 'Indica cada cuántos minutos' });
    if (value.kind === 'daily' && value.time === null) ctx.addIssue({ code: 'custom', path: ['time'], message: 'Indica la hora' });
    if (value.timezone && !isValidTimeZone(value.timezone)) {
      ctx.addIssue({ code: 'custom', path: ['timezone'], message: `«${value.timezone}» no es una zona horaria conocida (ejemplo: Europe/Madrid)` });
      return;
    }
    if (value.kind !== 'cron') return;
    if (!value.cron) return void ctx.addIssue({ code: 'custom', path: ['cron'], message: 'Indica la expresión cron' });
    try {
      parseCron(value.cron);
      if (!nextOccurrence(value, new Date())) ctx.addIssue({ code: 'custom', path: ['cron'], message: 'Esa expresión no se cumple nunca (por ejemplo, un 30 de febrero).' });
    } catch (err) {
      ctx.addIssue({ code: 'custom', path: ['cron'], message: err instanceof CronError ? err.message : 'La expresión cron no es válida.' });
    }
  });

const secretMap = z.record(z.string().trim().min(1).max(100), z.string().max(4000)).refine((v) => Object.keys(v).length <= 30, 'Demasiados valores (máximo 30)');

export const mcpServerSchema = z
  .object({
    name: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{1,19}$/, 'Usa de 2 a 20 letras minúsculas, números o «_», empezando por una letra'),
    transport: z.enum(['stdio', 'http']),
    command: z.string().trim().max(500).default(''),
    args: z.array(z.string().max(2000)).max(50).default([]),
    env: secretMap.optional(),
    url: z.string().trim().max(2000).default(''),
    headers: secretMap.optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.transport === 'stdio' && !value.command) ctx.addIssue({ code: 'custom', path: ['command'], message: 'Indica el programa que arranca el servidor' });
    if (value.transport === 'http' && !httpUrl.safeParse(value.url).success) ctx.addIssue({ code: 'custom', path: ['url'], message: 'Debe ser una URL http(s) válida' });
    for (const key of Object.keys(value.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) ctx.addIssue({ code: 'custom', path: ['env'], message: `«${key}» no es un nombre de variable de entorno válido` });
    }
    for (const [key, v] of Object.entries(value.headers ?? {})) {
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key) || /[\r\n]/.test(v)) ctx.addIssue({ code: 'custom', path: ['headers'], message: `La cabecera «${key}» no es válida` });
    }
  });

const exportedAgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  role: z.string().max(160).default(''),
  description: z.string().max(1000).default(''),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6366f1'),
  model: z.string().max(200).default(''),
  systemPrompt: z.string().max(20_000).default(''),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().min(16).max(200_000).nullable().default(null),
  maxIterations: z.number().int().min(1).max(30).default(8),
  tools: z.array(z.string()).max(50).default([]),
  thinking: z.boolean().default(false),
});

export const workflowImportSchema = z.object({
  format: z.literal('agentforge.workflow', { message: 'El archivo no es un workflow exportado de AgentForge' }),
  version: z.literal(1, { message: 'Versión de archivo no admitida' }),
  workflow: workflowSchema,
  agents: z.array(exportedAgentSchema).max(100).default([]),
});

export const runInputSchema = z.object({
  input: z.string().max(100_000).default(''),
});

export const retrySchema = z.object({
  mode: z.enum(['all', 'failed']).default('all'),
});

export const settingsSchema = z.object({
  maxConcurrentRuns: z.number().int().min(1).max(10).optional(),
  allowPrivateNetwork: z.boolean().optional(),
  allowCodeExecution: z.boolean().optional(),
  codeSandbox: z.enum(['process', 'container']).optional(),
  autoResume: z.boolean().optional(),
  retentionDays: z.number().int().min(0).max(3650).optional(),
  retentionMaxRuns: z.number().int().min(0).max(100_000).optional(),
});

/** Parámetros de consulta del historial. Los valores llegan como texto: se convierten y se acotan aquí. */
export const runsQuerySchema = z.object({
  status: z.enum(['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'], { error: 'estado no reconocido' }).optional(),
  kind: z.enum(['agent', 'workflow'], { error: 'tipo no reconocido' }).optional(),
  workflowId: z.string().max(64).optional(),
  agentId: z.string().max(64).optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce
    .number({ error: 'debe ser un número entero entre 1 y 200' })
    .int('debe ser un número entero entre 1 y 200')
    .min(1, 'debe ser un número entero entre 1 y 200')
    .max(200, 'debe ser un número entero entre 1 y 200')
    .optional(),
  offset: z.coerce
    .number({ error: 'debe ser un número entero mayor o igual que 0' })
    .int('debe ser un número entero mayor o igual que 0')
    .min(0, 'debe ser un número entero mayor o igual que 0')
    .optional(),
});

export const eventsQuerySchema = z.object({
  after: z.coerce.number({ error: 'debe ser un número entero mayor o igual que 0' }).int().min(0).optional(),
});

export const runIdsSchema = z.object({
  ids: z.array(z.string().min(1)).max(500).optional(),
});

export const approvalDecisionSchema = z.object({
  approved: z.boolean({ error: 'Indica si se aprueba o se rechaza' }),
  comment: z.string().trim().max(2000, 'El comentario no puede superar los 2000 caracteres').default(''),
});

export const invokeToolSchema = z.object({
  args: z.record(z.string(), z.unknown()).default({}),
});
