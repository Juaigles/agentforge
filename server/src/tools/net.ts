// Acceso HTTP para herramientas con protección SSRF: por defecto se bloquean redes privadas y localhost.
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { ToolError } from '../errors';

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

export async function assertUrlAllowed(rawUrl: string, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ToolError(`URL no válida: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolError(`Protocolo no permitido: ${url.protocol} (solo http y https).`);
  }
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (net.isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw new ToolError(`No se pudo resolver el host: ${host}`);
    }
  }
  if (addresses.some(isPrivateAddress)) {
    throw new ToolError(
      `Acceso bloqueado a red privada o local (${host}). Puede habilitarse en Ajustes → "Permitir redes privadas".`,
    );
  }
  return url;
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  allowPrivate: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface SafeFetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  url: string;
  text: string;
  truncated: boolean;
}

/** fetch con validación de destino en cada redirección, timeout y límite de tamaño de respuesta. */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 20_000)]);
  const maxBytes = opts.maxBytes ?? 500_000;
  let current = rawUrl;
  let method = opts.method ?? 'GET';
  let body = opts.body;

  for (let hop = 0; hop <= 5; hop++) {
    const url = await assertUrlAllowed(current, opts.allowPrivate);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { 'User-Agent': 'AgentForge/0.1', ...opts.headers },
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        redirect: 'manual',
        signal,
      });
    } catch (err) {
      if (opts.signal.aborted) throw opts.signal.reason;
      if (signal.aborted) throw new ToolError(`La petición a ${url.host} superó el tiempo de espera.`);
      throw new ToolError(`Fallo de red al conectar con ${url.host}: ${(err as Error).message}`);
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, url).toString();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      await res.body?.cancel();
      continue;
    }

    // Se lee como mucho maxBytes para no cargar respuestas enormes en memoria.
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.length > maxBytes) {
          chunks.push(value.subarray(0, maxBytes - size));
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
        size += value.length;
      }
    }
    return {
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
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
