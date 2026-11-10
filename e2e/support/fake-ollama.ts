// Proveedor LLM determinista para los tests end-to-end.
//
// Es un servidor HTTP real que habla el protocolo de cable de Ollama (`/api/tags` y `/api/chat` en NDJSON
// con streaming y tool-calls) y, para los proveedores «compatibles con OpenAI», el de OpenAI
// (`/v1/models` y `/v1/chat/completions` en SSE). AgentForge se conecta a él con sus adaptadores de
// producción, sin ningún atajo: lo único simulado es el modelo.
//
// La respuesta se decide con directivas `[[...]]` escritas en las instrucciones del agente o en la tarea:
//
//   [[decir:TEXTO]]                  responde exactamente TEXTO
//   [[ritmo:MS]]                     milisegundos entre fragmentos del stream (por defecto 8)
//   [[palabras:N]]                   responde N palabras numeradas (para respuestas largas)
//   [[lento]]                        atajo de [[ritmo:100]] [[palabras:400]] (≈40 s: da tiempo a cancelar)
//   [[pensar]]                       emite antes un fragmento de razonamiento
//   [[fallo:CLAVE]]                  falla (error no reintentable) mientras CLAVE esté en `failing`
//   [[herramienta:NOMBRE {json}]]    pide la herramienta NOMBRE con esos argumentos y, al recibir su
//                                    resultado, responde «Resultado de NOMBRE: <resultado>»
//
// Sin directivas responde «Eco: <tarea>».
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_MODEL = 'e2e-model';
export const FAKE_MODEL_NO_TOOLS = 'e2e-sin-herramientas';

interface WireMessage {
  role: string;
  content?: string;
  tool_calls?: unknown[];
}

export interface ChatRecord {
  protocol: 'ollama' | 'openai';
  model: string;
  system: string;
  user: string;
  messages: WireMessage[];
  toolNames: string[];
  authorization: string | undefined;
}

export interface FakeOllama {
  url: string;
  /** Peticiones de chat recibidas, en orden. */
  chats: ChatRecord[];
  /** Cabecera Authorization de cada petición de listado de modelos. */
  modelListAuth: Array<string | undefined>;
  /** Claves de `[[fallo:CLAVE]]` que fallan ahora mismo. */
  failing: Set<string>;
  /** Si se define, el servidor exige `Authorization: Bearer <clave>` (401 en caso contrario). */
  requiredApiKey: string | null;
  reset(): void;
  close(): Promise<void>;
}

interface Plan {
  error?: string;
  thinking?: string;
  toolCall?: { name: string; arguments: Record<string, unknown> };
  words: string[];
  paceMs: number;
}

const DIRECTIVE = /\[\[([a-zñ0-9]+)(?::([\s\S]*?))?\]\]/gi;
const stripDirectives = (text: string) => text.replace(DIRECTIVE, '').replace(/\s+/g, ' ').trim();

function directives(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of text.matchAll(DIRECTIVE)) found.set(m[1].toLowerCase(), (m[2] ?? '').trim());
  return found;
}

function plan(messages: WireMessage[], toolNames: string[], failing: Set<string>): Plan {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const user = messages.find((m) => m.role === 'user')?.content ?? '';
  const d = directives(`${system}\n${user}`);
  const paceMs = d.has('lento') ? 100 : Number(d.get('ritmo') ?? 8);
  const base: Plan = { words: [], paceMs, thinking: d.has('pensar') ? 'Razonamiento simulado sobre la tarea.' : undefined };

  const failKey = d.get('fallo');
  if (failKey !== undefined && failing.has(failKey)) return { ...base, error: `fallo simulado (${failKey})` };

  const last = messages[messages.length - 1];
  const toolSpec = d.get('herramienta');
  if (toolSpec) {
    const [, name, json] = /^(\S+)\s*([\s\S]*)$/.exec(toolSpec) ?? [];
    if (last?.role === 'tool') return { ...base, words: split(`Resultado de ${name}: ${last.content ?? ''}`) };
    if (name && toolNames.includes(name) && !messages.some((m) => m.role === 'tool')) {
      return { ...base, toolCall: { name, arguments: json ? (JSON.parse(json) as Record<string, unknown>) : {} } };
    }
  }

  if (d.has('decir')) return { ...base, words: split(d.get('decir')!) };
  const count = d.has('lento') ? 400 : Number(d.get('palabras') ?? 0);
  if (count > 0) return { ...base, words: Array.from({ length: count }, (_, i) => `palabra-${i + 1} `) };
  return { ...base, words: split(`Eco: ${stripDirectives(user).slice(0, 400)}`) };
}

/** Trocea conservando los espacios, para que el stream reconstruya el texto exacto. */
const split = (text: string): string[] => text.match(/\S+\s*|\s+/g) ?? [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MODELS = [
  { name: FAKE_MODEL, size: 2_500_000_000, details: { parameter_size: '4B' }, capabilities: ['completion', 'tools', 'thinking'] },
  { name: FAKE_MODEL_NO_TOOLS, size: 9_000_000_000, details: { parameter_size: '8B' }, capabilities: ['completion'] },
];

export async function startFakeOllama(): Promise<FakeOllama> {
  const state = {
    chats: [] as ChatRecord[],
    modelListAuth: [] as Array<string | undefined>,
    failing: new Set<string>(),
    requiredApiKey: null as string | null,
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => void handle(req, res, raw).catch(() => res.destroy()));
  });

  function authorized(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!state.requiredApiKey || req.headers.authorization === `Bearer ${state.requiredApiKey}`) return true;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Clave de API no válida (servidor de pruebas).' } }));
    return false;
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, raw: string): Promise<void> {
    const url = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && (url === '/api/tags' || url === '/v1/models')) {
      state.modelListAuth.push(req.headers.authorization);
      if (!authorized(req, res)) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(url === '/api/tags' ? { models: MODELS } : { object: 'list', data: MODELS.map((m) => ({ id: m.name, object: 'model' })) }));
      return;
    }
    if (req.method === 'POST' && (url === '/api/chat' || url === '/v1/chat/completions')) {
      if (!authorized(req, res)) return;
      const body = JSON.parse(raw) as { model: string; messages: WireMessage[]; tools?: Array<{ function: { name: string } }> };
      const toolNames = (body.tools ?? []).map((t) => t.function.name);
      const protocol = url === '/api/chat' ? 'ollama' : 'openai';
      state.chats.push({
        protocol,
        model: body.model,
        system: body.messages.find((m) => m.role === 'system')?.content ?? '',
        user: body.messages.find((m) => m.role === 'user')?.content ?? '',
        messages: body.messages,
        toolNames,
        authorization: req.headers.authorization,
      });
      const p = plan(body.messages, toolNames, state.failing);
      let closed = false;
      res.on('close', () => (closed = true));
      if (protocol === 'ollama') await streamOllama(res, p, () => closed);
      else await streamOpenAi(res, body.model, p, () => closed);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  async function streamOllama(res: http.ServerResponse, p: Plan, closed: () => boolean): Promise<void> {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const send = (obj: unknown) => res.write(`${JSON.stringify(obj)}\n`);
    if (p.error) return void res.end(`${JSON.stringify({ error: p.error })}\n`);
    if (p.thinking) send({ message: { role: 'assistant', thinking: p.thinking }, done: false });
    if (p.toolCall) send({ message: { role: 'assistant', content: '', tool_calls: [{ function: p.toolCall }] }, done: false });
    for (const word of p.words) {
      if (closed()) return;
      send({ message: { role: 'assistant', content: word }, done: false });
      await sleep(p.paceMs);
    }
    if (closed()) return;
    send({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: Math.max(1, p.words.length) });
    res.end();
  }

  async function streamOpenAi(res: http.ServerResponse, model: string, p: Plan, closed: () => boolean): Promise<void> {
    if (p.error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ error: { message: p.error } }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-e2e', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
    if (p.toolCall) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_e2e', type: 'function', function: { name: p.toolCall.name, arguments: JSON.stringify(p.toolCall.arguments) } }] });
    }
    for (const word of p.words) {
      if (closed()) return;
      send({ content: word });
      await sleep(p.paceMs);
    }
    if (closed()) return;
    send({}, p.toolCall ? 'tool_calls' : 'stop', { usage: { prompt_tokens: 40, completion_tokens: Math.max(1, p.words.length) } });
    res.end('data: [DONE]\n\n');
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    chats: state.chats,
    modelListAuth: state.modelListAuth,
    failing: state.failing,
    get requiredApiKey() {
      return state.requiredApiKey;
    },
    set requiredApiKey(value: string | null) {
      state.requiredApiKey = value;
    },
    reset() {
      state.chats.length = 0;
      state.modelListAuth.length = 0;
      state.failing.clear();
      state.requiredApiKey = null;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
