// Esquemas de validación (zod) de los cuerpos de la API.
import { z } from 'zod';
import type { TextParams } from '../../../shared/server-messages';
import { DEFAULT_WORKFLOW_SETTINGS } from '../../../shared/types';
import { CronError, isValidTimeZone, parseCron } from '../engine/cron';
import { nextOccurrence } from '../engine/scheduler';
import { TOOL_NAME_RE } from '../tools/registry';
import { coded } from './field-issues';

const httpUrl = z
  .string()
  .trim()
  .min(1, coded('urlRequired'))
  .refine((v) => {
    try {
      return ['http:', 'https:'].includes(new URL(v).protocol);
    } catch {
      return false;
    }
  }, coded('urlInvalid'));

export const providerSchema = z.object({
  name: z.string().trim().min(1, coded('nameRequired')).max(80),
  kind: z.enum(['ollama', 'openai']),
  baseUrl: httpUrl,
  apiKey: z.string().max(500).nullable().optional(),
  defaultModel: z.string().trim().max(200).default(''),
  enabled: z.boolean().default(true),
});

/** Prueba de una configuración sin guardar: `id` indica qué proveedor se está editando (para usar su clave guardada). */
export const providerProbeSchema = providerSchema.extend({ id: z.string().min(1).max(64).optional() });

export const agentSchema = z.object({
  name: z.string().trim().min(1, coded('nameRequired')).max(80),
  role: z.string().trim().max(160).default(''),
  description: z.string().trim().max(1000).default(''),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, coded('colorInvalid'))
    .default('#6366f1'),
  providerId: z.string().min(1, coded('providerRequired')),
  model: z.string().trim().min(1, coded('modelRequired')).max(200),
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
    enum: z
      .array(z.union([z.string(), z.number()]))
      .min(1)
      .max(100)
      .optional(),
    default: z.unknown().optional(),
    items: z.object({ type: z.string() }).optional(),
  })
  .superRefine((prop, ctx) => {
    if (prop.enum) {
      if (!['string', 'number', 'integer'].includes(prop.type)) {
        ctx.addIssue({ code: 'custom', path: ['enum'], message: coded('enumNeedsScalar') });
      } else if (!prop.enum.every((v) => matchesType(prop.type, v))) {
        ctx.addIssue({ code: 'custom', path: ['enum'], message: coded('enumTypeMismatch') });
      }
    }
    if (prop.default !== undefined && prop.default !== null) {
      if (!matchesType(prop.type, prop.default)) {
        ctx.addIssue({ code: 'custom', path: ['default'], message: coded('defaultTypeMismatch') });
      } else if (prop.enum && !prop.enum.includes(prop.default as string | number)) {
        ctx.addIssue({ code: 'custom', path: ['default'], message: coded('defaultNotInEnum') });
      }
    }
  });

export const customToolSchema = z.object({
  name: z.string().regex(TOOL_NAME_RE, coded('toolNameInvalid')),
  description: z.string().trim().min(5, coded('toolDescriptionRequired')).max(1000),
  parameters: z.object({
    type: z.literal('object'),
    properties: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), jsonSchemaProp),
    required: z.array(z.string()).optional(),
  }),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  urlTemplate: z.string().trim().min(1, coded('urlRequired')).max(2000),
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
    const bounded = (key: string, min: number, max: number) => {
      const value = node.config[key];
      if (value === undefined || value === null || value === '') return;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        ctx.addIssue({ code: 'custom', path: ['config', key], message: coded('nodeConfigRange', { field: key, min, max }) });
      }
    };
    bounded('timeoutMs', 0, MAX_NODE_TIMEOUT_MS);
    bounded('retries', 0, 5);
    bounded('concurrency', 1, 8);
    bounded('maxItems', 1, 100);
  });

const edgeSchema = z.object({
  id: z.string().min(1).max(200),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().nullable().optional(),
});

export const workflowSettingsSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(16).default(DEFAULT_WORKFLOW_SETTINGS.maxConcurrency),
  maxDurationMs: z
    .number()
    .int()
    .min(1000)
    .max(6 * 3600_000)
    .default(DEFAULT_WORKFLOW_SETTINGS.maxDurationMs),
  maxLlmCalls: z.number().int().min(1).max(500).default(DEFAULT_WORKFLOW_SETTINGS.maxLlmCalls),
  onError: z.enum(['fail', 'continue']).default(DEFAULT_WORKFLOW_SETTINGS.onError),
  defaultRetries: z.number().int().min(0).max(5).default(DEFAULT_WORKFLOW_SETTINGS.defaultRetries),
});

export const workflowSchema = z.object({
  name: z.string().trim().min(1, coded('nameRequired')).max(120),
  description: z.string().trim().max(2000).default(''),
  nodes: z.array(nodeSchema).max(100),
  edges: z.array(edgeSchema).max(400),
  settings: workflowSettingsSchema.default(DEFAULT_WORKFLOW_SETTINGS),
});

export const triggerSchema = z
  .object({
    kind: z.enum(['interval', 'daily', 'cron', 'webhook']),
    name: z.string().trim().max(80).default(''),
    intervalMinutes: z.number().int().min(1, coded('intervalMin')).max(43_200, coded('intervalMax')).nullable().default(null),
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, coded('timeFormat'))
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
    if (value.kind === 'interval' && value.intervalMinutes === null)
      ctx.addIssue({ code: 'custom', path: ['intervalMinutes'], message: coded('intervalRequired') });
    if (value.kind === 'daily' && value.time === null) ctx.addIssue({ code: 'custom', path: ['time'], message: coded('timeRequired') });
    if (value.timezone && !isValidTimeZone(value.timezone)) {
      ctx.addIssue({ code: 'custom', path: ['timezone'], message: coded('timezoneUnknown', { timezone: value.timezone }) });
      return;
    }
    if (value.kind !== 'cron') return;
    if (!value.cron) return void ctx.addIssue({ code: 'custom', path: ['cron'], message: coded('cronRequired') });
    try {
      parseCron(value.cron);
      if (!nextOccurrence(value, new Date())) ctx.addIssue({ code: 'custom', path: ['cron'], message: coded('cronNever') });
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        path: ['cron'],
        message: err instanceof CronError ? coded(err.text.code, err.text.params as TextParams) : coded('cronInvalid'),
      });
    }
  });

const secretMap = z
  .record(z.string().trim().min(1).max(100), z.string().max(4000))
  .refine((v) => Object.keys(v).length <= 30, coded('tooManyValues', { max: 30 }));

export const mcpServerSchema = z
  .object({
    name: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{1,19}$/, coded('mcpNameInvalid')),
    transport: z.enum(['stdio', 'http']),
    command: z.string().trim().max(500).default(''),
    args: z.array(z.string().max(2000)).max(50).default([]),
    env: secretMap.optional(),
    url: z.string().trim().max(2000).default(''),
    headers: secretMap.optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.transport === 'stdio' && !value.command) ctx.addIssue({ code: 'custom', path: ['command'], message: coded('mcpCommandRequired') });
    if (value.transport === 'http' && !httpUrl.safeParse(value.url).success) ctx.addIssue({ code: 'custom', path: ['url'], message: coded('urlInvalid') });
    for (const key of Object.keys(value.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) ctx.addIssue({ code: 'custom', path: ['env'], message: coded('envNameInvalid', { name: key }) });
    }
    for (const [key, v] of Object.entries(value.headers ?? {})) {
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key) || /[\r\n]/.test(v))
        ctx.addIssue({ code: 'custom', path: ['headers'], message: coded('headerInvalid', { name: key }) });
    }
  });

const exportedAgentSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(80),
  role: z.string().max(160).default(''),
  description: z.string().max(1000).default(''),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#6366f1'),
  model: z.string().max(200).default(''),
  systemPrompt: z.string().max(20_000).default(''),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().min(16).max(200_000).nullable().default(null),
  maxIterations: z.number().int().min(1).max(30).default(8),
  tools: z.array(z.string()).max(50).default([]),
  thinking: z.boolean().default(false),
  provider: z.string().max(80).optional(),
});

const exportedProviderSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['ollama', 'openai']),
  baseUrl: httpUrl,
  defaultModel: z.string().max(200).default(''),
});

const exportedToolSchema = customToolSchema.extend({ secretHeaders: z.array(z.string().max(200)).max(50).default([]) });

const bundleVersion = z.union([z.literal(1), z.literal(2)], { message: coded('bundleVersionUnsupported') });

/** Archivo de workflow exportado (versiones 1 y 2). */
export const workflowImportSchema = z.object({
  format: z.literal('agentforge.workflow', { message: coded('notWorkflowBundle') }),
  version: bundleVersion,
  workflow: workflowSchema,
  agents: z.array(exportedAgentSchema).max(100).default([]),
  providers: z.array(exportedProviderSchema).max(20).default([]),
  tools: z.array(exportedToolSchema).max(100).default([]),
  subworkflows: z
    .array(z.object({ id: z.string().min(1).max(64), workflow: workflowSchema }))
    .max(20)
    .default([]),
  triggers: z.array(triggerSchema).max(20).default([]),
});

/** Archivo de agentes sueltos. */
export const agentImportSchema = z.object({
  format: z.literal('agentforge.agent'),
  version: bundleVersion,
  agents: z.array(exportedAgentSchema).min(1, coded('bundleNoAgents')).max(100),
  providers: z.array(exportedProviderSchema).max(20).default([]),
  tools: z.array(exportedToolSchema).max(100).default([]),
});

export const importDecisionsSchema = z
  .record(z.string().max(200), z.object({ action: z.enum(['create', 'reuse', 'replace', 'skip']), targetId: z.string().max(64).optional() }))
  .default({});

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
/** Instante ISO 8601 con zona (`Z` o desplazamiento); se normaliza a UTC, que es como se guardan las fechas. */
const instantSchema = z.iso.datetime({ offset: true, error: coded('instantInvalid') }).transform((value) => new Date(value).toISOString());

const LIMIT_ERROR = coded('intBetween', { min: 1, max: 200 });
const SEQ_ERROR = coded('intAtLeast', { min: 0 });

export const runsQuerySchema = z.object({
  // `active` no es un estado: reúne los de una ejecución sin terminar (en cola, en curso y en espera).
  status: z.enum(['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'active'], { error: coded('statusUnknown') }).optional(),
  kind: z.enum(['agent', 'workflow'], { error: coded('kindUnknown') }).optional(),
  workflowId: z.string().max(64).optional(),
  agentId: z.string().max(64).optional(),
  from: instantSchema.optional(),
  to: instantSchema.optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number({ error: LIMIT_ERROR }).int(LIMIT_ERROR).min(1, LIMIT_ERROR).max(200, LIMIT_ERROR).optional(),
  offset: z.coerce.number({ error: SEQ_ERROR }).int(SEQ_ERROR).min(0, SEQ_ERROR).optional(),
});

const seqSchema = z.coerce.number({ error: SEQ_ERROR }).int(SEQ_ERROR).min(0, SEQ_ERROR);
/** Máximo de eventos que se entregan en una página. */
export const EVENTS_PAGE_MAX = 1000;
const EVENTS_LIMIT_ERROR = coded('intBetween', { min: 1, max: EVENTS_PAGE_MAX });

/** Eventos de una ejecución: cursor por número de secuencia (`after`, `before`) y tamaño de página (`limit`). */
export const eventsQuerySchema = z.object({
  after: seqSchema.optional(),
  before: seqSchema.optional(),
  limit: z.coerce.number({ error: EVENTS_LIMIT_ERROR }).int(EVENTS_LIMIT_ERROR).min(1, EVENTS_LIMIT_ERROR).max(EVENTS_PAGE_MAX, EVENTS_LIMIT_ERROR).optional(),
});

/** Punto desde el que se reproduce el flujo en vivo de una ejecución: `?after=` y la cabecera `Last-Event-ID`. */
export const streamQuerySchema = z.object({ after: seqSchema.optional() });
export const lastEventIdSchema = z.object({ 'last-event-id': seqSchema.optional() });

export const runIdsSchema = z.object({
  ids: z.array(z.string().min(1)).max(500).optional(),
});

export const approvalDecisionSchema = z.object({
  approved: z.boolean({ error: coded('approvalDecisionRequired') }),
  comment: z
    .string()
    .trim()
    .max(2000, coded('commentTooLong', { max: 2000 }))
    .default(''),
});

export const invokeToolSchema = z.object({
  args: z.record(z.string(), z.unknown()).default({}),
});
