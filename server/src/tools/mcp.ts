// Cliente MCP (Model Context Protocol): tercera fuente de herramientas, junto a las integradas y las HTTP
// personalizadas. Cada servidor configurado es un programa externo (que se arranca aquí y habla por stdio) o una
// dirección HTTP; sus herramientas se ofrecen a los agentes con el nombre `servidor__herramienta`.
//
// La lista de herramientas de cada servidor se guarda en la base de datos: así los agentes y workflows que las
// usan siguen siendo válidos mientras el servidor arranca o si está caído un momento. Al usarlas sin conexión se
// intenta reconectar una vez.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { JsonSchema, McpServer, McpStatus } from '../../../shared/types';
import type { Store, StoredMcpServer } from '../db/store';
import { ToolError } from '../errors';
import { errorMessage, silentLogger, truncate, type Logger } from '../util';
import type { ToolDefinition } from './types';

/** Herramienta de un servidor MCP tal como se guarda: el nombre con el que la ven los agentes y el original. */
export interface McpToolSnapshot {
  name: string;
  remoteName: string;
  description: string;
  parameters: JsonSchema;
}

interface Connection {
  server: StoredMcpServer;
  client: Client | null;
  status: McpStatus;
  error: string | null;
  tools: McpToolSnapshot[];
  /** Conexión en curso (para no abrir dos a la vez). */
  connecting: Promise<void> | null;
  /** Últimas líneas que el programa escribió por su salida de errores (para explicar por qué no arranca). */
  stderr: string;
}

const MAX_NAME = 49;
const MAX_RESULT_CHARS = 50_000;

/** Nombre local de una herramienta: `servidor__herramienta`, solo minúsculas, números y «_», sin repetir. */
export function localToolName(server: string, remote: string, taken: Set<string>): string {
  const clean = remote
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const prefix = `${server}__`;
  const base = (prefix + (clean || 'tool')).slice(0, MAX_NAME);
  let name = base;
  for (let i = 2; taken.has(name); i++) {
    const suffix = `_${i}`;
    name = base.slice(0, MAX_NAME - suffix.length) + suffix;
  }
  taken.add(name);
  return name;
}

/** El esquema de entrada de MCP es JSON Schema completo; se pasa tal cual al modelo, garantizando la forma mínima. */
function toParameters(schema: unknown): JsonSchema {
  const s = schema && typeof schema === 'object' && !Array.isArray(schema) ? (schema as Record<string, unknown>) : {};
  const properties = s.properties && typeof s.properties === 'object' ? s.properties : {};
  return { ...s, type: 'object', properties } as JsonSchema;
}

/** Convierte el resultado de una llamada (bloques de contenido) en texto para el modelo. */
export function mcpResultText(result: { content?: unknown; structuredContent?: unknown }): string {
  const parts: string[] = [];
  for (const block of Array.isArray(result.content) ? (result.content as Array<Record<string, unknown>>) : []) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'resource' && block.resource && typeof (block.resource as { text?: unknown }).text === 'string') parts.push((block.resource as { text: string }).text);
    else if (block.type === 'resource_link' && typeof block.uri === 'string') parts.push(`[recurso: ${block.uri}]`);
    else if (typeof block.type === 'string') parts.push(`[${block.type}${typeof block.mimeType === 'string' ? ` ${block.mimeType}` : ''}: contenido no textual omitido]`);
  }
  if (!parts.length && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  return truncate(parts.join('\n'), MAX_RESULT_CHARS);
}

export interface McpManagerOptions {
  log?: () => Logger;
  /** Tiempo máximo para arrancar el programa o conectar y recibir la lista de herramientas. */
  connectTimeoutMs?: number;
  /** Tiempo máximo de una llamada a una herramienta. */
  callTimeoutMs?: number;
}

export class McpManager {
  private readonly connections = new Map<string, Connection>();
  private closed = false;

  constructor(
    private readonly store: Store,
    private readonly opts: McpManagerOptions = {},
  ) {
    for (const server of store.listMcpServers()) this.track(server);
  }

  private get log(): Logger {
    return this.opts.log?.() ?? silentLogger;
  }

  private track(server: StoredMcpServer): Connection {
    const previous = this.connections.get(server.id);
    const connection: Connection = {
      server,
      client: null,
      status: server.enabled ? 'connecting' : 'disabled',
      error: null,
      tools: previous?.tools ?? this.store.getMcpTools<McpToolSnapshot>(server.id),
      connecting: null,
      stderr: '',
    };
    this.connections.set(server.id, connection);
    return connection;
  }

  /** Conecta en segundo plano todos los servidores activos. Devuelve la promesa por si se quiere esperar (tests). */
  start(): Promise<void> {
    return Promise.all([...this.connections.values()].filter((c) => c.server.enabled).map((c) => this.connect(c).catch(() => undefined))).then(() => undefined);
  }

  /** Vuelve a leer un servidor de la base de datos (tras crearlo, editarlo o borrarlo) y lo (re)conecta. */
  async sync(id: string): Promise<McpServer | null> {
    const existing = this.connections.get(id);
    if (existing) await this.disconnect(existing);
    const server = this.store.getMcpServer(id);
    if (!server) {
      this.connections.delete(id);
      return null;
    }
    const renamed = existing && existing.server.name !== server.name;
    const connection = this.track(server);
    // Con otro nombre, las herramientas guardadas ya no valen (llevan el prefijo antiguo).
    if (renamed) connection.tools = [];
    if (server.enabled) await this.connect(connection).catch(() => undefined);
    return this.describe(connection);
  }

  private async disconnect(connection: Connection): Promise<void> {
    const client = connection.client;
    connection.client = null;
    if (client) {
      client.onclose = undefined;
      await client.close().catch(() => undefined);
    }
  }

  private connect(connection: Connection): Promise<void> {
    if (connection.connecting) return connection.connecting;
    connection.status = 'connecting';
    connection.connecting = this.open(connection)
      .then(() => {
        connection.status = 'connected';
        connection.error = null;
      })
      .catch((err) => {
        const detail = connection.stderr.trim().split('\n').slice(-3).join(' · ');
        connection.status = 'error';
        connection.error = truncate(`${errorMessage(err)}${detail ? ` — ${detail}` : ''}`, 600);
        this.log.warn({ mcp: connection.server.name, err: connection.error }, 'No se pudo conectar con un servidor MCP');
        throw err;
      })
      .finally(() => {
        connection.connecting = null;
      });
    return connection.connecting;
  }

  private async open(connection: Connection): Promise<void> {
    const { server } = connection;
    const timeoutMs = this.opts.connectTimeoutMs ?? 20_000;
    connection.stderr = '';
    const client = new Client(
      { name: 'agentforge', version: '0.1.0' },
      {
        listChanged: {
          tools: {
            // El servidor avisa de que su lista ha cambiado: se vuelve a leer.
            onChanged: (error, tools) => {
              if (!error && tools && connection.client === client) this.setTools(connection, tools);
            },
          },
        },
      },
    );
    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    if (server.transport === 'stdio') {
      const stdio = new StdioClientTransport({ command: server.command, args: server.args, env: { ...getDefaultEnvironment(), ...server.env }, stderr: 'pipe' });
      stdio.stderr?.on('data', (chunk: Buffer) => {
        connection.stderr = (connection.stderr + chunk.toString('utf8')).slice(-2000);
      });
      transport = stdio;
    } else {
      transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } });
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (async () => {
          await client.connect(transport);
          const tools: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
          let cursor: string | undefined;
          do {
            const page = await client.listTools(cursor ? { cursor } : undefined);
            tools.push(...page.tools);
            cursor = page.nextCursor;
          } while (cursor && tools.length < 500);
          this.setTools(connection, tools);
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`No respondió en ${Math.round(timeoutMs / 1000)} s.`)), timeoutMs);
        }),
      ]);
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (this.closed || this.connections.get(server.id) !== connection) {
      await client.close().catch(() => undefined);
      throw new Error('La conexión ya no hace falta.');
    }
    client.onclose = () => {
      if (connection.client !== client) return;
      connection.client = null;
      connection.status = 'error';
      connection.error = 'Se perdió la conexión. Se volverá a intentar cuando un agente use una de sus herramientas.';
    };
    connection.client = client;
  }

  private setTools(connection: Connection, tools: Array<{ name: string; description?: string; inputSchema?: unknown }>): void {
    const taken = new Set<string>();
    connection.tools = tools.map((t) => ({
      name: localToolName(connection.server.name, t.name, taken),
      remoteName: t.name,
      description: truncate(t.description ?? '', 2000),
      parameters: toParameters(t.inputSchema),
    }));
    this.store.setMcpTools(connection.server.id, connection.tools);
  }

  private describe(connection: Connection): McpServer {
    const { server } = connection;
    return {
      id: server.id,
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args,
      envKeys: Object.keys(server.env),
      url: server.url,
      headerKeys: Object.keys(server.headers),
      enabled: server.enabled,
      status: connection.status,
      error: connection.error,
      tools: connection.tools.map((t) => ({ name: t.name, description: t.description })),
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
    };
  }

  list(): McpServer[] {
    return [...this.connections.values()].map((c) => this.describe(c)).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): McpServer | null {
    const connection = this.connections.get(id);
    return connection ? this.describe(connection) : null;
  }

  /** Cierra y vuelve a abrir la conexión, releyendo la lista de herramientas. */
  async reconnect(id: string): Promise<McpServer | null> {
    const connection = this.connections.get(id);
    if (!connection) return null;
    await this.disconnect(connection);
    if (connection.server.enabled) await this.connect(connection).catch(() => undefined);
    return this.describe(connection);
  }

  /** Herramientas de los servidores activos, estén o no conectados ahora mismo. */
  tools(): Array<{ tool: ToolDefinition; serverId: string; serverName: string }> {
    const out: Array<{ tool: ToolDefinition; serverId: string; serverName: string }> = [];
    for (const connection of this.connections.values()) {
      if (!connection.server.enabled) continue;
      for (const snapshot of connection.tools) out.push({ tool: this.definition(connection, snapshot), serverId: connection.server.id, serverName: connection.server.name });
    }
    return out;
  }

  getTool(name: string): ToolDefinition | undefined {
    const separator = name.indexOf('__');
    if (separator < 1) return undefined;
    for (const connection of this.connections.values()) {
      if (!connection.server.enabled || connection.server.name !== name.slice(0, separator)) continue;
      const snapshot = connection.tools.find((t) => t.name === name);
      if (snapshot) return this.definition(connection, snapshot);
    }
    return undefined;
  }

  private definition(connection: Connection, snapshot: McpToolSnapshot): ToolDefinition {
    return {
      name: snapshot.name,
      title: snapshot.remoteName,
      description: snapshot.description || `Herramienta «${snapshot.remoteName}» del servidor MCP ${connection.server.name}.`,
      category: `MCP · ${connection.server.name}`,
      parameters: snapshot.parameters,
      // El esquema es JSON Schema completo: lo valida el propio servidor MCP, que devuelve un error legible.
      passthroughArgs: true,
      execute: async (args, ctx) => {
        // Se usa siempre la conexión vigente del servidor (puede haberse recreado desde que se resolvió la herramienta).
        const current = this.connections.get(connection.server.id);
        if (!current || !current.server.enabled) throw new ToolError(`El servidor MCP «${connection.server.name}» ya no está disponible.`);
        if (!current.client) {
          try {
            await this.connect(current);
          } catch {
            throw new ToolError(`No se pudo conectar con el servidor MCP «${current.server.name}»: ${current.error ?? 'error desconocido'}`);
          }
        }
        let result: { content?: unknown; structuredContent?: unknown; isError?: boolean };
        try {
          result = await current.client!.callTool({ name: snapshot.remoteName, arguments: args }, { signal: ctx.signal, timeout: this.opts.callTimeoutMs ?? 120_000 });
        } catch (err) {
          if (ctx.signal.aborted) throw ctx.signal.reason;
          throw new ToolError(`El servidor MCP «${current.server.name}» falló: ${errorMessage(err)}`);
        }
        const text = mcpResultText(result);
        if (result.isError) throw new ToolError(text || 'La herramienta devolvió un error sin detalle.');
        return text;
      },
    };
  }

  /** Cierra todas las conexiones (y detiene los programas arrancados). */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.connections.values()].map((c) => this.disconnect(c)));
  }
}
