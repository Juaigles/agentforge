// Utilidades para los tests de componentes.
//
// Los formularios se prueban contra la API real de AgentForge (Fastify + SQLite en memoria) arrancada dentro
// del propio test; lo único simulado es el proveedor LLM, en la misma frontera (`LlmFactory`) que usan los
// tests del servidor. `fetch` solo se envuelve para resolver las rutas relativas (`/api/...`) contra ese
// servidor, igual que haría el navegador.
import type { FastifyInstance } from 'fastify';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { buildApp } from '../../../server/src/app';
import type { AppContext } from '../../../server/src/context';
import { makeContext, ScriptedLlm, type ScriptHandler } from '../../../server/test/helpers';

export interface TestApi {
  ctx: AppContext;
  llm: ScriptedLlm;
  url: string;
  close(): Promise<void>;
}

export async function startApi(handler: ScriptHandler = () => ({ content: 'ok' })): Promise<TestApi> {
  const llm = new ScriptedLlm(handler);
  const ctx = makeContext(llm);
  const app: FastifyInstance = await buildApp(ctx);
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    nativeFetch(typeof input === 'string' && input.startsWith('/') ? `${url}${input}` : input, init)) as typeof fetch;
  return {
    ctx,
    llm,
    url,
    async close() {
      globalThis.fetch = nativeFetch;
      await app.close();
      await ctx.close();
    },
  };
}

const Blank = { template: '<div />' };

/** Router en memoria con las rutas que enlazan los componentes bajo prueba. */
export function testRouter(extra: Array<{ path: string; component: object }> = []): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [...extra, { path: '/:pathMatch(.*)*', component: Blank }],
  });
}

export function freshPinia(): Pinia {
  const pinia = createPinia();
  setActivePinia(pinia);
  return pinia;
}

/** jsdom no implementa matchMedia; los componentes lo usan para distinguir pantallas táctiles. */
export function setTouchDevice(touch: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('hover: none') ? touch : false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** Espera a que se cumpla una condición que depende de peticiones HTTP reales. */
export async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('La condición no se cumplió a tiempo.');
    await new Promise((r) => setTimeout(r, 10));
  }
}
