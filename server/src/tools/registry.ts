// Registro de herramientas: integradas (código), de servidores MCP y personalizadas HTTP (definidas en la BD).
import { renderTemplate } from '../../../shared/template';
import type { CustomTool, ToolInfo } from '../../../shared/types';
import type { Store } from '../db/store';
import { msg } from '../../../shared/server-messages';
import { ToolError } from '../errors';
import { truncate } from '../util';
import { BUILTIN_TOOLS } from './builtin';
import type { McpManager } from './mcp';
import { safeFetch } from './net';
import type { ToolContext, ToolDefinition } from './types';
import { validateArgs } from './validate';

export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,48}$/;

/**
 * Rellena la plantilla del cuerpo con los argumentos. Si la plantilla es JSON (lo habitual), cada valor se
 * inserta ESCAPADO para JSON: los argumentos los decide el modelo, y un valor con comillas no debe romper el
 * cuerpo ni añadir o pisar campos (`x", "admin": true`). Un hueco entre comillas recibe el texto escapado; un
 * hueco suelto recibe el valor JSON completo (número, booleano, objeto o cadena con sus comillas).
 * Si la plantilla no es JSON se sustituye el texto tal cual.
 */
export function renderBodyTemplate(template: string, args: Record<string, unknown>): string {
  const has = (ref: string) => Object.hasOwn(args, ref);
  const asText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  // ¿Es JSON la plantilla? Se comprueba poniendo un valor neutro en cada hueco.
  let isJson = true;
  try {
    JSON.parse(template.replace(/"([^"\\]|\\.)*"|\{\{\s*[\w.-]+\s*\}\}/g, (m) => (m.startsWith('"') ? m.replace(/\{\{\s*[\w.-]+\s*\}\}/g, 'x') : '0')));
  } catch {
    isJson = false;
  }
  if (!isJson) return renderTemplate(template, (ref) => (has(ref) ? asText(args[ref]) : undefined));
  // Se recorre la plantilla distinguiendo lo que está dentro de una cadena JSON de lo que está fuera.
  return template.replace(/"(?:[^"\\]|\\.)*"|\{\{\s*([\w.-]+)\s*\}\}/g, (match, bare: string | undefined) => {
    if (bare !== undefined) return has(bare) ? JSON.stringify(args[bare] ?? null) : 'null';
    return match.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, ref: string) => (has(ref) ? JSON.stringify(asText(args[ref])).slice(1, -1) : ''));
  });
}

/** Convierte una herramienta HTTP personalizada en una ToolDefinition ejecutable. */
export function customToolDefinition(tool: CustomTool): ToolDefinition {
  return {
    name: tool.name,
    title: tool.name,
    description: tool.description,
    category: 'Personalizadas',
    parameters: tool.parameters,
    async execute(args, ctx) {
      const asText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
      const has = (ref: string) => Object.hasOwn(args, ref);
      const url = renderTemplate(tool.urlTemplate, (ref) => (has(ref) ? encodeURIComponent(asText(args[ref])) : undefined));
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(tool.headers ?? {})) {
        // Sin saltos de línea: un argumento no puede añadir cabeceras.
        headers[k] = renderTemplate(v, (ref) => (has(ref) ? asText(args[ref]).replace(/[\r\n]+/g, ' ') : undefined));
      }
      let body: string | undefined;
      if (tool.method !== 'GET' && tool.method !== 'DELETE') {
        body = tool.bodyTemplate.trim() ? renderBodyTemplate(tool.bodyTemplate, args) : JSON.stringify(args);
        if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
      }
      const res = await safeFetch(url, {
        method: tool.method,
        headers,
        body,
        signal: ctx.signal,
        allowPrivate: ctx.settings.allowPrivateNetwork,
      });
      let parsed: unknown = truncate(res.text, 12_000);
      if (!res.truncated && res.text.length <= 12_000) {
        try {
          parsed = JSON.parse(res.text);
        } catch {
          /* texto plano */
        }
      }
      if (res.status >= 400) throw new ToolError(msg('toolApiError', { status: res.status, detail: truncate(res.text, 500) }));
      return { status: res.status, body: parsed };
    },
  };
}

export class ToolRegistry {
  private readonly builtin = new Map<string, ToolDefinition>();

  constructor(
    private readonly store?: Store,
    private readonly mcp?: McpManager,
  ) {
    for (const tool of BUILTIN_TOOLS) this.register(tool);
  }

  /** Punto de extensión: registra una herramienta implementada en código. */
  register(tool: ToolDefinition): void {
    if (!TOOL_NAME_RE.test(tool.name)) throw new Error(`Nombre de herramienta no válido: ${tool.name}`);
    this.builtin.set(tool.name, tool);
  }

  isBuiltin(name: string): boolean {
    return this.builtin.has(name);
  }

  get(name: string): ToolDefinition | undefined {
    const builtin = this.builtin.get(name);
    if (builtin) return builtin;
    const external = this.mcp?.getTool(name);
    if (external) return external;
    const custom = this.store?.getCustomToolByName(name, true);
    return custom && custom.enabled ? customToolDefinition(custom) : undefined;
  }

  list(): ToolInfo[] {
    const tools: ToolInfo[] = [...this.builtin.values()].map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      category: t.category,
      parameters: t.parameters,
      source: 'builtin',
      dangerous: Boolean(t.dangerous),
      enabled: true,
    }));
    for (const { tool, serverId, serverName } of this.mcp?.tools() ?? []) {
      tools.push({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        category: tool.category,
        parameters: tool.parameters,
        source: 'mcp',
        dangerous: false,
        enabled: true,
        mcpServerId: serverId,
        mcpServerName: serverName,
      });
    }
    for (const c of this.store?.listCustomTools() ?? []) {
      tools.push({
        name: c.name,
        title: c.name,
        description: c.description,
        category: 'Personalizadas',
        parameters: c.parameters,
        source: 'custom',
        dangerous: false,
        enabled: c.enabled,
        customId: c.id,
      });
    }
    return tools;
  }

  names(): string[] {
    return this.list()
      .filter((t) => t.enabled)
      .map((t) => t.name);
  }

  /** Valida los argumentos y ejecuta la herramienta. */
  async invoke(name: string, rawArgs: unknown, ctx: ToolContext): Promise<unknown> {
    const tool = this.get(name);
    if (!tool) throw new ToolError(msg('toolNotAvailable', { name }));
    let args: Record<string, any>;
    if (tool.passthroughArgs) {
      if (rawArgs !== null && rawArgs !== undefined && (typeof rawArgs !== 'object' || Array.isArray(rawArgs))) throw new ToolError(msg('toolArgsNotObject'));
      args = (rawArgs ?? {}) as Record<string, any>;
    } else args = validateArgs(tool.parameters, rawArgs);
    if (ctx.signal.aborted) throw ctx.signal.reason;
    return tool.execute(args, ctx);
  }
}
