// Composición de dependencias de la aplicación (base de datos, registro de herramientas, motor).
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from './config';
import { SecretBox } from './crypto/secrets';
import { openDatabase } from './db/database';
import { Store } from './db/store';
import { RunManager } from './engine/run-manager';
import { defaultLlmFactory, type LlmFactory } from './llm';
import { ToolRegistry } from './tools/registry';

export interface AppContext {
  config: AppConfig;
  db: DatabaseSync;
  store: Store;
  tools: ToolRegistry;
  llm: LlmFactory;
  runs: RunManager;
  startedAt: number;
  /** Ejecuciones que estaban a medias en el arranque y se han marcado como interrumpidas. */
  interruptedRuns: number;
  /** Aplica la política de retención del historial configurada en Ajustes. Devuelve cuántas ejecuciones borra. */
  applyRetention(): number;
  close(): Promise<void>;
}

export interface ContextOverrides {
  llm?: LlmFactory;
  /** Usa una base de datos en memoria (tests). */
  inMemory?: boolean;
  retryBaseDelayMs?: number;
}

export function createContext(config: AppConfig, overrides: ContextOverrides = {}): AppContext {
  fs.mkdirSync(config.workspaceDir, { recursive: true });
  const db = openDatabase(overrides.inMemory ? ':memory:' : config.dbFile);
  const secrets = overrides.inMemory ? SecretBox.ephemeral() : SecretBox.fromKeyFile(path.join(config.dataDir, 'secret.key'));
  const store = new Store(db, secrets);
  const interruptedRuns = store.markInterruptedRuns();
  const tools = new ToolRegistry(store);
  const llm = overrides.llm ?? defaultLlmFactory;
  const applyRetention = (): number => {
    const { retentionDays, retentionMaxRuns } = store.getSettings();
    if (!retentionDays && !retentionMaxRuns) return 0;
    return store.pruneRuns({ days: retentionDays, maxRuns: retentionMaxRuns });
  };
  const runs = new RunManager({
    store,
    tools,
    llm,
    workspaceDir: config.workspaceDir,
    retryBaseDelayMs: overrides.retryBaseDelayMs,
    onRunFinished: applyRetention,
  });
  // La retención por antigüedad se aplica al arrancar y, después, cada hora (sin impedir que el proceso termine).
  applyRetention();
  const retentionTimer = setInterval(() => {
    try {
      applyRetention();
    } catch {
      /* se reintentará en la siguiente pasada */
    }
  }, 3_600_000);
  retentionTimer.unref();
  return {
    config,
    db,
    store,
    tools,
    llm,
    runs,
    startedAt: Date.now(),
    interruptedRuns,
    applyRetention,
    async close() {
      clearInterval(retentionTimer);
      await runs.shutdown();
      if (db.isOpen) db.close();
    },
  };
}
