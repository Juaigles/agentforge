// Esquemas de validación (zod) de los cuerpos de la API.
import { z } from 'zod';
import { DEFAULT_WORKFLOW_SETTINGS } from '../../../shared/types';
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

const nodeSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(['input', 'agent', 'tool', 'condition', 'transform', 'output']),
  label: z.string().max(80).default(''),
  position: z.object({ x: z.number(), y: z.number() }),
  config: z.record(z.string(), z.unknown()).default({}),
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
  retentionDays: z.number().int().min(0).max(3650).optional(),
  retentionMaxRuns: z.number().int().min(0).max(100_000).optional(),
});

export const runIdsSchema = z.object({
  ids: z.array(z.string().min(1)).max(500).optional(),
});

export const invokeToolSchema = z.object({
  args: z.record(z.string(), z.unknown()).default({}),
});
