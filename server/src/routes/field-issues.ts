// Problemas de validación de un formulario o de unos parámetros, con código y parámetros para mostrarlos en otro idioma.
import type { ZodError } from 'zod';
import { msg, refOf, type CodedMessage, type ServerCode, type ServerMessage, type TextParams } from '../../../shared/server-messages';

/** Un campo que no cumple el esquema: su ruta, el texto en español y el código con sus parámetros. */
export interface FieldIssue {
  path: string;
  message: string;
  code: ServerCode;
  params?: TextParams;
}

// zod solo admite un texto como mensaje de un esquema: en él viaja, marcado, el código (y los parámetros que el
// propio esquema conoce), y `fieldIssues` lo convierte en el texto en español al responder.
const MARK = '\u0001msg:';

/** Mensaje propio de un esquema, por su código en shared/server-messages.ts. */
export function coded(code: ServerCode, params: TextParams = {}): string {
  return `${MARK}${JSON.stringify({ code, params })}`;
}

type ZodIssue = ZodError['issues'][number];

/** Código de un problema que zod detecta sin mensaje propio (longitudes, rangos, tipos, opciones…). */
function generic(issue: ZodIssue): CodedMessage {
  const any = issue as unknown as Record<string, unknown>;
  const sized = any.origin === 'string' ? 'text' : any.origin === 'array' || any.origin === 'set' || any.origin === 'map' ? 'list' : 'number';
  switch (issue.code) {
    case 'too_small': {
      const min = Number(any.minimum);
      if (sized === 'text') return min <= 1 ? msg('required') : msg('tooShort', { min });
      return sized === 'list' ? msg('tooFewItems', { min }) : msg('tooSmall', { min });
    }
    case 'too_big': {
      const max = Number(any.maximum);
      return sized === 'text' ? msg('tooLong', { max }) : sized === 'list' ? msg('tooManyItems', { max }) : msg('tooBig', { max });
    }
    case 'invalid_type':
      // Sin el dato de entrada (zod no lo incluye), un campo que falta se reconoce por su mensaje por defecto.
      return /received undefined$/.test(issue.message) ? msg('required') : msg('invalidType', { expected: String(any.expected) });
    case 'invalid_value':
      return Array.isArray(any.values) && any.values.length ? msg('invalidOption', { options: any.values.map(String).join(', ') }) : msg('invalidValue');
    case 'invalid_format':
      return msg('invalidFormat');
    case 'unrecognized_keys':
      return msg('unknownKeys', { keys: Array.isArray(any.keys) ? any.keys.map(String).join(', ') : '' });
    default:
      return msg('invalidValue');
  }
}

function codedIssue(issue: ZodIssue): CodedMessage {
  if (!issue.message.startsWith(MARK)) return generic(issue);
  const { code, params } = JSON.parse(issue.message.slice(MARK.length)) as { code: ServerCode; params: TextParams };
  // Los problemas añadidos a mano (`ctx.addIssue`) traen sus parámetros en `params`.
  const extra = (issue as { params?: TextParams }).params ?? {};
  return msg(code, { ...params, ...extra });
}

/** Los problemas de una validación fallida, uno por campo que no cumple. */
export function fieldIssues(err: ZodError): FieldIssue[] {
  return err.issues.map((issue) => {
    const text = codedIssue(issue);
    const params = text.params as TextParams;
    return { path: issue.path.join('.'), message: text.message, code: text.code, ...(Object.keys(params).length ? { params } : {}) };
  });
}

/** La frase que resume la validación (con el primer problema), y su referencia para traducirla. */
export function validationSummary(issues: FieldIssue[]): { error: string; i18n: ServerMessage } {
  const first = issues[0];
  if (!first) return { error: msg('invalidData').message, i18n: refOf(msg('invalidData')) };
  const detail = { code: first.code, params: first.params, message: first.message };
  const text = first.path ? msg('invalidDataField', { path: first.path, detail }) : msg('invalidDataDetail', { detail });
  return { error: text.message, i18n: refOf(text) };
}
