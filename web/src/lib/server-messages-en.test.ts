import { msg, refOf, SERVER_MESSAGES, type ServerCode } from '@shared/server-messages';
import { VALIDATION_MESSAGES } from '@shared/validation-messages';
import { describe, expect, it } from 'vitest';
import { setLocale } from '@/i18n';
import { SERVER_EN, serverText } from './server-messages-en';

// Un valor reconocible por cada parámetro que usan los textos.
const SAMPLE = {
  name: 'NOMBREX',
  names: 'NOMBRESX',
  min: 471,
  max: 987,
  expected: 'ESPERADOX',
  options: 'OPCIONESX',
  keys: 'CLAVESX',
  field: 'CAMPOX',
  timezone: 'ZONAX',
  value: 'VALORX',
  path: 'RUTAX',
  detail: 'DETALLEX',
  kind: 'CLASEX',
  seconds: 653,
  count: 239,
  headers: 'CABECERASX',
  action: 'ACCIONX',
  actions: 'ACCIONESX',
  version: 811,
  supported: 823,
  cause: 'CAUSAX',
  ms: 761,
  type: 'TIPOX',
  left: 'IZQUIERDAX',
  right: 'DERECHAX',
  operator: 'OPERADORX',
  index: 547,
  total: 563,
  item: 'ELEMENTOX',
  pattern: 'PATRONX',
  model: 'MODELOX',
  label: 'ETIQUETAX',
  origin: 'ORIGENX',
  status: 599,
  statusText: 'ESTADOX',
  problems: 'PROBLEMASX',
  mb: 617,
  position: 631,
  text: 'TEXTOX',
  symbol: 'SIMBOLOX',
  url: 'URLX',
  protocol: 'PROTOCOLOX',
  host: 'HOSTX',
  target: 'DESTINOX',
  engine: 'MOTORX',
  image: 'IMAGENX',
  localUrl: 'URLLOCALX',
  fileUrl: 'URLARCHIVOX',
  localHost: 'HOSTLOCALX',
  fileHost: 'HOSTARCHIVOX',
  method: 'METODOX',
  tools: 'HERRAMIENTASX',
  tool: 'HERRAMIENTAX',
  node: 'NODOX',
  workflow: 'WORKFLOWX',
  args: 'ARGUMENTOSX',
  os: 'SISTEMAX',
};
const codes = Object.keys(SERVER_MESSAGES) as ServerCode[];
const SPANISH_LETTERS = /[áéíóúüñÁÉÍÓÚÜÑ¿¡«»]/;

const inEnglish = <T>(body: () => T): T => {
  setLocale('en', false);
  try {
    return body();
  } finally {
    setLocale('es', false);
  }
};

describe('textos del servidor en inglés', () => {
  it('tiene exactamente los códigos de la tabla en español: todo código que emite el servidor tiene texto en los dos idiomas', () => {
    expect(Object.keys(SERVER_EN).sort()).toEqual([...codes].sort());
    expect(codes.length).toBeGreaterThan(200);
  });

  it('cada mensaje usa los mismos parámetros que el español, no deja ninguno sin rellenar y no conserva texto en español', () => {
    const problems: string[] = [];
    for (const code of codes) {
      const es = SERVER_MESSAGES[code](SAMPLE);
      const en = SERVER_EN[code](SAMPLE);
      if (en.includes('undefined') || es.includes('undefined')) problems.push(`${code}: parámetro sin rellenar`);
      if (!en.trim()) problems.push(`${code}: texto vacío`);
      if (SPANISH_LETTERS.test(en)) problems.push(`${code}: el inglés lleva letras o comillas del español`);
      for (const value of Object.values(SAMPLE).map(String)) {
        if (es.includes(value) !== en.includes(value)) problems.push(`${code}: «${value}» ${es.includes(value) ? 'falta en inglés' : 'sobra en inglés'}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('los textos que dependen de una clave (lo que no se encuentra, el campo de un cron, el límite de un nodo) están en los dos idiomas', () => {
    const keyed: Array<[code: ServerCode, param: string, keys: string[]]> = [
      ['notFound', 'kind', ['provider', 'agent', 'tool', 'mcpServer', 'file', 'workflow', 'trigger', 'run', 'approval', 'backup', 'route']],
      ['cronEmptyItem', 'field', ['minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek']],
      ['nodeConfigRange', 'field', ['timeoutMs', 'retries', 'concurrency', 'maxItems']],
    ];
    for (const [code, param, keys] of keyed) {
      const fallback = { es: SERVER_MESSAGES[code]({ ...SAMPLE, [param]: 'desconocido' }), en: SERVER_EN[code]({ ...SAMPLE, [param]: 'desconocido' }) };
      for (const key of keys) {
        const es = SERVER_MESSAGES[code]({ ...SAMPLE, [param]: key });
        const en = SERVER_EN[code]({ ...SAMPLE, [param]: key });
        expect(es, `${code}/${key}`).not.toBe(fallback.es);
        expect(en, `${code}/${key}`).not.toBe(fallback.en);
        expect(en, `${code}/${key}`).not.toBe(es);
      }
    }
    // Los plurales del inglés.
    expect(SERVER_EN.providerInUse({ count: 1 })).toBe('It cannot be deleted: 1 agent uses this provider.');
    expect(SERVER_EN.providerInUse({ count: 3 })).toBe('It cannot be deleted: 3 agents use this provider.');
    expect(SERVER_EN.importWarnTriggers({ count: 1 })).toBe('It brings one trigger, which will be created paused.');
    expect(SERVER_EN.importWarnTriggers({ count: 2 })).toBe('It brings 2 triggers, which will be created paused.');
  });

  it('`serverText` da el texto del servidor en español y el traducido en inglés', () => {
    const coded = msg('agentNoModel', { name: 'Redactor' });
    expect(serverText(coded.message, refOf(coded))).toBe('El agente «Redactor» no tiene modelo configurado.');
    expect(inEnglish(() => serverText(coded.message, refOf(coded)))).toBe('Agent "Redactor" has no model configured.');
  });

  it('la causa anidada se traduce también; lo que viene de fuera se muestra tal cual dentro de la frase traducida', () => {
    const nested = msg('runNodeFailed', { name: 'Resumir', cause: msg('nodeTimeout', { ms: 500 }) });
    expect(nested.message).toBe('El nodo "Resumir" falló: El nodo superó su tiempo máximo (500 ms).');
    expect(inEnglish(() => serverText(nested.message, refOf(nested)))).toBe('Node "Resumir" failed: The node exceeded its time limit (500 ms).');

    const external = msg('runNodeFailed', { name: 'Resumir', cause: msg('llmHttpError', { label: 'Ollama', status: 404, detail: 'model "x" not found' }) });
    expect(inEnglish(() => serverText(external.message, refOf(external)))).toBe('Node "Resumir" failed: Ollama answered 404: model "x" not found');
    const loose = msg('runNodeFailed', { name: 'Resumir', cause: 'el servicio devolvió «caído»' });
    expect(inEnglish(() => serverText(loose.message, refOf(loose)))).toBe('Node "Resumir" failed: el servicio devolvió «caído»');
  });

  it('una lista de problemas se traduce elemento a elemento, y un problema de validación de un workflow usa su propia tabla', () => {
    const args = msg('toolArgsInvalid', { problems: [msg('argMissing', { name: 'url' }), msg('argNotBoolean', { name: 'append' })] });
    expect(inEnglish(() => serverText(args.message, refOf(args)))).toBe(
      'Invalid arguments: the required parameter "url" is missing; "append" must be true or false.',
    );
    const issue = { code: 'agentGone', params: { name: 'Paso' }, message: VALIDATION_MESSAGES.agentGone({ name: 'Paso' }) };
    const launch = msg('triggerLaunchFailed', { detail: issue });
    expect(launch.message).toBe('No se pudo lanzar: El nodo "Paso" usa un agente que ya no existe.');
    expect(inEnglish(() => serverText(launch.message, refOf(launch)))).toBe('It could not be launched: Node "Paso" uses an agent that no longer exists.');
  });

  it('sin código (una ejecución anterior a la 1.0) o con uno que esta interfaz no conoce, se muestra el texto guardado', () => {
    expect(inEnglish(() => serverText('El nodo "A" falló: algo', null))).toBe('El nodo "A" falló: algo');
    expect(inEnglish(() => serverText('Texto de un servidor más reciente.', { code: 'codigoDelFuturo', params: { n: 1 } }))).toBe(
      'Texto de un servidor más reciente.',
    );
    // Si la causa anidada es la desconocida, se conserva su texto dentro de la frase traducida.
    const ref = { code: 'runNodeFailed', params: { name: 'A', cause: { code: 'codigoDelFuturo', message: 'causa nueva' } } };
    expect(inEnglish(() => serverText('El nodo "A" falló: causa nueva', ref))).toBe('Node "A" failed: causa nueva');
    expect(serverText(null, null)).toBe('');
  });
});
