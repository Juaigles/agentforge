import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/types';
import { resolveInWorkspace } from '../src/tools/builtin';
import { evaluateExpression } from '../src/tools/calc';
import { assertUrlAllowed, htmlToText, isPrivateAddress } from '../src/tools/net';
import { customToolDefinition, ToolRegistry } from '../src/tools/registry';
import { runJavaScript } from '../src/tools/sandbox';
import type { ToolContext } from '../src/tools/types';
import { validateArgs } from '../src/tools/validate';
import { startServer, tempDir } from './helpers';

const workspace = tempDir();
afterAll(() => fs.rmSync(workspace, { recursive: true, force: true }));

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    runId: 'r',
    nodeId: 'n',
    signal: new AbortController().signal,
    workspaceDir: workspace,
    settings: { ...DEFAULT_SETTINGS },
    memory: new Map(),
    ...overrides,
  };
}

describe('calculadora', () => {
  it('no arrastra ruido binario de coma flotante en el resultado', () => {
    expect(evaluateExpression('2450.80 * 1.21')).toBe(2965.468);
    expect(evaluateExpression('0.1 + 0.2')).toBe(0.3);
    expect(evaluateExpression('1e21 + 1')).toBe(1e21);
    expect(evaluateExpression('1 / 3')).toBe(0.333333333333);
  });

  it.each([
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['2 ^ 3 ^ 2', 512],
    ['2 ** 10', 1024],
    ['-3 + 5', 2],
    ['-2 ^ 2', -4],
    ['10 % 4', 2],
    ['sqrt(16) + abs(-4)', 8],
    ['round(1284.50 * 1.21, 2)', 1554.25],
    ['max(1, 5, 3) - min(4, 2)', 3],
    ['1.5e3 / 3', 500],
    ['2 * pi', 2 * Math.PI],
  ])('%s = %d', (expr, expected) => {
    expect(evaluateExpression(expr)).toBeCloseTo(expected, 10);
  });

  it.each(['', '1 +', '(1 + 2', '1 / 0', 'foo(1)', 'x + 1', '1 2', 'process.exit(1)', 'constructor', '2 $ 3'])('rechaza %j', (expr) => {
    expect(() => evaluateExpression(expr)).toThrow();
  });
});

describe('validación de argumentos', () => {
  const schema = {
    type: 'object' as const,
    properties: {
      q: { type: 'string' as const },
      n: { type: 'integer' as const, default: 3 },
      flag: { type: 'boolean' as const },
      mode: { type: 'string' as const, enum: ['a', 'b'] },
      obj: { type: 'object' as const },
    },
    required: ['q'],
  };

  it('aplica valores por defecto y descarta propiedades desconocidas', () => {
    expect(validateArgs(schema, { q: 'hola', extra: 1 })).toEqual({ q: 'hola', n: 3 });
  });

  it('corrige tipos habituales de los LLM (números y booleanos como texto, JSON como cadena)', () => {
    expect(validateArgs(schema, { q: 5, n: '7', flag: 'TRUE', obj: '{"a":1}' })).toEqual({ q: '5', n: 7, flag: true, obj: { a: 1 } });
  });

  it('informa de todos los problemas a la vez', () => {
    expect(() => validateArgs(schema, { n: 'x', mode: 'z', flag: 'quizá' })).toThrow(/"q".*"n".*"flag".*"mode"|obligatorio/s);
    expect(() => validateArgs(schema, { q: 'a', n: 1.5 })).toThrow(/entero/);
    expect(() => validateArgs(schema, 'texto')).toThrow(/objeto JSON/);
  });
});

describe('protección de red', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ])('%s es privada', (ip) => expect(isPrivateAddress(ip)).toBe(true));
  it.each(['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700:4700::1111'])('%s es pública', (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it('bloquea localhost, IPs privadas y protocolos no http', async () => {
    await expect(assertUrlAllowed('http://127.0.0.1:11434/api/tags', false)).rejects.toThrow(/red privada/);
    await expect(assertUrlAllowed('http://localhost/', false)).rejects.toThrow(/red privada/);
    await expect(assertUrlAllowed('http://[::1]/', false)).rejects.toThrow(/red privada/);
    await expect(assertUrlAllowed('file:///etc/passwd', false)).rejects.toThrow(/Protocolo/);
    await expect(assertUrlAllowed('nada', false)).rejects.toThrow(/no válida/);
    await expect(assertUrlAllowed('http://127.0.0.1/', true)).resolves.toBeInstanceOf(URL);
  });

  it('convierte HTML en texto sin scripts ni etiquetas', () => {
    const text = htmlToText(
      '<html><head><title>T</title><style>p{}</style></head><body><h1>Hola</h1><script>alert(1)</script><p>Uno &amp;   dos</p><div></div><div></div><p>Tres</p></body></html>',
    );
    expect(text).toBe('Hola\nUno & dos\n\nTres');
  });
});

describe('herramientas integradas', () => {
  const registry = new ToolRegistry();

  it('aísla los archivos en el espacio de trabajo', async () => {
    expect(() => resolveInWorkspace(workspace, '../fuera.txt')).toThrow(/fuera del espacio/);
    expect(() => resolveInWorkspace(workspace, 'a/../../fuera.txt')).toThrow(/fuera del espacio/);
    expect(resolveInWorkspace(workspace, '/dentro.txt')).toBe(path.join(workspace, 'dentro.txt'));
    await expect(registry.invoke('file_write', { path: '..\\..\\x.txt', content: 'x' }, ctx())).rejects.toThrow(/fuera del espacio/);
  });

  it('escribe, añade, lee y lista archivos reales', async () => {
    await registry.invoke('file_write', { path: 'notas/a.md', content: 'uno' }, ctx());
    await registry.invoke('file_write', { path: 'notas/a.md', content: '+dos', append: true }, ctx());
    expect(fs.readFileSync(path.join(workspace, 'notas', 'a.md'), 'utf8')).toBe('uno+dos');
    const read = (await registry.invoke('file_read', { path: 'notas/a.md' }, ctx())) as { content: string };
    expect(read.content).toBe('uno+dos');
    const list = (await registry.invoke('file_list', {}, ctx())) as { files: Array<{ path: string }> };
    expect(list.files.map((f) => f.path)).toContain('notas/a.md');
    await expect(registry.invoke('file_read', { path: 'no-existe.md' }, ctx())).rejects.toThrow(/no existe/);
  });

  it('comparte memoria dentro de una ejecución', async () => {
    const shared = ctx();
    await registry.invoke('memory_set', { key: 'k', value: 'v' }, shared);
    expect(await registry.invoke('memory_get', { key: 'k' }, shared)).toMatchObject({ found: true, value: 'v' });
    expect(await registry.invoke('memory_get', { key: 'k' }, ctx())).toMatchObject({ found: false });
  });

  it('rechaza herramientas desconocidas y argumentos inválidos', async () => {
    await expect(registry.invoke('no_existe', {}, ctx())).rejects.toThrow(/desconocida/);
    await expect(registry.invoke('calculator', {}, ctx())).rejects.toThrow(/expression/);
  });

  it('http_request respeta el bloqueo de redes privadas y funciona al permitirlas', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hola: 'mundo' }));
    });
    try {
      await expect(registry.invoke('http_request', { url: server.url }, ctx())).rejects.toThrow(/red privada/);
      expect(server.requests).toHaveLength(0);
      const allowed = ctx({ settings: { ...DEFAULT_SETTINGS, allowPrivateNetwork: true } });
      const res = (await registry.invoke('http_request', { url: `${server.url}/x`, method: 'POST', body: '{"a":1}' }, allowed)) as any;
      expect(res).toMatchObject({ status: 200, body: { hola: 'mundo' } });
      expect(server.requests[0]).toMatchObject({ method: 'POST', url: '/x', body: '{"a":1}' });
    } finally {
      await server.close();
    }
  });

  it('valida también el destino de cada redirección', async () => {
    const { safeFetch } = await import('../src/tools/net');
    const hop = await startServer((_req, res) => {
      res.writeHead(302, { Location: 'ftp://example.com/x' });
      res.end();
    });
    try {
      await expect(safeFetch(hop.url, { signal: new AbortController().signal, allowPrivate: true })).rejects.toThrow(/Protocolo/);
    } finally {
      await hop.close();
    }
  });

  it('run_javascript está desactivada por defecto y aísla el código al activarla', async () => {
    await expect(registry.invoke('run_javascript', { code: '1+1' }, ctx())).rejects.toThrow(/desactivada/);
    const on = ctx({ settings: { ...DEFAULT_SETTINGS, allowCodeExecution: true } });
    expect(await registry.invoke('run_javascript', { code: 'console.log("hola"); [1,2,3].map(x => x * 2)' }, on)).toEqual({
      result: [2, 4, 6],
      logs: ['hola'],
    });
    await expect(runJavaScript('typeof require + typeof process + typeof fetch')).resolves.toMatchObject({
      result: 'undefinedundefinedundefined',
    });
    await expect(runJavaScript('while(true){}', { timeoutMs: 200 })).rejects.toThrow();
    await expect(runJavaScript('throw new Error("boom")')).rejects.toThrow(/boom/);
  });
});

describe('herramientas HTTP personalizadas', () => {
  it('sustituye parámetros en URL, cabeceras y cuerpo', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(req.url?.includes('falla') ? 500 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      const tool = customToolDefinition({
        id: 't',
        secretHeaders: [],
        name: 'buscar',
        description: 'Busca',
        parameters: { type: 'object', properties: { q: { type: 'string' }, n: { type: 'integer' } }, required: ['q'] },
        method: 'POST',
        urlTemplate: `${server.url}/search?q={{q}}`,
        headers: { 'X-Query': '{{q}}' },
        bodyTemplate: '{"limit": {{n}}}',
        enabled: true,
        createdAt: '',
        updatedAt: '',
      });
      const allowed = ctx({ settings: { ...DEFAULT_SETTINGS, allowPrivateNetwork: true } });
      const res = await tool.execute({ q: 'a b&c', n: 5 }, allowed);
      expect(res).toEqual({ status: 200, body: { ok: true } });
      expect(server.requests[0].url).toBe('/search?q=a%20b%26c');
      expect(server.requests[0].headers['x-query']).toBe('a b&c');
      expect(server.requests[0].body).toBe('{"limit": 5}');
      await expect(tool.execute({ q: 'falla' }, allowed)).rejects.toThrow(/500/);
    } finally {
      await server.close();
    }
  });
});
