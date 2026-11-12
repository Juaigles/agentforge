// Los adaptadores se prueban con tráfico HTTP real contra servidores locales que hablan
// el protocolo de cable de Ollama (NDJSON) y de OpenAI (SSE).
import { describe, expect, it } from 'vitest';
import { LlmError } from '../src/errors';
import { OllamaClient } from '../src/llm/ollama';
import { OpenAiCompatibleClient } from '../src/llm/openai';
import { delay, startServer } from './helpers';

const ndjson = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
const sse = (...objs: unknown[]) => objs.map((o) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`).join('');

describe('OllamaClient', () => {
  it('envía la petición nativa y reconstruye contenido, razonamiento y uso del stream', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      // Se parte un objeto JSON entre dos escrituras para comprobar el reensamblado de líneas.
      const payload = ndjson(
        { message: { role: 'assistant', thinking: 'pienso…' }, done: false },
        { message: { role: 'assistant', content: 'Hola ' }, done: false },
        { message: { role: 'assistant', content: 'mundo' }, done: false },
        { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 7 },
      );
      res.write(payload.slice(0, 70));
      setTimeout(() => res.end(payload.slice(70)), 10);
    });
    try {
      const deltas: string[] = [];
      const thoughts: string[] = [];
      const client = new OllamaClient(`${server.url}/v1/`, 'clave');
      const res = await client.chat({
        model: 'm1',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hola' },
        ],
        temperature: 0.3,
        maxTokens: 50,
        think: false,
        onDelta: (t) => deltas.push(t),
        onThinking: (t) => thoughts.push(t),
      });
      expect(res).toMatchObject({ content: 'Hola mundo', thinking: 'pienso…', toolCalls: [], usage: { promptTokens: 12, completionTokens: 7 } });
      expect(deltas).toEqual(['Hola ', 'mundo']);
      expect(thoughts).toEqual(['pienso…']);

      const sent = server.requests[0];
      expect(sent.url).toBe('/api/chat'); // el sufijo /v1 de la URL base se ignora
      expect(sent.headers.authorization).toBe('Bearer clave');
      expect(JSON.parse(sent.body)).toMatchObject({
        model: 'm1',
        stream: true,
        think: false,
        options: { temperature: 0.3, num_predict: 50 },
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hola' },
        ],
      });
    } finally {
      await server.close();
    }
  });

  it('interpreta tool-calls y serializa el historial con herramientas', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end(
        ndjson(
          { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'calculator', arguments: { expression: '1+1' } } }] }, done: false },
          { message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 1, eval_count: 1 },
        ),
      );
    });
    try {
      const client = new OllamaClient(server.url);
      const res = await client.chat({
        model: 'm',
        messages: [
          { role: 'user', content: 'suma' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'calculator', arguments: { expression: '2+2' } }] },
          { role: 'tool', content: '4', toolCallId: 'c1', name: 'calculator' },
        ],
        tools: [{ name: 'calculator', description: 'calc', parameters: { type: 'object', properties: {} } }],
      });
      expect(res.toolCalls).toEqual([{ id: 'call_1', name: 'calculator', arguments: { expression: '1+1' } }]);
      expect(res.finishReason).toBe('tool_calls');
      const body = JSON.parse(server.requests[0].body);
      expect(body.tools[0]).toEqual({
        type: 'function',
        function: { name: 'calculator', description: 'calc', parameters: { type: 'object', properties: {} } },
      });
      expect(body.messages[1]).toEqual({
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'calculator', arguments: { expression: '2+2' } } }],
      });
      expect(body.messages[2]).toEqual({ role: 'tool', content: '4', tool_name: 'calculator' });
      expect(body.think).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('reintenta sin "think" si el modelo no soporta razonamiento', async () => {
    const server = await startServer((_req, res, body) => {
      if ('think' in JSON.parse(body)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: '"m" does not support thinking' }));
      }
      res.writeHead(200);
      res.end(ndjson({ message: { content: 'ok' }, done: true }));
    });
    try {
      const res = await new OllamaClient(server.url).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], think: true });
      expect(res.content).toBe('ok');
      expect(server.requests).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('clasifica los errores: 404 no reintentable, 500 reintentable, conexión rechazada reintentable, stream cortado', async () => {
    let mode: 'missing' | 'crash' | 'cut' | 'inline' = 'missing';
    const server = await startServer((_req, res) => {
      if (mode === 'missing') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'model "x" not found' }));
      }
      if (mode === 'crash') {
        res.writeHead(500);
        return res.end('boom');
      }
      res.writeHead(200);
      if (mode === 'inline') return res.end(ndjson({ error: 'out of memory' }));
      res.end(ndjson({ message: { content: 'a medias' }, done: false }));
    });
    const req = { model: 'x', messages: [{ role: 'user' as const, content: 'x' }] };
    try {
      const client = new OllamaClient(server.url);
      await expect(client.chat(req)).rejects.toMatchObject({ name: 'LlmError', retryable: false, status: 404, message: expect.stringContaining('not found') });
      mode = 'crash';
      await expect(client.chat(req)).rejects.toMatchObject({ retryable: true, status: 500 });
      mode = 'cut';
      await expect(client.chat(req)).rejects.toMatchObject({ retryable: true, message: expect.stringContaining('se cortó') });
      mode = 'inline';
      await expect(client.chat(req)).rejects.toMatchObject({ retryable: false, message: expect.stringContaining('out of memory') });
    } finally {
      await server.close();
    }
    const err = await new OllamaClient(server.url).chat(req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/No se pudo conectar/);
  });

  it('la cancelación interrumpe una respuesta en curso', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200);
      res.write(ndjson({ message: { content: 'empieza' }, done: false }));
      // nunca termina
    });
    try {
      const controller = new AbortController();
      const deltas: string[] = [];
      const promise = new OllamaClient(server.url).chat({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        signal: controller.signal,
        onDelta: (t) => deltas.push(t),
      });
      await delay(80);
      controller.abort(new Error('cancelado'));
      await expect(promise).rejects.toThrow();
      expect(deltas).toEqual(['empieza']);
    } finally {
      await server.close();
    }
  });

  it('lista modelos con sus capacidades', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          models: [{ name: 'a:1b', size: 100, details: { parameter_size: '1B', context_length: 4096 }, capabilities: ['completion', 'tools'] }],
        }),
      );
    });
    try {
      expect(await new OllamaClient(server.url).listModels()).toEqual([
        { id: 'a:1b', sizeBytes: 100, parameterSize: '1B', contextLength: 4096, capabilities: ['completion', 'tools'] },
      ]);
      expect(server.requests[0].url).toBe('/api/tags');
    } finally {
      await server.close();
    }
  });
});

describe('OpenAiCompatibleClient', () => {
  it('reconstruye contenido, razonamiento, uso y tool-calls troceadas', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        sse(
          { choices: [{ delta: { role: 'assistant', reasoning_content: 'mmm' } }] },
          { choices: [{ delta: { content: 'Voy ' } }] },
          { choices: [{ delta: { content: 'a calcular' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'calculator', arguments: '{"expr' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ession":"1+1"}' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'current_datetime', arguments: '' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          { choices: [], usage: { prompt_tokens: 20, completion_tokens: 9 } },
          '[DONE]',
        ),
      );
    });
    try {
      const deltas: string[] = [];
      const client = new OpenAiCompatibleClient(`${server.url}/v1/`, 'sk-test');
      const res = await client.chat({
        model: 'gpt-x',
        messages: [
          { role: 'user', content: 'calcula' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'calculator', arguments: { expression: '2+2' } }] },
          { role: 'tool', content: '4', toolCallId: 'c0', name: 'calculator' },
        ],
        tools: [{ name: 'calculator', description: 'calc', parameters: { type: 'object', properties: {} } }],
        temperature: 0,
        maxTokens: 30,
        onDelta: (t) => deltas.push(t),
      });
      expect(res).toMatchObject({
        content: 'Voy a calcular',
        thinking: 'mmm',
        finishReason: 'tool_calls',
        usage: { promptTokens: 20, completionTokens: 9 },
        toolCalls: [
          { id: 'call_a', name: 'calculator', arguments: { expression: '1+1' } },
          { id: 'call_b', name: 'current_datetime', arguments: {} },
        ],
      });
      expect(deltas).toEqual(['Voy ', 'a calcular']);

      const sent = server.requests[0];
      expect(sent.url).toBe('/v1/chat/completions');
      expect(sent.headers.authorization).toBe('Bearer sk-test');
      const body = JSON.parse(sent.body);
      expect(body).toMatchObject({ model: 'gpt-x', stream: true, temperature: 0, max_tokens: 30, stream_options: { include_usage: true } });
      expect(body).not.toHaveProperty('reasoning_effort'); // solo se envía si el razonamiento está desactivado
      expect(body.messages[1]).toEqual({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c0', type: 'function', function: { name: 'calculator', arguments: '{"expression":"2+2"}' } }],
      });
      expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'c0', content: '4' });
    } finally {
      await server.close();
    }
  });

  it('tolera argumentos mal formados y servidores que rechazan parámetros opcionales (y lo recuerda)', async () => {
    const server = await startServer((_req, res, body) => {
      const sent = JSON.parse(body);
      const rejected = ['stream_options', 'reasoning_effort'].find((p) => p in sent);
      if (rejected) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `Unknown parameter: ${rejected}` } }));
      }
      res.writeHead(200);
      res.end(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 't', arguments: '{roto' } }] } }] }, '[DONE]'));
    });
    try {
      const req = { model: 'm', messages: [{ role: 'user' as const, content: 'x' }], think: false };
      const res = await new OpenAiCompatibleClient(server.url).chat(req);
      // Los argumentos que no son JSON válido no se inventan: se marca la llamada para que el agente lo diga al modelo.
      expect(res.toolCalls).toEqual([{ id: 'call_1', name: 't', arguments: {}, invalidArguments: '{roto' }]);
      expect(server.requests).toHaveLength(3); // con ambos, sin stream_options, sin ninguno
      // Un cliente nuevo para el mismo servidor y modelo ya no vuelve a enviar los parámetros rechazados.
      await new OpenAiCompatibleClient(server.url).chat(req);
      expect(server.requests).toHaveLength(4);
      expect(JSON.parse(server.requests[3].body)).not.toHaveProperty('reasoning_effort');
    } finally {
      await server.close();
    }
  });

  it('clasifica errores HTTP: 401 no reintentable, 429 reintentable', async () => {
    let status = 401;
    const server = await startServer((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key' } }));
    });
    const req = { model: 'm', messages: [{ role: 'user' as const, content: 'x' }] };
    try {
      const client = new OpenAiCompatibleClient(server.url, 'mala');
      await expect(client.chat(req)).rejects.toMatchObject({ retryable: false, status: 401, message: expect.stringContaining('Incorrect API key') });
      status = 429;
      await expect(client.chat(req)).rejects.toMatchObject({ retryable: true, status: 429 });
      await expect(client.listModels()).rejects.toBeInstanceOf(LlmError);
    } finally {
      await server.close();
    }
  });

  it('lista modelos ordenados', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'z-model' }, { id: 'a-model' }] }));
    });
    try {
      expect(await new OpenAiCompatibleClient(server.url).listModels()).toEqual([{ id: 'a-model' }, { id: 'z-model' }]);
    } finally {
      await server.close();
    }
  });
});
