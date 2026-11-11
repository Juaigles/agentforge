import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Una migración: SQL que se aplica en una transacción y, opcionalmente, un paso posterior fuera de ella
 * (hay órdenes, como VACUUM, que SQLite no admite dentro de una transacción).
 */
export type Migration = string | { sql: string; after?: (db: DatabaseSync) => void };

// Cada entrada es una migración; su posición+1 es la versión de esquema (PRAGMA user_version).
const MIGRATIONS: Migration[] = [
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
  // v4: rendimiento con historiales grandes.
  //  - Índices para los filtros reales (estado, workflow, agente, interrumpidas) y para la retención.
  //  - `ended_at`: instante en que la ejecución terminó; NULL mientras sigue viva. La retención recorre su índice.
  //  - Agregados incrementales para el panel: sin ellos cada petición de estadísticas leía la tabla entera.
  //    Son ACUMULADOS (no bajan al borrar ejecuciones): cuentan todo lo que se ha ejecutado.
  //  - Búsqueda de texto completo (subcadenas) en el nombre y en los primeros 2000 caracteres de la entrada y
  //    del resultado. El índice de trigramas ocupa unas tres veces el texto indexado: de ahí el tope.
  //  - Memoria compartida persistida por ejecución, para que reanudar o reintentar no la pierda.
  {
    sql: `
  ALTER TABLE runs ADD COLUMN ended_at TEXT;
  UPDATE runs SET ended_at = COALESCE(finished_at, created_at) WHERE status IN ('completed','failed','cancelled');
  DROP INDEX idx_runs_status;
  DROP INDEX idx_runs_finished;
  DROP INDEX idx_events_type;
  DROP INDEX idx_runs_created;
  CREATE INDEX idx_runs_created ON runs(created_at DESC, id DESC);
  CREATE INDEX idx_runs_status_created ON runs(status, created_at DESC, id DESC);
  CREATE INDEX idx_runs_workflow_created ON runs(workflow_id, created_at DESC, id DESC) WHERE workflow_id IS NOT NULL;
  CREATE INDEX idx_runs_agent_created ON runs(agent_id, created_at DESC, id DESC) WHERE agent_id IS NOT NULL;
  CREATE INDEX idx_runs_interrupted ON runs(created_at DESC, id DESC) WHERE interrupted = 1;
  CREATE INDEX idx_runs_ended ON runs(ended_at, id) WHERE ended_at IS NOT NULL AND interrupted = 0;

  CREATE TABLE stats_daily (
    date TEXT NOT NULL,
    status TEXT NOT NULL,
    runs INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    llm_calls INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, status)
  ) WITHOUT ROWID;
  INSERT INTO stats_daily (date, status, runs, prompt_tokens, completion_tokens, llm_calls, tool_calls, duration_ms)
    SELECT date(created_at, 'localtime'), status, COUNT(*),
           COALESCE(SUM(json_extract(usage,'$.promptTokens')),0), COALESCE(SUM(json_extract(usage,'$.completionTokens')),0),
           COALESCE(SUM(json_extract(usage,'$.llmCalls')),0), COALESCE(SUM(json_extract(usage,'$.toolCalls')),0),
           COALESCE(SUM(CASE WHEN started_at IS NOT NULL AND finished_at IS NOT NULL
                             THEN CAST((julianday(finished_at) - julianday(started_at)) * 86400000.0 AS INTEGER) ELSE 0 END),0)
    FROM runs WHERE status IN ('completed','failed','cancelled') GROUP BY 1, 2;

  CREATE TABLE stats_agent (
    agent_id TEXT PRIMARY KEY,
    steps INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  INSERT INTO stats_agent (agent_id, steps, completion_tokens)
    SELECT agent_id, COUNT(*), COALESCE(SUM(json_extract(usage,'$.completionTokens')),0)
    FROM run_steps WHERE agent_id IS NOT NULL AND status IN ('completed','failed') GROUP BY agent_id;

  CREATE TABLE stats_tool (
    name TEXT PRIMARY KEY,
    calls INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  INSERT INTO stats_tool (name, calls)
    SELECT json_extract(data,'$.name'), COUNT(*) FROM run_events
    WHERE type = 'tool.call' AND json_extract(data,'$.name') IS NOT NULL GROUP BY 1;

  CREATE VIRTUAL TABLE runs_fts USING fts5(name, input, result, tokenize = 'trigram remove_diacritics 1');
  INSERT INTO runs_fts (rowid, name, input, result)
    SELECT rowid, name, substr(input, 1, 2000), substr(COALESCE(output, '') || ' ' || COALESCE(error, ''), 1, 2000) FROM runs;
  CREATE TRIGGER runs_fts_insert AFTER INSERT ON runs BEGIN
    INSERT INTO runs_fts (rowid, name, input, result)
      VALUES (new.rowid, new.name, substr(new.input, 1, 2000), substr(COALESCE(new.output, '') || ' ' || COALESCE(new.error, ''), 1, 2000));
  END;
  CREATE TRIGGER runs_fts_update AFTER UPDATE OF name, output, error ON runs BEGIN
    UPDATE runs_fts SET name = new.name, result = substr(COALESCE(new.output, '') || ' ' || COALESCE(new.error, ''), 1, 2000) WHERE rowid = new.rowid;
  END;
  CREATE TRIGGER runs_fts_delete AFTER DELETE ON runs BEGIN
    DELETE FROM runs_fts WHERE rowid = old.rowid;
  END;

  CREATE TABLE run_memory (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (run_id, key)
  ) WITHOUT ROWID;
  `,
    // Compactación incremental: tras borrar ejecuciones el archivo puede encoger sin reescribirlo entero.
    // Activarla en una base ya creada exige un VACUUM (una sola vez).
    after: (db) => {
      const mode = (db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum;
      if (mode !== 2) db.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM;');
    },
  },
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
export function openDatabase(file: string, migrations: Migration[] = MIGRATIONS): DatabaseSync {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // En una base recién creada la compactación incremental se activa antes de crear ninguna tabla (así no cuesta nada).
  const isNew = (db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get() as { n: number }).n === 0;
  if (isNew) db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
  // synchronous=NORMAL con WAL: la base nunca se corrompe; ante un corte de luz se puede perder la última
  // transacción confirmada, a cambio de no hacer un fsync por cada evento escrito.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA cache_size = -32768;');
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current > migrations.length) {
    db.close();
    throw new Error(
      `La base de datos (${file}) tiene el esquema v${current}, más reciente que el que entiende esta versión de AgentForge (v${migrations.length}). ` +
        'Actualiza AgentForge o restaura una copia de seguridad anterior.',
    );
  }
  if (file !== ':memory:' && current > 0 && current < migrations.length) {
    // Con un historial grande puede tardar (copia previa, índices nuevos y compactación): que no parezca un cuelgue.
    console.log(`[agentforge] Actualizando la base de datos del esquema v${current} al v${migrations.length}. Con un historial grande puede tardar unos segundos…`);
    const backup = `${file}.v${current}.bak`;
    fs.rmSync(backup, { force: true });
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  }
  for (let v = current; v < migrations.length; v++) {
    const migration = migrations[v];
    db.exec('BEGIN');
    try {
      db.exec(typeof migration === 'string' ? migration : migration.sql);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      db.close();
      throw err;
    }
    if (typeof migration !== 'string') migration.after?.(db);
  }
  return db;
}
