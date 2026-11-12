// Copia de seguridad y restauración de la carpeta de datos.
//
// Una copia es UN archivo (`.afbackup`): un tar comprimido con gzip que contiene
//   manifest.json   qué es, de qué versión y cuándo se hizo
//   agentforge.db   copia coherente de la base de datos (VACUUM INTO: vale con el servidor en marcha)
//   secret.key      la clave maestra; sin ella las API keys cifradas de la copia no se pueden leer
//   workspace/…     los archivos del espacio de trabajo
//
// Restaurar no sustituye nada «en caliente»: la copia se valida, se deja preparada en `restore-pending/` y se
// aplica en el siguiente arranque, antes de abrir la base de datos. Lo que había se conserva en `replaced-<fecha>/`.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { SCHEMA_VERSION } from './db/database';
import { HttpError } from './errors';

export const BACKUP_FORMAT = 'agentforge.backup';
const BACKUP_NAME_RE = /^agentforge-\d{8}-\d{6}(-[a-z0-9]{1,24})?\.afbackup$/;
const BLOCK = 512;
/** Tamaño máximo de una copia que se admite al subirla. */
export const MAX_UPLOAD_BYTES = 8 * 1024 ** 3;

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: 1;
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  counts: { agents: number; workflows: number; runs: number; workspaceFiles: number };
}

export interface BackupInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
  manifest: BackupManifest | null;
}

export interface BackupPaths {
  dataDir: string;
  dbFile: string;
  workspaceDir: string;
}

const backupsDir = (p: BackupPaths) => path.join(p.dataDir, 'backups');
const pendingDir = (p: BackupPaths) => path.join(p.dataDir, 'restore-pending');
const READY_MARK = 'READY.json';

export function assertBackupName(name: string): string {
  if (!BACKUP_NAME_RE.test(name)) throw new HttpError(400, 'Nombre de copia de seguridad no válido.');
  return name;
}

function stamp(date = new Date()): string {
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

// ---------- tar (formato ustar, solo archivos normales) ----------
function tarHeader(name: string, size: number, mtime: Date): Buffer {
  let base = name;
  let prefix = '';
  if (Buffer.byteLength(base) > 100) {
    // Los nombres largos se parten entre «prefijo» (155) y «nombre» (100) por una barra.
    const cut = name.lastIndexOf('/', 155);
    prefix = cut > 0 ? name.slice(0, cut) : '';
    base = cut > 0 ? name.slice(cut + 1) : name;
    if (!prefix || Buffer.byteLength(base) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`Ruta demasiado larga para la copia: ${name}`);
  }
  const header = Buffer.alloc(BLOCK);
  header.write(base, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write(
    `${Math.floor(mtime.getTime() / 1000)
      .toString(8)
      .padStart(11, '0')}\0`,
    136,
    12,
    'ascii',
  );
  header.write('        ', 148, 8, 'ascii'); // suma de control: espacios mientras se calcula
  header.write('0', 156, 1, 'ascii'); // archivo normal
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

interface TarSource {
  name: string;
  /** Contenido en memoria o ruta de un archivo que se lee en streaming. */
  data?: Buffer;
  file?: string;
}

async function* tarStream(entries: TarSource[]): AsyncGenerator<Buffer> {
  for (const entry of entries) {
    const stat = entry.file ? await fsp.stat(entry.file) : null;
    const size = entry.data ? entry.data.length : stat!.size;
    yield tarHeader(entry.name, size, stat?.mtime ?? new Date());
    if (entry.data) {
      yield entry.data;
    } else {
      let written = 0;
      for await (const chunk of fs.createReadStream(entry.file!, { end: size > 0 ? size - 1 : 0 })) {
        if (size === 0) break;
        written += (chunk as Buffer).length;
        yield chunk as Buffer;
      }
      if (written !== size) throw new Error(`El archivo cambió de tamaño mientras se copiaba: ${entry.name}`);
    }
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (pad) yield Buffer.alloc(pad);
  }
  yield Buffer.alloc(BLOCK * 2); // fin de archivo tar
}

interface TarEntryState {
  name: string;
  remaining: number;
  pad: number;
  sink: Writable | null;
  /** Se rechaza si el destino falla (disco lleno, ruta ocupada por una carpeta…), en cualquier momento. */
  failed: Promise<never> | null;
  chunks: Buffer[] | null;
}

/**
 * Lee un tar entrada a entrada. `onEntry` decide qué hacer con cada una: devolver un destino donde escribirla,
 * 'buffer' para recibirla entera en `onBuffer` (que puede devolver 'stop' para dejar de leer) o null para saltarla.
 */
async function readTar(
  source: Readable,
  onEntry: (name: string, size: number) => Promise<Writable | 'buffer' | null>,
  onBuffer?: (name: string, data: Buffer) => void | 'stop',
): Promise<void> {
  let pending: Buffer = Buffer.alloc(0);
  let current: TarEntryState | null = null;

  const finishEntry = async (entry: TarEntryState): Promise<boolean> => {
    if (entry.sink) {
      const sink = entry.sink;
      // Un fallo del destino (también uno anterior a este punto) hace fallar la lectura: la entrada no se da por escrita.
      const ended = new Promise<void>((resolve, reject) => sink.end((err?: Error | null) => (err ? reject(err) : resolve())));
      await Promise.race([ended, entry.failed!]);
    }
    return Boolean(entry.chunks && onBuffer?.(entry.name, Buffer.concat(entry.chunks)) === 'stop');
  };

  try {
    for await (const raw of source) {
      const chunk = raw as Buffer;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      for (;;) {
        const entry: TarEntryState | null = current;
        if (entry) {
          if (entry.remaining > 0) {
            if (!pending.length) break;
            const part = pending.subarray(0, Math.min(pending.length, entry.remaining));
            pending = pending.subarray(part.length);
            entry.remaining -= part.length;
            if (entry.chunks) entry.chunks.push(Buffer.from(part));
            else if (entry.sink && !entry.sink.write(part)) {
              const sink = entry.sink;
              // Si el destino falla con la escritura detenida, `drain` no llega nunca: se espera a lo primero que ocurra.
              await Promise.race([new Promise<void>((resolve) => sink.once('drain', () => resolve())), entry.failed!]);
            }
            continue;
          }
          if (pending.length < entry.pad) break;
          pending = pending.subarray(entry.pad);
          if (await finishEntry(entry)) return;
          current = null;
          continue;
        }
        if (pending.length < BLOCK) break;
        const header = pending.subarray(0, BLOCK);
        pending = pending.subarray(BLOCK);
        if (header.every((b) => b === 0)) return; // bloque de fin
        const text = (from: number, len: number) =>
          header
            .subarray(from, from + len)
            .toString('utf8')
            .replace(/\0.*$/s, '');
        const size = parseInt(text(124, 12).trim() || '0', 8);
        if (!Number.isFinite(size) || size < 0) throw new HttpError(400, 'La copia de seguridad está dañada (tamaño de entrada no válido).');
        const prefix = text(345, 155);
        const name = prefix ? `${prefix}/${text(0, 100)}` : text(0, 100);
        const isFile = (header[156] || 48) === 48; // '0' o nulo: archivo normal
        const target = isFile ? await onEntry(name, size) : null;
        const sink = target !== null && target !== 'buffer' ? target : null;
        // El error se escucha desde que existe el destino: puede llegar antes de la primera espera (al abrir el archivo).
        const failed = sink ? new Promise<never>((_resolve, reject) => sink.once('error', reject)) : null;
        failed?.catch(() => undefined);
        current = { name, remaining: size, pad: (BLOCK - (size % BLOCK)) % BLOCK, sink, failed, chunks: target === 'buffer' ? [] : null };
      }
    }
    const last: TarEntryState | null = current;
    if (last) {
      if (last.remaining > 0) throw new HttpError(400, 'La copia de seguridad está incompleta.');
      await finishEntry(last);
      current = null;
    }
  } catch (err) {
    // El destino que quedara abierto se cierra antes de avisar: quien llama va a borrar la carpeta a medio escribir.
    const open = (current as TarEntryState | null)?.sink;
    if (open && !open.closed) {
      await new Promise<void>((resolve) => {
        open.once('close', () => resolve());
        open.destroy();
      });
    }
    throw err;
  }
}

async function workspaceFiles(root: string): Promise<Array<{ rel: string; abs: string }>> {
  const out: Array<{ rel: string; abs: string }> = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(abs, next);
      else if (entry.isFile()) out.push({ rel: next, abs });
    }
  };
  await walk(root, '');
  return out;
}

// ---------- Crear, listar, borrar ----------
/** Crea una copia de seguridad completa. Se puede hacer con el servidor en marcha y ejecuciones en curso. */
export async function createBackup(paths: BackupPaths, db: DatabaseSync, appVersion: string, label = ''): Promise<BackupInfo> {
  const dir = backupsDir(paths);
  await fsp.mkdir(dir, { recursive: true });
  const createdAt = new Date();
  const suffix = label
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 24);
  const name = `agentforge-${stamp(createdAt)}${suffix ? `-${suffix}` : ''}.afbackup`;
  const target = path.join(dir, name);
  if (fs.existsSync(target)) throw new HttpError(409, 'Ya existe una copia con esa fecha y hora. Espera un segundo y vuelve a intentarlo.');
  const dbCopy = path.join(dir, `.tmp-${process.pid}-${Date.now()}.db`);
  try {
    // Copia coherente de la base (incluye lo que aún está en el diario WAL), sin parar las escrituras.
    db.exec(`VACUUM INTO '${dbCopy.replace(/'/g, "''")}'`);
    const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    const files = await workspaceFiles(paths.workspaceDir);
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      version: 1,
      createdAt: createdAt.toISOString(),
      appVersion,
      schemaVersion: SCHEMA_VERSION,
      counts: { agents: count('agents'), workflows: count('workflows'), runs: count('runs'), workspaceFiles: files.length },
    };
    const entries: TarSource[] = [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
      { name: 'agentforge.db', file: dbCopy },
    ];
    const keyFile = path.join(paths.dataDir, 'secret.key');
    if (fs.existsSync(keyFile)) entries.push({ name: 'secret.key', file: keyFile });
    for (const file of files) entries.push({ name: `workspace/${file.rel}`, file: file.abs });
    const partial = `${target}.part`;
    await pipeline(Readable.from(tarStream(entries)), zlib.createGzip({ level: 6 }), fs.createWriteStream(partial));
    await fsp.rename(partial, target);
    return { name, sizeBytes: (await fsp.stat(target)).size, createdAt: manifest.createdAt, manifest };
  } catch (err) {
    await fsp.rm(`${target}.part`, { force: true });
    throw err;
  } finally {
    await fsp.rm(dbCopy, { force: true });
  }
}

/** Lee el manifiesto de una copia (es su primera entrada, así que no hay que descomprimirla entera). */
export async function readManifest(file: string): Promise<BackupManifest> {
  let manifest: BackupManifest | null = null;
  const input = fs.createReadStream(file);
  const gunzip = zlib.createGunzip();
  input.pipe(gunzip);
  input.on('error', () => gunzip.destroy());
  try {
    await readTar(
      gunzip,
      async (name, size) => (name === 'manifest.json' && size < 1_000_000 ? 'buffer' : null),
      (_name, data) => {
        manifest = JSON.parse(data.toString('utf8')) as BackupManifest;
        return 'stop';
      },
    );
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'El archivo no es una copia de seguridad de AgentForge o está dañado.');
  } finally {
    input.destroy();
    gunzip.destroy();
  }
  const found = manifest as BackupManifest | null;
  if (!found || found.format !== BACKUP_FORMAT || found.version !== 1) throw new HttpError(400, 'El archivo no es una copia de seguridad de AgentForge.');
  return found;
}

export async function listBackups(paths: BackupPaths): Promise<BackupInfo[]> {
  let names: string[];
  try {
    names = (await fsp.readdir(backupsDir(paths))).filter((n) => BACKUP_NAME_RE.test(n));
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const name of names) {
    const file = path.join(backupsDir(paths), name);
    const stat = await fsp.stat(file);
    const manifest = await readManifest(file).catch(() => null);
    out.push({ name, sizeBytes: stat.size, createdAt: manifest?.createdAt ?? stat.mtime.toISOString(), manifest });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function backupFile(paths: BackupPaths, name: string): string {
  const file = path.join(backupsDir(paths), assertBackupName(name));
  if (!fs.existsSync(file)) throw new HttpError(404, 'Copia de seguridad no encontrada.');
  return file;
}

export async function deleteBackup(paths: BackupPaths, name: string): Promise<void> {
  await fsp.rm(backupFile(paths, name));
}

/** Guarda una copia subida por el usuario (se valida antes de aceptarla). */
export async function receiveBackup(paths: BackupPaths, source: Readable): Promise<BackupInfo> {
  const dir = backupsDir(paths);
  await fsp.mkdir(dir, { recursive: true });
  const name = `agentforge-${stamp()}-importada.afbackup`;
  const partial = path.join(dir, `${name}.part`);
  let received = 0;
  try {
    await pipeline(
      source,
      async function* (chunks) {
        for await (const chunk of chunks) {
          received += (chunk as Buffer).length;
          if (received > MAX_UPLOAD_BYTES) throw new HttpError(413, 'La copia de seguridad es demasiado grande.');
          yield chunk;
        }
      },
      fs.createWriteStream(partial),
    );
    const manifest = await readManifest(partial);
    const target = path.join(dir, name);
    await fsp.rename(partial, target);
    return { name, sizeBytes: received, createdAt: manifest.createdAt, manifest };
  } catch (err) {
    await fsp.rm(partial, { force: true });
    throw err;
  }
}

// ---------- Restaurar ----------
export interface PendingRestore {
  name: string;
  preparedAt: string;
  manifest: BackupManifest;
}

/** Restauración preparada que se aplicará en el próximo arranque, si la hay. */
export function pendingRestore(paths: BackupPaths): PendingRestore | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(pendingDir(paths), READY_MARK), 'utf8')) as PendingRestore;
  } catch {
    return null;
  }
}

export async function cancelRestore(paths: BackupPaths): Promise<boolean> {
  const had = pendingRestore(paths) !== null;
  await fsp.rm(pendingDir(paths), { recursive: true, force: true });
  return had;
}

/**
 * Valida una copia y la deja preparada para aplicarse en el próximo arranque. No toca los datos en uso.
 * Comprueba que es de una versión que este programa entiende y que su base de datos está íntegra.
 */
export async function prepareRestore(paths: BackupPaths, name: string): Promise<PendingRestore> {
  const file = backupFile(paths, name);
  const manifest = await readManifest(file);
  if (manifest.schemaVersion > SCHEMA_VERSION) {
    throw new HttpError(
      409,
      `La copia es de una versión más reciente de AgentForge (esquema v${manifest.schemaVersion}; esta versión entiende hasta v${SCHEMA_VERSION}). Actualiza AgentForge antes de restaurarla.`,
    );
  }
  const dir = pendingDir(paths);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const root = path.resolve(dir);
  let hasDb = false;
  const input = fs.createReadStream(file);
  const gunzip = zlib.createGunzip();
  try {
    input.on('error', (err) => gunzip.destroy(err));
    input.pipe(gunzip);
    await readTar(gunzip, async (entry) => {
      // Solo se aceptan las entradas esperadas, y nunca fuera de la carpeta de preparación.
      const allowed = entry === 'manifest.json' || entry === 'agentforge.db' || entry === 'secret.key' || entry.startsWith('workspace/');
      const target = path.resolve(root, entry);
      if (!allowed || entry.includes('\\') || entry.split('/').includes('..') || !target.startsWith(root + path.sep)) return null;
      if (entry === 'agentforge.db') hasDb = true;
      await fsp.mkdir(path.dirname(target), { recursive: true });
      return fs.createWriteStream(target);
    });
    // El lector se cierra aquí: si no, el archivo de la copia quedaría abierto (y en Windows, bloqueado).
    input.destroy();
    gunzip.destroy();
    if (!hasDb) throw new HttpError(400, 'La copia de seguridad no contiene la base de datos.');
    // La base restaurada tiene que abrirse y estar íntegra ANTES de comprometerse a usarla.
    const probe = new DatabaseSync(path.join(dir, 'agentforge.db'), { readOnly: true });
    try {
      const check = probe.prepare('PRAGMA quick_check').get() as Record<string, string>;
      const version = (probe.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (Object.values(check)[0] !== 'ok') throw new HttpError(400, 'La base de datos de la copia está dañada.');
      if (version > SCHEMA_VERSION) throw new HttpError(409, 'La base de datos de la copia es de una versión más reciente de AgentForge.');
    } finally {
      probe.close();
    }
    await fsp.mkdir(path.join(dir, 'workspace'), { recursive: true });
    const pending: PendingRestore = { name, preparedAt: new Date().toISOString(), manifest };
    await fsp.writeFile(path.join(dir, READY_MARK), JSON.stringify(pending, null, 2));
    return pending;
  } catch (err) {
    input.destroy();
    gunzip.destroy();
    await fsp.rm(dir, { recursive: true, force: true });
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, `No se pudo leer la copia de seguridad: ${(err as Error).message}`);
  }
}

/**
 * Al arrancar, antes de abrir la base de datos: si hay una restauración preparada, sustituye los datos por los de
 * la copia. Lo que había se mueve a `replaced-<fecha>/` (no se borra). Devuelve la restauración aplicada, o null.
 */
export function applyPendingRestore(paths: BackupPaths): (PendingRestore & { replacedDir: string }) | null {
  const pending = pendingRestore(paths);
  if (!pending) {
    // Restos de una preparación que no llegó a terminar.
    fs.rmSync(pendingDir(paths), { recursive: true, force: true });
    return null;
  }
  const from = pendingDir(paths);
  const replacedDir = path.join(paths.dataDir, `replaced-${stamp()}`);
  fs.mkdirSync(replacedDir, { recursive: true });
  const keyFile = path.join(paths.dataDir, 'secret.key');
  const moveOut = (file: string) => {
    if (fs.existsSync(file)) fs.renameSync(file, path.join(replacedDir, path.basename(file)));
  };
  // 1) Apartar lo actual (base de datos con su diario, clave y espacio de trabajo).
  for (const file of [paths.dbFile, `${paths.dbFile}-wal`, `${paths.dbFile}-shm`, keyFile, paths.workspaceDir]) moveOut(file);
  // 2) Poner en su sitio lo restaurado.
  fs.renameSync(path.join(from, 'agentforge.db'), paths.dbFile);
  if (fs.existsSync(path.join(from, 'secret.key'))) fs.renameSync(path.join(from, 'secret.key'), keyFile);
  fs.renameSync(path.join(from, 'workspace'), paths.workspaceDir);
  fs.rmSync(from, { recursive: true, force: true });
  fs.writeFileSync(path.join(paths.dataDir, 'last-restore.json'), JSON.stringify({ ...pending, appliedAt: new Date().toISOString(), replacedDir }, null, 2));
  return { ...pending, replacedDir };
}

/** Última restauración aplicada (para avisar en la interfaz tras el reinicio). */
export function lastRestore(paths: BackupPaths): (PendingRestore & { appliedAt: string; replacedDir: string }) | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(paths.dataDir, 'last-restore.json'), 'utf8'));
  } catch {
    return null;
  }
}
