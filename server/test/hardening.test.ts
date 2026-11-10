// Robustez del servidor: fijación de DNS contra SSRF, aislamiento de run_javascript y retención del historial.
import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context';
import { isPrivateAddress, resolveTarget, safeFetch } from '../src/tools/net';
import { runJavaScript, sandboxNodeArgs } from '../src/tools/sandbox';
import { addAgent, edges, makeContext, node, runWorkflow, ScriptedLlm, workflow } from './helpers';

const signal = () => new AbortController().signal;

/** Servidor HTTP en una dirección de loopback concreta (127.0.0.x) que responde con su propio nombre. */
function listenOn(address: string, port: number, name: string): Promise<{ port: number; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.headers.host}${req.url}`);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(name);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, address, () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        hits,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      }),
    );
  });
}

describe('protección SSRF con la IP fijada', () => {
  it.each([
    '::ffff:7f00:1', // 127.0.0.1 mapeada, tal como la normaliza el analizador de URL
    '::ffff:c0a8:101', // 192.168.1.1 mapeada
    '::7f00:1', // IPv4 compatible
    '64:ff9b::7f00:1', // NAT64 hacia 127.0.0.1
    '0:0:0:0:0:0:0:1',
    'fec0::1',
    'ff02::1',
    '198.18.0.1',
    '192.0.0.8',
    'no-es-una-ip',
  ])('%s se trata como privada', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['::ffff:808:808', '64:ff9b::808:808', '2001:4860:4860::8888', '93.184.216.34'])('%s es pública', (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );

  it('una IPv4 privada escrita como IPv6 mapeada en la URL no burla el filtro', async () => {
    const server = await listenOn('127.0.0.1', 0, 'interno');
    try {
      for (const host of ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[0:0:0:0:0:ffff:7f00:1]', '2130706433', '0x7f.1', '127.1']) {
        await expect(safeFetch(`http://${host}:${server.port}/`, { signal: signal(), allowPrivate: false }), host).rejects.toThrow(/red privada/);
      }
      expect(server.hits).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('rechaza un nombre si CUALQUIERA de sus direcciones es privada, sin llegar a conectar', async () => {
    const server = await listenOn('127.0.0.1', 0, 'interno');
    try {
      const lookup = async () => ['93.184.216.34', '127.0.0.1'];
      await expect(safeFetch(`http://mixto.test:${server.port}/`, { signal: signal(), allowPrivate: false, lookup })).rejects.toThrow(/red privada/);
      await expect(resolveTarget('http://solo-publica.test/', false, async () => ['93.184.216.34'])).resolves.toMatchObject({ address: '93.184.216.34', family: 4 });
      expect(server.hits).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('DNS rebinding: el nombre se resuelve una sola vez y la conexión va a la IP validada, aunque el DNS cambie después', async () => {
    // Dos servicios en el mismo puerto y distinta IP: «validado» (lo que respondió el DNS al comprobar) y
    // «rebind» (lo que el DNS respondería a una segunda consulta hecha al conectar).
    const validated = await listenOn('127.0.0.1', 0, 'validado');
    let rebound: Awaited<ReturnType<typeof listenOn>>;
    try {
      rebound = await listenOn('127.0.0.2', validated.port, 'rebind');
    } catch (err) {
      await validated.close();
      throw err;
    }
    try {
      let lookups = 0;
      const lookup = async () => (++lookups === 1 ? ['127.0.0.1'] : ['127.0.0.2']);
      const res = await safeFetch(`http://rebind.test:${validated.port}/dato`, { signal: signal(), allowPrivate: true, lookup });
      expect(res.text).toBe('validado');
      expect(lookups).toBe(1);
      // El servidor ve el nombre original en la cabecera Host (necesario para TLS y hosts virtuales).
      expect(validated.hits).toEqual([`GET rebind.test:${validated.port}/dato`]);
      expect(rebound.hits).toEqual([]);

      // Cada petición nueva vuelve a resolver y a validar: no se reutiliza la conexión ni la respuesta anterior.
      const second = await safeFetch(`http://rebind.test:${validated.port}/dato`, { signal: signal(), allowPrivate: true, lookup });
      expect(second.text).toBe('rebind');
      expect(lookups).toBe(2);
    } finally {
      await validated.close();
      await rebound.close();
    }
  });

  it('una redirección hacia un nombre que resuelve a una IP privada se bloquea en ese salto', async () => {
    const internal = await listenOn('127.0.0.2', 0, 'secreto interno');
    const redirector = http.createServer((_req, res) => {
      res.writeHead(302, { Location: `http://interno.test:${internal.port}/admin` });
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    const port = (redirector.address() as AddressInfo).port;
    try {
      // El primer salto se permite a propósito (es «público» para el test); el segundo resuelve a loopback.
      const lookup = async (host: string) => (host === 'publico.test' ? ['127.0.0.1'] : ['127.0.0.2']);
      const guarded = { ...{ signal: signal() }, lookup };
      await expect(safeFetch(`http://interno.test:${internal.port}/admin`, { ...guarded, allowPrivate: false })).rejects.toThrow(/red privada/);
      // Con el filtro activo el primer salto ya se rechaza; se comprueba la validación por salto con una
      // resolución que solo es privada para el destino de la redirección.
      const isPublicFirst = async (host: string) => (host === 'publico.test' ? ['93.184.216.34'] : ['127.0.0.2']);
      await expect(resolveTarget(`http://publico.test:${port}/`, false, isPublicFirst)).resolves.toMatchObject({ address: '93.184.216.34' });
      await expect(resolveTarget(`http://interno.test:${internal.port}/admin`, false, isPublicFirst)).rejects.toThrow(/red privada/);
      // Y de punta a punta, con redes privadas permitidas, la redirección se sigue hasta el destino fijado.
      const followed = await safeFetch(`http://publico.test:${port}/`, { signal: signal(), allowPrivate: true, lookup });
      expect(followed.text).toBe('secreto interno');
      expect(followed.url).toBe(`http://interno.test:${internal.port}/admin`);
    } finally {
      await internal.close();
      redirector.closeAllConnections();
      await new Promise((r) => redirector.close(r));
    }
  });

  it('sigue leyendo respuestas comprimidas, respeta el límite de tamaño y envía cuerpos con su longitud', async () => {
    const received: Array<{ method?: string; body: string; length?: string }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ method: req.method, body, length: req.headers['content-length'] });
        if (req.url === '/gzip') {
          res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Type': 'text/plain' });
          return res.end(zlib.gzipSync('contenido comprimido con eñes'));
        }
        if (req.url === '/br') {
          res.writeHead(200, { 'Content-Encoding': 'br' });
          return res.end(zlib.brotliCompressSync('contenido brotli'));
        }
        if (req.url === '/grande') {
          res.writeHead(200);
          return res.end('x'.repeat(50_000));
        }
        res.writeHead(201, { 'X-Eco': 'sí'.normalize() === 'sí' ? 'ok' : 'no' });
        res.end(body);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const opts = { signal: signal(), allowPrivate: true };
    try {
      expect((await safeFetch(`${base}/gzip`, opts)).text).toBe('contenido comprimido con eñes');
      expect((await safeFetch(`${base}/br`, opts)).text).toBe('contenido brotli');
      const big = await safeFetch(`${base}/grande`, { ...opts, maxBytes: 1000 });
      expect(big).toMatchObject({ truncated: true });
      expect(big.text).toHaveLength(1000);
      const posted = await safeFetch(`${base}/eco`, { ...opts, method: 'POST', body: '{"ñ":"€"}', headers: { 'Content-Type': 'application/json' } });
      expect(posted).toMatchObject({ status: 201, text: '{"ñ":"€"}', headers: { 'x-eco': 'ok' } });
      expect(received.at(-1)).toMatchObject({ method: 'POST', body: '{"ñ":"€"}', length: String(Buffer.byteLength('{"ñ":"€"}')) });
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it('corta las peticiones que tardan demasiado y respeta la cancelación', async () => {
    const server = http.createServer(() => undefined); // nunca responde
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      await expect(safeFetch(url, { signal: signal(), allowPrivate: true, timeoutMs: 150 })).rejects.toThrow(/tiempo de espera/);
      const controller = new AbortController();
      const pending = safeFetch(url, { signal: controller.signal, allowPrivate: true });
      setTimeout(() => controller.abort(new Error('cancelado por el usuario')), 50);
      await expect(pending).rejects.toThrow('cancelado por el usuario');
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});

describe('aislamiento de run_javascript', () => {
  it('ejecuta código normal y espera a las promesas', async () => {
    await expect(runJavaScript('const xs = [3, 1, 2]; xs.sort(); xs')).resolves.toEqual({ result: [1, 2, 3], logs: [] });
    await expect(runJavaScript('(async () => { const a = await Promise.resolve(20); return a + 1; })()')).resolves.toMatchObject({ result: 21 });
    await expect(runJavaScript('Promise.reject(new Error("rechazada"))')).rejects.toThrow(/rechazada/);
    await expect(runJavaScript('new Promise(() => {})')).rejects.toThrow(/no llega a resolverse/);
  });

  it('no expone require, process, fetch, temporizadores ni generación de código', async () => {
    const probe = await runJavaScript('[typeof require, typeof process, typeof fetch, typeof setTimeout, typeof globalThis.Buffer, typeof module].join(",")');
    expect(probe.result).toBe('undefined,undefined,undefined,undefined,undefined,undefined');
    await expect(runJavaScript('eval("1+1")')).rejects.toThrow(/Code generation from strings disallowed/);
    await expect(runJavaScript('new Function("return 1")()')).rejects.toThrow(/Code generation from strings disallowed/);
    // El truco clásico de escape por el constructor tampoco puede generar código.
    await expect(runJavaScript('this.constructor.constructor("return process")()')).rejects.toThrow(/Code generation from strings disallowed/);
  });

  it('corta bucles infinitos, también dentro de promesas, y los excesos de memoria y de salida', async () => {
    await expect(runJavaScript('while (true) {}', { timeoutMs: 300 })).rejects.toThrow(/timed out|tiempo máximo/);
    await expect(runJavaScript('Promise.resolve().then(() => { while (true) {} }); 1', { timeoutMs: 300 })).rejects.toThrow(/timed out|tiempo máximo/);
    await expect(runJavaScript('const a = []; while (true) a.push(new Array(1e6).fill(1))', { timeoutMs: 20_000 })).rejects.toThrow(/memoria|tiempo máximo/);
    await expect(runJavaScript('"x".repeat(400000)')).rejects.toThrow(/demasiado grande/);
    const logs = await runJavaScript('for (let i = 0; i < 1000; i++) console.log("línea", i); "fin"');
    expect(logs.logs).toHaveLength(200);
    await expect(runJavaScript('x'.repeat(100_001))).rejects.toThrow(/demasiado largo/);
  }, 40_000);

  it('se puede cancelar mientras se ejecuta', async () => {
    const controller = new AbortController();
    const pending = runJavaScript('while (true) {}', { timeoutMs: 10_000, signal: controller.signal });
    setTimeout(() => controller.abort(new Error('cancelado')), 300);
    await expect(pending).rejects.toThrow('cancelado');
  });

  it('segunda capa: el proceso aislado no puede leer archivos, lanzar programas ni crear workers', async () => {
    // Se ejecuta código Node «ya escapado» (fuera de vm) con los mismos argumentos que usa el entorno aislado.
    const probe = `
      const out = {};
      const attempt = (name, fn) => { try { fn(); out[name] = 'PERMITIDO'; } catch (e) { out[name] = e.code || e.message; } };
      attempt('leer', () => require('node:fs').readFileSync(process.execPath));
      attempt('listar', () => require('node:fs').readdirSync(${JSON.stringify(os.homedir())}));
      attempt('escribir', () => require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(os.tmpdir())}, 'agentforge-escape.txt'), 'x'));
      attempt('proceso', () => require('node:child_process').execSync('echo hola'));
      attempt('worker', () => new (require('node:worker_threads').Worker)('1', { eval: true }));
      out.heredada = process.env.AGENTFORGE_SECRETO_DE_PRUEBA ?? null;
      console.log(JSON.stringify(out));
    `;
    process.env.AGENTFORGE_SECRETO_DE_PRUEBA = 'no-debe-heredarse';
    const out = await new Promise<string>((resolve, reject) =>
      execFile(process.execPath, [...sandboxNodeArgs(), '-e', probe], { env: {}, cwd: os.tmpdir() }, (err, stdout, stderr) =>
        err ? reject(new Error(stderr || err.message)) : resolve(stdout),
      ),
    );
    expect(JSON.parse(out)).toEqual({
      leer: 'ERR_ACCESS_DENIED',
      listar: 'ERR_ACCESS_DENIED',
      escribir: 'ERR_ACCESS_DENIED',
      proceso: 'ERR_ACCESS_DENIED',
      worker: 'ERR_ACCESS_DENIED',
      heredada: null, // las variables del servidor (claves, rutas) no llegan al proceso aislado
    });
  });
});

describe('retención del historial', () => {
  let ctx: AppContext;
  afterEach(() => ctx?.close());

  const DAY = 86_400_000;
  async function finishedRun(name: string, daysAgo: number): Promise<string> {
    const agent = ctx.store.listAgents()[0] ?? addAgent(ctx);
    const def = workflow([node('entrada', 'input'), node('a', 'agent', { agentId: agent.id, prompt: '{{input}}' })], edges('entrada>a'));
    const run = await runWorkflow(ctx, { ...def, name }, 'x');
    const when = new Date(Date.now() - daysAgo * DAY).toISOString();
    ctx.db.prepare('UPDATE runs SET created_at = ?, finished_at = ? WHERE id = ?').run(when, when, run.id);
    return run.id;
  }
  const names = () => ctx.store.listRuns({ limit: 200 }).items.map((r) => r.name).sort();
  const count = (table: string) => Number((ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

  it('sin política configurada no borra nada', async () => {
    ctx = makeContext(new ScriptedLlm(() => ({ content: 'ok' })));
    await finishedRun('antigua', 400);
    expect(ctx.applyRetention()).toBe(0);
    expect(names()).toEqual(['antigua']);
  });

  it('borra por antigüedad las ejecuciones terminadas, con sus pasos y eventos, y respeta las recientes y las activas', async () => {
    ctx = makeContext(new ScriptedLlm(() => ({ content: 'ok' })));
    const old = await finishedRun('de hace 40 días', 40);
    await finishedRun('de hace 10 días', 10);
    await finishedRun('de hoy', 0);
    // Una ejecución antigua pero todavía «en curso» y otra pendiente de reanudar no deben tocarse.
    const active = await finishedRun('antigua en curso', 90);
    ctx.db.prepare("UPDATE runs SET status = 'running', finished_at = NULL WHERE id = ?").run(active);
    const interrupted = await finishedRun('antigua interrumpida', 90);
    ctx.db.prepare("UPDATE runs SET status = 'failed', interrupted = 1 WHERE id = ?").run(interrupted);
    expect(ctx.store.listEvents(old).length).toBeGreaterThan(0);
    const stepsBefore = count('run_steps');
    const eventsBefore = count('run_events');

    ctx.store.updateSettings({ retentionDays: 30 });
    expect(ctx.applyRetention()).toBe(1);
    expect(names()).toEqual(['antigua en curso', 'antigua interrumpida', 'de hace 10 días', 'de hoy']);
    expect(ctx.store.getRun(old)).toBeNull();
    expect(ctx.store.listEvents(old)).toEqual([]);
    expect(count('run_steps')).toBe(stepsBefore - 2);
    expect(count('run_events')).toBeLessThan(eventsBefore);

    ctx.store.updateSettings({ retentionDays: 5 });
    expect(ctx.applyRetention()).toBe(1);
    expect(names()).toEqual(['antigua en curso', 'antigua interrumpida', 'de hoy']);
  });

  it('con un máximo de ejecuciones conserva las más recientes y se aplica sola al terminar cada ejecución', async () => {
    ctx = makeContext(new ScriptedLlm(() => ({ content: 'ok' })));
    for (const [name, days] of [['e1', 5], ['e2', 4], ['e3', 3], ['e4', 2]] as const) await finishedRun(name, days);
    ctx.store.updateSettings({ retentionMaxRuns: 3 });
    expect(ctx.applyRetention()).toBe(1);
    expect(names()).toEqual(['e2', 'e3', 'e4']);

    // Sin llamar a nada: al terminar una ejecución nueva, el propio motor aplica la retención.
    const agent = ctx.store.listAgents()[0];
    const def = workflow([node('entrada', 'input'), node('a', 'agent', { agentId: agent.id, prompt: '{{input}}' })], edges('entrada>a'));
    await runWorkflow(ctx, { ...def, name: 'e5' }, 'x');
    expect(names()).toEqual(['e3', 'e4', 'e5']);
  });
});
