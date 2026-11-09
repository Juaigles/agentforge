// Herramientas integradas. Cada una es un objeto ToolDefinition independiente.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceFile } from '../../../shared/types';
import { ToolError } from '../errors';
import { truncate } from '../util';
import { evaluateExpression } from './calc';
import { htmlToText, safeFetch } from './net';
import { runJavaScript } from './sandbox';
import type { ToolDefinition } from './types';

const MAX_READ_BYTES = 200_000;
const MAX_WRITE_BYTES = 1_000_000;

/** Resuelve una ruta relativa dentro del workspace e impide salir de él (path traversal). */
export function resolveInWorkspace(root: string, relPath: string): string {
  const base = path.resolve(root);
  const target = path.resolve(base, relPath.replace(/^[/\\]+/, ''));
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new ToolError(`Ruta fuera del espacio de trabajo: ${relPath}`);
  }
  return target;
}

export async function listWorkspaceFiles(root: string, dir = ''): Promise<WorkspaceFile[]> {
  const abs = resolveInWorkspace(root, dir || '.');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const files: WorkspaceFile[] = [];
  for (const entry of entries) {
    const rel = path.posix.join(dir.replace(/\\/g, '/'), entry.name);
    if (entry.isDirectory()) files.push(...(await listWorkspaceFiles(root, rel)));
    else if (entry.isFile()) {
      const stat = await fs.stat(path.join(abs, entry.name));
      files.push({ path: rel, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
    if (files.length >= 500) break;
  }
  return files;
}

const calculator: ToolDefinition = {
  name: 'calculator',
  title: 'Calculadora',
  category: 'Utilidades',
  description:
    'Evalúa una expresión matemática con precisión. Soporta + - * / % ^, paréntesis, constantes (pi, e) y funciones (sqrt, abs, round, floor, ceil, min, max, pow, exp, ln, log, sin, cos, tan).',
  parameters: {
    type: 'object',
    properties: { expression: { type: 'string', description: 'Expresión matemática a evaluar.' } },
    required: ['expression'],
  },
  async execute({ expression }) {
    return { expression, result: evaluateExpression(expression) };
  },
};

const currentDatetime: ToolDefinition = {
  name: 'current_datetime',
  title: 'Fecha y hora actual',
  category: 'Utilidades',
  description: 'Devuelve la fecha y hora actuales (ISO 8601, hora local y día de la semana).',
  parameters: {
    type: 'object',
    properties: { timezone: { type: 'string', description: 'Zona horaria IANA opcional, p. ej. "Europe/Madrid".' } },
  },
  async execute({ timezone }) {
    const now = new Date();
    let tz = timezone as string | undefined;
    try {
      if (tz) new Intl.DateTimeFormat('es-ES', { timeZone: tz });
    } catch {
      throw new ToolError(`Zona horaria no válida: ${tz}`);
    }
    tz ??= Intl.DateTimeFormat().resolvedOptions().timeZone;
    return {
      iso: now.toISOString(),
      timezone: tz,
      local: new Intl.DateTimeFormat('es-ES', { dateStyle: 'full', timeStyle: 'long', timeZone: tz }).format(now),
      unixSeconds: Math.floor(now.getTime() / 1000),
    };
  },
};

const httpRequest: ToolDefinition = {
  name: 'http_request',
  title: 'Petición HTTP',
  category: 'Red',
  description:
    'Realiza una petición HTTP(S) a una API y devuelve el estado, las cabeceras y el cuerpo (JSON si es posible). Útil para consultar APIs REST.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL completa (http o https).' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET', description: 'Método HTTP.' },
      headers: { type: 'object', description: 'Cabeceras como objeto JSON.' },
      body: { type: 'string', description: 'Cuerpo de la petición (texto o JSON serializado).' },
    },
    required: ['url'],
  },
  async execute({ url, method, headers, body }, ctx) {
    const res = await safeFetch(url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(headers ?? {}) },
      body,
      signal: ctx.signal,
      allowPrivate: ctx.settings.allowPrivateNetwork,
    });
    let parsed: unknown = truncate(res.text, 12_000);
    if ((res.headers['content-type'] ?? '').includes('json') && !res.truncated && res.text.length <= 12_000) {
      try {
        parsed = JSON.parse(res.text);
      } catch {
        /* se devuelve como texto */
      }
    }
    return { status: res.status, statusText: res.statusText, contentType: res.headers['content-type'] ?? null, body: parsed };
  },
};

const webFetch: ToolDefinition = {
  name: 'web_fetch',
  title: 'Leer página web',
  category: 'Red',
  description:
    'Descarga una página web y devuelve su contenido como texto legible (sin HTML). Útil para leer artículos o documentación.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL de la página (http o https).' },
      max_chars: { type: 'integer', description: 'Máximo de caracteres a devolver.', default: 6000 },
    },
    required: ['url'],
  },
  async execute({ url, max_chars }, ctx) {
    const res = await safeFetch(url, { signal: ctx.signal, allowPrivate: ctx.settings.allowPrivateNetwork, maxBytes: 1_500_000 });
    if (res.status >= 400) throw new ToolError(`La página respondió ${res.status} ${res.statusText}.`);
    const isHtml = (res.headers['content-type'] ?? '').includes('html') || /^\s*<(!doctype|html)/i.test(res.text);
    const title = isHtml ? (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(res.text)?.[1]?.trim() ?? null) : null;
    const text = isHtml ? htmlToText(res.text) : res.text;
    return { url: res.url, title, content: truncate(text, Math.min(Math.max(Number(max_chars) || 6000, 200), 30_000)) };
  },
};

const fileWrite: ToolDefinition = {
  name: 'file_write',
  title: 'Escribir archivo',
  category: 'Archivos',
  description:
    'Escribe (o sobrescribe) un archivo de texto en el espacio de trabajo de AgentForge. Útil para guardar informes, datos o código.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Ruta relativa dentro del espacio de trabajo, p. ej. "informes/resumen.md".' },
      content: { type: 'string', description: 'Contenido del archivo.' },
      append: { type: 'boolean', description: 'Si es true, añade al final en lugar de sobrescribir.', default: false },
    },
    required: ['path', 'content'],
  },
  async execute({ path: rel, content, append }, ctx) {
    if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new ToolError('El contenido supera el límite de 1 MB.');
    const target = resolveInWorkspace(ctx.workspaceDir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (append) await fs.appendFile(target, content, 'utf8');
    else await fs.writeFile(target, content, 'utf8');
    const stat = await fs.stat(target);
    return { path: path.relative(path.resolve(ctx.workspaceDir), target).replace(/\\/g, '/'), sizeBytes: stat.size, appended: Boolean(append) };
  },
};

const fileRead: ToolDefinition = {
  name: 'file_read',
  title: 'Leer archivo',
  category: 'Archivos',
  description: 'Lee un archivo de texto del espacio de trabajo de AgentForge.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Ruta relativa dentro del espacio de trabajo.' } },
    required: ['path'],
  },
  async execute({ path: rel }, ctx) {
    const target = resolveInWorkspace(ctx.workspaceDir, rel);
    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      throw new ToolError(`El archivo no existe: ${rel}`);
    }
    if (!stat.isFile()) throw new ToolError(`No es un archivo: ${rel}`);
    const handle = await fs.open(target, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_READ_BYTES));
      await handle.read(buffer, 0, buffer.length, 0);
      return { path: rel, sizeBytes: stat.size, truncated: stat.size > MAX_READ_BYTES, content: buffer.toString('utf8') };
    } finally {
      await handle.close();
    }
  },
};

const fileList: ToolDefinition = {
  name: 'file_list',
  title: 'Listar archivos',
  category: 'Archivos',
  description: 'Lista los archivos del espacio de trabajo de AgentForge (recursivo).',
  parameters: {
    type: 'object',
    properties: { directory: { type: 'string', description: 'Subdirectorio opcional.' } },
  },
  async execute({ directory }, ctx) {
    const files = await listWorkspaceFiles(ctx.workspaceDir, directory ?? '');
    return { count: files.length, files };
  },
};

const memorySet: ToolDefinition = {
  name: 'memory_set',
  title: 'Guardar en memoria compartida',
  category: 'Coordinación',
  description:
    'Guarda un dato en la memoria compartida de la ejecución. Otros agentes del mismo workflow pueden leerlo con memory_get.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Nombre del dato.' },
      value: { type: 'string', description: 'Valor a guardar.' },
    },
    required: ['key', 'value'],
  },
  async execute({ key, value }, ctx) {
    if (ctx.memory.size >= 200 && !ctx.memory.has(key)) throw new ToolError('La memoria compartida está llena (200 entradas).');
    ctx.memory.set(key, truncate(value, 20_000));
    return { saved: key, keys: [...ctx.memory.keys()] };
  },
};

const memoryGet: ToolDefinition = {
  name: 'memory_get',
  title: 'Leer memoria compartida',
  category: 'Coordinación',
  description:
    'Lee un dato de la memoria compartida de la ejecución. Sin "key" devuelve la lista de claves disponibles.',
  parameters: {
    type: 'object',
    properties: { key: { type: 'string', description: 'Nombre del dato a leer (opcional).' } },
  },
  async execute({ key }, ctx) {
    if (!key) return { keys: [...ctx.memory.keys()] };
    if (!ctx.memory.has(key)) return { key, found: false, keys: [...ctx.memory.keys()] };
    return { key, found: true, value: ctx.memory.get(key) };
  },
};

const delegateTask: ToolDefinition = {
  name: 'delegate_task',
  title: 'Delegar en otro agente',
  category: 'Coordinación',
  description:
    'Delega una subtarea en otro agente especializado y devuelve su respuesta. Da instrucciones completas y autocontenidas: el otro agente no ve esta conversación.',
  parameters: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'Nombre exacto del agente al que delegar.' },
      task: { type: 'string', description: 'Descripción completa de la subtarea.' },
    },
    required: ['agent', 'task'],
  },
  async execute({ agent, task }, ctx) {
    if (!ctx.delegate) throw new ToolError('La delegación solo está disponible durante la ejecución de un agente.');
    return { agent, response: await ctx.delegate(agent, task) };
  },
};

const runJavascript: ToolDefinition = {
  name: 'run_javascript',
  title: 'Ejecutar JavaScript',
  category: 'Código',
  dangerous: true,
  description:
    'Ejecuta código JavaScript en un entorno aislado (sin acceso a red, disco ni módulos) y devuelve el valor de la última expresión y lo impreso con console.log. Útil para cálculos y transformación de datos.',
  parameters: {
    type: 'object',
    properties: { code: { type: 'string', description: 'Código JavaScript. La última expresión es el resultado.' } },
    required: ['code'],
  },
  async execute({ code }, ctx) {
    if (!ctx.settings.allowCodeExecution) {
      throw new ToolError('La ejecución de código está desactivada. Puede habilitarse en Ajustes → "Permitir ejecución de código".');
    }
    return runJavaScript(code, { timeoutMs: 5000, signal: ctx.signal });
  },
};

export const BUILTIN_TOOLS: ToolDefinition[] = [
  calculator,
  currentDatetime,
  webFetch,
  httpRequest,
  fileWrite,
  fileRead,
  fileList,
  memorySet,
  memoryGet,
  delegateTask,
  runJavascript,
];
