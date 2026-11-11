// Defensas de la capa HTTP: hosts admitidos, clave de acceso, comprobación de origen, límite de tasa y
// cabeceras de seguridad. Todo son funciones puras o clases pequeñas; `app.ts` las conecta a Fastify.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from './config';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

/** Quita el puerto de una cabecera Host («ejemplo.com:4310», «[::1]:4310»). */
export function hostName(header: string | undefined): string {
  return (header ?? '').trim().toLowerCase().replace(/:\d+$/, '');
}

/**
 * Nombres por los que se acepta llegar al servidor (cabecera Host). La comprobación protege frente a DNS
 * rebinding y está SIEMPRE activa: cuando se escucha en todas las interfaces se admiten las direcciones del
 * propio equipo, su nombre y lo que se declare en AGENTFORGE_ALLOWED_HOSTS, nunca cualquier cosa.
 */
export function buildAllowedHosts(config: Pick<AppConfig, 'host' | 'allowedHosts'>): Set<string> {
  const allowed = new Set<string>([...LOCAL_HOSTS, ...config.allowedHosts.map((h) => h.toLowerCase())]);
  const host = config.host.toLowerCase();
  const bracket = (ip: string) => (ip.includes(':') ? `[${ip.split('%')[0]}]` : ip);
  if (WILDCARD_HOSTS.has(host)) {
    for (const list of Object.values(os.networkInterfaces())) for (const iface of list ?? []) allowed.add(bracket(iface.address.toLowerCase()));
    allowed.add(os.hostname().toLowerCase());
  } else {
    allowed.add(bracket(host.replace(/^\[|\]$/g, '')));
  }
  return allowed;
}

// ---------- Clave de acceso ----------
export const SESSION_COOKIE = 'af_session';

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Valor de la cookie de sesión: se deriva de la clave, así que no revela la clave ni necesita estado en el servidor. */
export function sessionValue(token: string): string {
  return createHmac('sha256', token).update('agentforge-session-v1').digest('hex');
}

export function tokenMatches(expected: string, given: unknown): boolean {
  return typeof given === 'string' && safeEqual(expected, given);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cookies;
}

/** ¿La petición trae la clave (cabecera `Authorization: Bearer`) o una sesión válida (cookie)? */
export function isAuthenticated(token: string, headers: { authorization?: string; cookie?: string }): boolean {
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '')?.[1];
  if (bearer && safeEqual(token, bearer.trim())) return true;
  const cookie = parseCookies(headers.cookie)[SESSION_COOKIE];
  return Boolean(cookie) && safeEqual(sessionValue(token), cookie);
}

export function sessionCookieHeader(token: string | null, secure: boolean): string {
  const attrs = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  return token === null ? `${SESSION_COOKIE}=; ${attrs}; Max-Age=0` : `${SESSION_COOKIE}=${sessionValue(token)}; ${attrs}; Max-Age=${30 * 86_400}`;
}

// ---------- Origen (CSRF) ----------
/**
 * ¿Viene la petición de otra web? Un navegador moderno lo declara en `Sec-Fetch-Site`; además, toda petición
 * entre orígenes que pueda cambiar algo lleva `Origin`. Sin ninguna de las dos cabeceras (curl, scripts, tests)
 * no hay navegador de por medio y no hay nada que proteger.
 */
export function isCrossSiteRequest(headers: { origin?: string; host?: string; 'sec-fetch-site'?: string }): boolean {
  const site = headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return true;
  if (headers.origin && headers.origin !== 'null') {
    try {
      return new URL(headers.origin).host.toLowerCase() !== (headers.host ?? '').toLowerCase();
    } catch {
      return true;
    }
  }
  return headers.origin === 'null';
}

// ---------- Límite de tasa ----------
/** Ventana fija por cliente y cubo. Suficiente para frenar bucles y fuerza bruta en un servidor de un solo proceso. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly windowMs = 60_000) {}

  /** Anota una petición. Devuelve 0 si pasa o los segundos que faltan para poder reintentar. */
  hit(key: string, limit: number, now = Date.now()): number {
    if (limit <= 0) return 0;
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.hits.size > 10_000) this.sweep(now);
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count++;
    return entry.count > limit ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) : 0;
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}

/** Rutas que lanzan trabajo caro (modelo, herramientas, peticiones salientes): llevan un límite más estricto. */
export function isCostlyRoute(method: string, urlPath: string): boolean {
  if (method !== 'POST') return false;
  return /\/(run|invoke|retry|resume|test|models)$/.test(urlPath);
}

// ---------- Cabeceras de seguridad ----------
/** Política de contenido para la interfaz: solo recursos propios, más los scripts en línea de index.html (por su hash). */
export function buildCsp(webDist: string): string {
  const hashes: string[] = [];
  try {
    const html = fs.readFileSync(path.join(webDist, 'index.html'), 'utf8');
    for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      hashes.push(`'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`);
    }
  } catch {
    /* sin interfaz compilada: la política sigue siendo válida para la API */
  }
  return [
    "default-src 'self'",
    `script-src 'self'${hashes.length ? ` ${hashes.join(' ')}` : ''}`,
    // Vue y Vue Flow escriben estilos en línea (posiciones de nodos, anchos calculados).
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};
