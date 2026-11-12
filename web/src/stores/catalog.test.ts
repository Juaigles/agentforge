// @vitest-environment jsdom
// Catálogo y estado de conexión contra la API real (ver src/test/harness.ts).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, api as client } from '@/lib/api';
import { freshPinia, startApi, type TestApi } from '@/test/harness';
import { useCatalog } from './catalog';

let api: TestApi;
let closed = false;

beforeEach(async () => {
  freshPinia();
  api = await startApi();
  closed = false;
  api.ctx.store.createProvider({ name: 'Local', kind: 'ollama', baseUrl: 'http://127.0.0.1:1', defaultModel: 'test-model' });
});
afterEach(async () => {
  if (!closed) await api.close();
});

describe('catálogo', () => {
  it('carga proveedores, agentes, herramientas y workflows, y los mantiene al día', async () => {
    const catalog = useCatalog();
    expect(catalog.loaded).toBe(false);
    await catalog.ensure();
    expect(catalog.loaded).toBe(true);
    expect(catalog.providers.map((p) => p.name)).toEqual(['Local']);
    expect(catalog.tools.length).toBeGreaterThan(5);
    expect(catalog.enabledToolNames).toContain('calculator');

    const agent = await client.agents.create({
      name: 'Nuevo',
      role: '',
      description: '',
      color: '#6366f1',
      providerId: catalog.providers[0].id,
      model: 'test-model',
      systemPrompt: '',
      temperature: 0.2,
      maxTokens: null,
      maxIterations: 4,
      tools: [],
      thinking: false,
    });
    catalog.setAgent(agent);
    expect(catalog.agentById.get(agent.id)?.name).toBe('Nuevo');
    catalog.setAgent({ ...agent, name: 'Renombrado' });
    expect(catalog.agents).toHaveLength(1);
    expect(catalog.agentById.get(agent.id)?.name).toBe('Renombrado');
    catalog.dropAgent(agent.id);
    expect(catalog.agents).toHaveLength(0);
  });

  it('la salud de los proveedores se refresca y no cambia el estado de conexión', async () => {
    const catalog = useCatalog();
    await catalog.refreshHealth(true);
    expect(catalog.health).toHaveLength(1);
    expect(catalog.healthById.get(catalog.health[0].providerId)?.ok).toBe(true);
    expect(catalog.online).toBe(true);
  });
});

describe('estado de la conexión con el servidor', () => {
  it('un 429 (límite de peticiones) no es «sin conexión»: el servidor está ahí', async () => {
    const catalog = useCatalog();
    // Se agota el cupo de verdad: el propio servidor responde 429 a todo lo que venga después.
    api.ctx.config.rateLimitPerMinute = 3;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await fetch('/api/health/live')).status);
    expect(statuses.slice(-2)).toEqual([429, 429]);

    expect(await catalog.checkServer()).toBe(true);
    expect(catalog.online).toBe(true);
    // Y el error que ve la interfaz lleva el código estable.
    const error = await client.agents.list().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: 'rate_limited' });
    // Un fallo al refrescar la salud tampoco lo marca como caído.
    await catalog.refreshHealth(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(catalog.online).toBe(true);
  });

  it('con el servidor parado pasa a «sin conexión», y vuelve al arrancarlo', async () => {
    const catalog = useCatalog();
    expect(await catalog.checkServer()).toBe(true);
    const url = api.url;
    await api.close();
    closed = true;
    // `fetch` ya no pasa por el envoltorio de pruebas: se resuelve la ruta a mano contra el servidor parado.
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => nativeFetch(typeof input === 'string' && input.startsWith('/') ? `${url}${input}` : input, init)) as typeof fetch;
    try {
      expect(await catalog.checkServer()).toBe(false);
      expect(catalog.online).toBe(false);
      const error = await client.agents.list().catch((err: unknown) => err);
      expect(error).toMatchObject({ status: 0, code: 'network' });
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });
});
