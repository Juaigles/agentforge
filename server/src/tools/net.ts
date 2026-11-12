// Acceso HTTP para herramientas con protección SSRF: por defecto se bloquean redes privadas y localhost.
//
// La conexión se hace SIEMPRE a la dirección IP que se ha validado («fijación de DNS»): el nombre se resuelve
// una sola vez por salto y esa misma IP es la que usa el socket. Así un DNS malicioso no puede responder una IP
// pública a la comprobación y una privada a la conexión (DNS rebinding).
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import { pipeline, type Readable } from 'node:stream';
import zlib from 'node:zlib';
import { ToolError } from '../errors';

function isPrivateV4(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number);
  return (
    a === 0 || // "esta red"
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // enlace local (incluye metadatos de nube)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // asignaciones de protocolo IETF
    (a === 192 && b === 88 && c === 99) || // retransmisión 6to4 (obsoleta)
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // pruebas de rendimiento
    a >= 224 // multidifusión y reservadas
  );
}

/** Expande una dirección IPv6 a sus 8 grupos de 16 bits (o null si no es válida). */
function expandV6(ip: string): number[] | null {
  let text = ip.toLowerCase().split('%')[0];
  // Sufijo IPv4 con puntos (::ffff:1.2.3.4) → dos grupos hexadecimales.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    if (!net.isIPv4(dotted[2])) return null;
    const [a, b, c, d] = dotted[2].split('.').map(Number);
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail, ...rest] = text.split('::');
  if (rest.length) return null;
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill('0'), ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const v4FromGroups = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/** ¿La dirección pertenece a una red privada, local o reservada (IPv4 o IPv6, en cualquiera de sus notaciones)? */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  const g = expandV6(ip);
  if (!g) return true; // lo que no se entiende, se bloquea
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  // Direcciones IPv4 «disfrazadas» de IPv6: mapeadas (::ffff:a.b.c.d, también en hexadecimal), compatibles
  // (::a.b.c.d) y NAT64 (64:ff9b::/96). Se juzgan por la IPv4 que contienen.
  if (zeros(5) && g[5] === 0xffff) return isPrivateV4(v4FromGroups(g[6], g[7]));
  if (zeros(6)) return g[6] === 0 && g[7] <= 1 ? true : isPrivateV4(v4FromGroups(g[6], g[7])); // :: y ::1 incluidos
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateV4(v4FromGroups(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // 64:ff9b:1::/48, NAT64 de uso local
  if (g[0] === 0x2002) return isPrivateV4(v4FromGroups(g[1], g[2])); // 6to4: lleva la IPv4 en los grupos 1 y 2
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo (2001::/32): túnel hacia una IPv4 arbitraria
  return (
    (g[0] & 0xfe00) === 0xfc00 || // fc00::/7 direcciones locales únicas
    (g[0] & 0xffc0) === 0xfe80 || // fe80::/10 enlace local
    (g[0] & 0xffc0) === 0xfec0 || // fec0::/10 local de sitio (obsoleta)
    (g[0] & 0xff00) === 0xff00 // ff00::/8 multidifusión
  );
}

// Puertos de este mismo equipo que las herramientas no pueden tocar nunca, ni siquiera con «redes privadas»
// permitidas: la API de AgentForge. Sin esto, un agente que lea contenido no fiable podría cambiar los ajustes
// o pedir las claves llamando a http://127.0.0.1:<puerto>/api.
const protectedPorts = new Set<number>();

/** Declara un puerto local como inalcanzable para las herramientas. Devuelve la función que lo libera. */
export function protectLocalPort(port: number): () => void {
  protectedPorts.add(port);
  return () => protectedPorts.delete(port);
}

function isOwnAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    if (ip.startsWith('127.') || ip === '0.0.0.0') return true;
  } else {
    const g = expandV6(ip);
    if (!g) return true;
    const head = g.slice(0, 5).every((x) => x === 0);
    // :: y ::1, y las IPv4 de loopback mapeadas (::ffff:127.x.x.x) o compatibles.
    if (head && g[5] === 0 && g[6] === 0 && g[7] <= 1) return true;
    if (head && (g[5] === 0xffff || g[5] === 0) && g[6] >> 8 === 127) return true;
  }
  for (const list of Object.values(os.networkInterfaces())) {
    if (list?.some((iface) => iface.address.toLowerCase() === ip.toLowerCase())) return true;
  }
  return false;
}

/** Resuelve un nombre de host a sus direcciones IP. Sustituible en tests. */
export type HostLookup = (host: string) => Promise<string[]>;
const systemLookup: HostLookup = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

export interface ResolvedTarget {
  url: URL;
  /** IP validada a la que se conectará el socket. */
  address: string;
  family: 4 | 6;
}

/**
 * Valida el destino y elige la IP a la que conectar. Con `allowPrivate` no se filtra, pero la resolución
 * sigue siendo única (la conexión usa exactamente la IP devuelta).
 */
export async function resolveTarget(rawUrl: string, allowPrivate: boolean, lookupHost: HostLookup = systemLookup): Promise<ResolvedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ToolError(`URL no válida: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolError(`Protocolo no permitido: ${url.protocol} (solo http y https).`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (net.isIP(host)) addresses = [host];
  else {
    try {
      addresses = await lookupHost(host);
    } catch {
      throw new ToolError(`No se pudo resolver el host: ${host}`);
    }
    addresses = addresses.filter((a) => net.isIP(a));
    if (!addresses.length) throw new ToolError(`No se pudo resolver el host: ${host}`);
  }
  // Basta una dirección privada entre las respuestas para rechazar el nombre entero.
  if (!allowPrivate && addresses.some(isPrivateAddress)) {
    throw new ToolError(`Acceso bloqueado a red privada o local (${host}). Puede habilitarse en Ajustes → "Permitir redes privadas".`);
  }
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  if (protectedPorts.has(port) && addresses.some(isOwnAddress)) {
    throw new ToolError(`Acceso bloqueado: las herramientas no pueden llamar a la propia API de AgentForge (${url.host}).`);
  }
  const address = addresses.find((a) => net.isIPv4(a)) ?? addresses[0];
  return { url, address, family: net.isIPv4(address) ? 4 : 6 };
}

/** Valida una URL para las herramientas de red (compatibilidad: devuelve solo la URL). */
export async function assertUrlAllowed(rawUrl: string, allowPrivate: boolean, lookupHost?: HostLookup): Promise<URL> {
  return (await resolveTarget(rawUrl, allowPrivate, lookupHost)).url;
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  allowPrivate: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  /** Resolución de nombres (por defecto, la del sistema). */
  lookup?: HostLookup;
}

export interface SafeFetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  url: string;
  text: string;
  truncated: boolean;
}

/** Lanza una petición cuyo socket se conecta a la IP ya validada, sin volver a consultar el DNS. */
function pinnedRequest(
  target: ResolvedTarget,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
): Promise<http.IncomingMessage> {
  const { url, address, family } = target;
  const transport = url.protocol === 'https:' ? https : http;
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(init.body));
  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: init.method,
        headers,
        signal: init.signal,
        agent: false, // una conexión nueva por petición: nada de sockets reutilizados hacia otra IP
        // Node llama a esta función en lugar de consultar el DNS: siempre recibe la IP validada.
        lookup: (_hostname, options, callback) => {
          const cb = callback as (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void;
          if (typeof options === 'object' && options.all) cb(null, [{ address, family }]);
          else cb(null, address, family);
        },
      },
      resolve,
    );
    req.on('error', reject);
    req.end(init.body);
  });
}

/**
 * Cuerpo de la respuesta ya descomprimido. Se usa `pipeline` y no `pipe`: `pipe` no propaga ni el error ni el
 * cierre del origen, así que una respuesta comprimida que se cortara a medias (o que se abortara) dejaba al
 * descompresor esperando para siempre, y con él a la herramienta, a la ejecución y al apagado del servidor.
 */
function decoded(res: http.IncomingMessage): Readable {
  const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
  const decoder =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? zlib.createGunzip()
      : encoding === 'deflate'
        ? zlib.createInflate()
        : encoding === 'br'
          ? zlib.createBrotliDecompress()
          : null;
  if (!decoder) return res;
  // El error llega al consumidor a través del propio descompresor (pipeline lo destruye con él).
  pipeline(res, decoder, () => undefined);
  return decoder;
}

/** Cabeceras propias del cliente: las únicas que se conservan al seguir una redirección hacia otro origen. */
const BASE_HEADERS = { 'User-Agent': 'AgentForge/0.1', Accept: '*/*', 'Accept-Encoding': 'gzip, deflate, br' };

/** fetch con validación y fijación del destino en cada redirección, timeout y límite de tamaño de respuesta. */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 20_000)]);
  const maxBytes = opts.maxBytes ?? 500_000;
  let current = rawUrl;
  let method = (opts.method ?? 'GET').toUpperCase();
  let body = opts.body;
  // Las cabeceras de quien llama (Authorization, cookies, claves de API…) solo viajan al origen inicial.
  let extraHeaders: Record<string, string> = opts.headers ?? {};
  let origin: string | null = null;

  for (let hop = 0; hop <= 5; hop++) {
    const target = await resolveTarget(current, opts.allowPrivate, opts.lookup);
    const { url } = target;
    origin ??= url.origin;
    if (url.origin !== origin) extraHeaders = {};
    const hasBody = method !== 'GET' && method !== 'HEAD' && body !== undefined;
    let res: http.IncomingMessage;
    try {
      res = await pinnedRequest(target, {
        method,
        headers: { ...BASE_HEADERS, ...extraHeaders },
        body: hasBody ? body : undefined,
        signal,
      });
    } catch (err) {
      if (opts.signal.aborted) throw opts.signal.reason;
      if (signal.aborted) throw new ToolError(`La petición a ${url.host} superó el tiempo de espera.`, { retryable: true });
      throw new ToolError(`Fallo de red al conectar con ${url.host}: ${(err as Error).message}`, { retryable: true });
    }

    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      res.destroy();
      const next = new URL(location, url);
      if (url.protocol === 'https:' && next.protocol === 'http:') {
        throw new ToolError(`Redirección rechazada: ${url.host} redirige de https a http (${next.host}).`);
      }
      current = next.toString();
      if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }

    // Se lee como mucho maxBytes para no cargar respuestas enormes en memoria.
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    try {
      for await (const chunk of decoded(res) as AsyncIterable<Buffer>) {
        if (size + chunk.length > maxBytes) {
          chunks.push(chunk.subarray(0, maxBytes - size));
          truncated = true;
          break;
        }
        chunks.push(chunk);
        size += chunk.length;
      }
    } catch (err) {
      if (opts.signal.aborted) throw opts.signal.reason;
      if (signal.aborted) throw new ToolError(`La petición a ${url.host} superó el tiempo de espera.`, { retryable: true });
      throw new ToolError(`Fallo de red al leer la respuesta de ${url.host}: ${(err as Error).message}`, { retryable: true });
    } finally {
      res.destroy();
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(res.headers)) {
      if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    return {
      status,
      statusText: res.statusMessage ?? '',
      headers,
      url: url.toString(),
      text: Buffer.concat(chunks).toString('utf8'),
      truncated,
    };
  }
  throw new ToolError('Demasiadas redirecciones.');
}

/** HTML que se convierte como mucho: lo que sobra no aporta a un modelo y solo cuesta tiempo. */
const MAX_HTML_CHARS = 600_000;
const SKIPPED_BLOCKS = ['script', 'style', 'noscript', 'svg', 'head'];

/**
 * Quita del HTML los bloques que no son contenido (scripts, estilos, cabecera, comentarios) en UNA pasada.
 * Antes se hacía con expresiones regulares perezosas, que con miles de aperturas sin cierre (una página
 * maliciosa, o simplemente cortada por el límite de tamaño) tardaban minutos y congelaban el servidor.
 */
function stripBlocks(html: string): string {
  const lower = html.toLowerCase();
  let out = '';
  let pos = 0;
  while (pos < html.length) {
    const open = lower.indexOf('<', pos);
    if (open < 0) break;
    out += html.slice(pos, open);
    if (lower.startsWith('<!--', open)) {
      const close = lower.indexOf('-->', open + 4);
      if (close < 0) return out; // comentario sin cerrar: el resto se descarta
      pos = close + 3;
      continue;
    }
    const name = SKIPPED_BLOCKS.find((tag) => lower.startsWith(tag, open + 1) && !/[a-z0-9-]/.test(lower[open + 1 + tag.length] ?? ''));
    if (name) {
      const close = lower.indexOf(`</${name}`, open + 1);
      if (close < 0) return out; // bloque sin cerrar: el resto se descarta
      const end = lower.indexOf('>', close);
      if (end < 0) return out;
      out += ' ';
      pos = end + 1;
      continue;
    }
    out += '<';
    pos = open + 1;
  }
  return out + html.slice(pos);
}

/** Título de la página (contenido de <title>), sin expresiones regulares que retrocedan. */
export function htmlTitle(html: string): string | null {
  const lower = html.slice(0, MAX_HTML_CHARS).toLowerCase();
  const open = lower.indexOf('<title');
  if (open < 0) return null;
  const start = lower.indexOf('>', open);
  const close = start < 0 ? -1 : lower.indexOf('</title', start);
  if (start < 0 || close < 0) return null;
  return (
    decodeEntities(html.slice(start + 1, close))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300) || null
  );
}

const NAMED_ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"' };

/** Decodifica las entidades HTML habituales en una sola pasada: «&amp;lt;» es el texto «&lt;», no «<». */
function decodeEntities(text: string): string {
  return text.replace(/&(?:(nbsp|amp|lt|gt|quot)|#(\d{1,7}));/g, (match, name: string | undefined, code: string | undefined) => {
    if (name) return NAMED_ENTITIES[name];
    const n = Number(code);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
  });
}

/** Convierte HTML en texto legible (sin scripts, estilos ni etiquetas). Coste lineal en el tamaño de la entrada. */
export function htmlToText(html: string): string {
  const text = stripBlocks(html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html)
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^<>]*>/g, ' ');
  return decodeEntities(text)
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
