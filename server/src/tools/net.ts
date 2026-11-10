// Acceso HTTP para herramientas con protección SSRF: por defecto se bloquean redes privadas y localhost.
//
// La conexión se hace SIEMPRE a la dirección IP que se ha validado («fijación de DNS»): el nombre se resuelve
// una sola vez por salto y esa misma IP es la que usa el socket. Así un DNS malicioso no puede responder una IP
// pública a la comprobación y una privada a la conexión (DNS rebinding).
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Readable } from 'node:stream';
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
  return (
    (g[0] & 0xfe00) === 0xfc00 || // fc00::/7 direcciones locales únicas
    (g[0] & 0xffc0) === 0xfe80 || // fe80::/10 enlace local
    (g[0] & 0xffc0) === 0xfec0 || // fec0::/10 local de sitio (obsoleta)
    (g[0] & 0xff00) === 0xff00 // ff00::/8 multidifusión
  );
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

function decoded(res: http.IncomingMessage): Readable {
  const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
  if (encoding === 'gzip' || encoding === 'x-gzip') return res.pipe(zlib.createGunzip());
  if (encoding === 'deflate') return res.pipe(zlib.createInflate());
  if (encoding === 'br') return res.pipe(zlib.createBrotliDecompress());
  return res;
}

/** fetch con validación y fijación del destino en cada redirección, timeout y límite de tamaño de respuesta. */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 20_000)]);
  const maxBytes = opts.maxBytes ?? 500_000;
  let current = rawUrl;
  let method = (opts.method ?? 'GET').toUpperCase();
  let body = opts.body;

  for (let hop = 0; hop <= 5; hop++) {
    const target = await resolveTarget(current, opts.allowPrivate, opts.lookup);
    const { url } = target;
    const hasBody = method !== 'GET' && method !== 'HEAD' && body !== undefined;
    let res: http.IncomingMessage;
    try {
      res = await pinnedRequest(target, {
        method,
        headers: { 'User-Agent': 'AgentForge/0.1', Accept: '*/*', 'Accept-Encoding': 'gzip, deflate, br', ...opts.headers },
        body: hasBody ? body : undefined,
        signal,
      });
    } catch (err) {
      if (opts.signal.aborted) throw opts.signal.reason;
      if (signal.aborted) throw new ToolError(`La petición a ${url.host} superó el tiempo de espera.`);
      throw new ToolError(`Fallo de red al conectar con ${url.host}: ${(err as Error).message}`);
    }

    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      res.destroy();
      current = new URL(location, url).toString();
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
      if (signal.aborted) throw new ToolError(`La petición a ${url.host} superó el tiempo de espera.`);
      throw new ToolError(`Fallo de red al leer la respuesta de ${url.host}: ${(err as Error).message}`);
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

/** Convierte HTML en texto legible (sin scripts, estilos ni etiquetas). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
