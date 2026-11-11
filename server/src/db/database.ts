import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Cada entrada es una migración; su posición+1 es la versión de esquema (PRAGMA user_version).
const MIGRATIONS: string[] = [
  `
  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key_enc TEXT,
    default_model TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#6366f1',
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    temperature REAL NOT NULL DEFAULT 0.7,
    max_tokens INTEGER,
    max_iterations INTEGER NOT NULL DEFAULT 8,
    tools TEXT NOT NULL DEFAULT '[]',
    thinking INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE custom_tools (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    parameters TEXT NOT NULL,
    config TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    definition TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    workflow_id TEXT,
    agent_id TEXT,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    input TEXT NOT NULL DEFAULT '',
    output TEXT,
    error TEXT,
    snapshot TEXT NOT NULL,
    usage TEXT NOT NULL,
    retry_of TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX idx_runs_created ON runs(created_at DESC);
  CREATE INDEX idx_runs_status ON runs(status);
  CREATE TABLE run_steps (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    node_type TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    agent_id TEXT,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    input TEXT,
    output TEXT,
    error TEXT,
    usage TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    PRIMARY KEY (run_id, node_id)
  );
  CREATE TABLE run_events (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    node_id TEXT,
    data TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
  );
  CREATE INDEX idx_events_type ON run_events(type);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v2: ejecuciones interrumpidas por un apagado, pendientes de reanudar o descartar; índice para la retención.
  `
  ALTER TABLE runs ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_runs_finished ON runs(finished_at);
  `,
  // v3: programación de workflows y marca de las ejecuciones que lanza.
  `
  CREATE TABLE schedules (
    workflow_id TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    interval_minutes INTEGER,
    time TEXT,
    input TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at TEXT,
    last_run_at TEXT,
    last_run_id TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL
  );
  ALTER TABLE runs ADD COLUMN scheduled INTEGER NOT NULL DEFAULT 0;
  `,
];

/** Versión de esquema que conoce este código. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Abre (o crea) la base de datos y aplica las migraciones pendientes. Usa ':memory:' en tests.
 *
 * Antes de migrar una base con datos se guarda una copia coherente (`agentforge.db.v<N>.bak`), porque las
 * migraciones no tienen marcha atrás. Una base de una versión MÁS NUEVA que el código se rechaza: abrirla
 * daría errores tardíos o datos incoherentes.
 */
export function openDatabase(file: string, migrations: string[] = MIGRATIONS): DatabaseSync {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // synchronous=NORMAL con WAL: la base nunca se corrompe; ante un corte de luz se puede perder la última
  // transacción confirmada, a cambio de no hacer un fsync por cada evento escrito.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current > migrations.length) {
    db.close();
    throw new Error(
      `La base de datos (${file}) tiene el esquema v${current}, más reciente que el que entiende esta versión de AgentForge (v${migrations.length}). ` +
        'Actualiza AgentForge o restaura una copia de seguridad anterior.',
    );
  }
  if (file !== ':memory:' && current > 0 && current < migrations.length) {
    const backup = `${file}.v${current}.bak`;
    fs.rmSync(backup, { force: true });
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  }
  for (let v = current; v < migrations.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      db.close();
      throw err;
    }
  }
  return db;
}
