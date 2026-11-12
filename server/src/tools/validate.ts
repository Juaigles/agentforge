import type { JsonSchema } from '../../../shared/types';
import { msg, type CodedMessage } from '../../../shared/server-messages';
import { ToolError } from '../errors';

/**
 * Valida y normaliza los argumentos de una herramienta contra su esquema.
 * Es tolerante con errores típicos de los LLM ("5" en lugar de 5, "true" en lugar de true).
 */
export function validateArgs(schema: JsonSchema, raw: unknown): Record<string, any> {
  if (raw === null || raw === undefined) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ToolError(msg('toolArgsNotObject'));
  const input = raw as Record<string, unknown>;
  const out: Record<string, any> = {};
  const problems: CodedMessage[] = [];

  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    let value = input[key];
    if (value === undefined || value === null || value === '') {
      if (prop.default !== undefined) value = prop.default;
      else if (schema.required?.includes(key)) {
        // Una cadena vacía es un valor válido para un parámetro obligatorio de tipo string solo si se envió explícitamente.
        if (value === '' && prop.type === 'string') out[key] = '';
        else problems.push(msg('argMissing', { name: key }));
        continue;
      } else continue;
    }

    switch (prop.type) {
      case 'string':
        if (typeof value !== 'string') value = typeof value === 'object' ? JSON.stringify(value) : String(value);
        break;
      case 'number':
      case 'integer': {
        const n = typeof value === 'number' ? value : Number(String(value).trim());
        if (!Number.isFinite(n)) {
          problems.push(msg('argNotNumber', { name: key }));
          continue;
        }
        if (prop.type === 'integer' && !Number.isInteger(n)) {
          problems.push(msg('argNotInteger', { name: key }));
          continue;
        }
        value = n;
        break;
      }
      case 'boolean':
        if (typeof value === 'string' && /^(true|false)$/i.test(value.trim())) value = /^true$/i.test(value.trim());
        if (typeof value !== 'boolean') {
          problems.push(msg('argNotBoolean', { name: key }));
          continue;
        }
        break;
      case 'object':
      case 'array':
        if (typeof value === 'string') {
          try {
            value = JSON.parse(value);
          } catch {
            problems.push(msg('argNotJson', { name: key }));
            continue;
          }
        }
        if (prop.type === 'array' ? !Array.isArray(value) : typeof value !== 'object' || Array.isArray(value)) {
          problems.push(msg('argWrongType', { name: key, type: prop.type }));
          continue;
        }
        break;
    }

    if (prop.enum && !prop.enum.includes(value as string | number)) {
      problems.push(msg('argNotInEnum', { name: key, options: prop.enum.join(', ') }));
      continue;
    }
    out[key] = value;
  }

  if (problems.length) throw new ToolError(msg('toolArgsInvalid', { problems }));
  return out;
}
