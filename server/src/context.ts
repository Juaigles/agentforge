// Composición de dependencias de la aplicación (base de datos, registro de herramientas, motor).
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { applyPendingRestore, type PendingRestore } from './backup';
import type { AppConfig } from './config';
import { SecretBox } from './crypto/secrets';
import { openDatabase } from './db/database';
import { Store } from './db/store';
import { validateWorkflow } from '../../shared/graph';
import { RunManager } from './engine/run-manager';
import { Scheduler } from './engine/scheduler';
import { defaultLlmFactory, type LlmFactory } from './llm';
import { McpManager } from './tools/mcp';
import { ToolRegistry } from './tools/registry';
import { silentLogger, type Logger } from './util';

export interface AppContext {
  config: AppConfig;
  db: DatabaseSync;
  store: Store;
  tools: ToolRegistry;
  /** Conexiones con los servidores MCP configurados. */
  mcp: McpManager;
  llm: LlmFactory;
  runs: RunManager;
  /** Programación de workflows. El temporizador solo se arranca en el servidor real (index.ts). */
  scheduler: Scheduler;
  startedAt: number;
  /** Registro de la aplicación. `buildApp` lo sustituye por el de Fastify; hasta entonces no escribe nada. */
  log: Logger;
  /** Ejecuciones que estaban a medias en el arranque y se han marcado como interrumpidas. */
  interruptedRuns: number;
  /** Copia de seguridad que se ha restaurado en este arranque, si la había preparada. */
  restored: (PendingRestore & { replacedDir: string }) | null;
  /** Aplica la política de retención del historial configurada en Ajustes. Devuelve cuántas ejecuciones borra. */
  applyRetention(): number;
  /** Detiene las ejecuciones dejándolas reanudables (ver RunManager.shutdown). Devuelve cuántas se interrumpen. */
  stopRuns(): Promise<number>;
  close(): Promise<void>;
}

export interface ContextOverrides {
  llm?: LlmFactory;
  /** Usa una base de datos en memoria (tests). */
  inMemory?: boolean;
  retryBaseDelayMs?: number;
}

/**
 * Impide que dos servidores usen a la vez la misma carpeta de datos: el segundo marcaría como interrumpidas
 * las ejecuciones que el primero sí está ejecutando y ambos dispararían las programaciones por duplicado.
 * Devuelve la función que libera el bloqueo.
 */
function acquireInstanceLock(dataDir: string): () => void {
  const file = path.join(dataDir, 'agentforge.lock');
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (err) {
        // EPERM: el proceso existe pero es de otro usuario. Cualquier otro error: ya no existe.
        alive = (err as NodeJS.ErrnoException).code === 'EPERM';
      }
      if (alive) {
        throw new Error(
          `Ya hay otro servidor de AgentForge (proceso ${pid}) usando la carpeta de datos ${dataDir}. ` +
            'Ciérralo antes de arrancar este, o usa otra carpeta con AGENTFORGE_DATA_DIR.',
        );
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  fs.writeFileSync(file, String(process.pid));
  return () => {
    try {
      if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.rmSync(file, { force: true });
    } catch {
      /* ya no está: nada que liberar */
    }
  };
}

export function createContext(config: AppConfig, overrides: ContextOverrides = {}): AppContext {
  const releaseLock = overrides.inMemory ? () => undefined : acquireInstanceLock(config.dataDir);
  // Una restauración preparada desde la interfaz se aplica aquí, antes de abrir la base de datos.
  const restored = overrides.inMemory ? null : applyPendingRestore(config);
  fs.mkdirSync(config.workspaceDir, { recursive: true });
  const db = openDatabase(overrides.inMemory ? ':memory:' : config.dbFile);
  const secrets = overrides.inMemory ? SecretBox.ephemeral() : SecretBox.fromKeyFile(path.join(config.dataDir, 'secret.key'));
  const store = new Store(db, secrets);
  const interruptedRuns = store.markInterruptedRuns();
  // Las credenciales que una versión anterior guardó en claro en las cabeceras de las herramientas se cifran al arrancar.
  store.encryptLegacyToolHeaders();
  const mcp = new McpManager(store, { log: () => ctx.log });
  const tools = new ToolRegistry(store, mcp);
  const llm = overrides.llm ?? defaultLlmFactory;
  // Retención por lotes: la primera tanda se borra en el momento (así el ajuste tiene efecto inmediato) y, si
  // queda más, se sigue en segundo plano cediendo el control entre tandas, para que borrar un historial grande
  // no congele el servidor. Al acabar, el espacio liberado se devuelve al sistema de archivos poco a poco.
  const RETENTION_BATCH = 100;
  let closed = false;
  let pruning = false;
  let compacting = false;
  const compactLater = (): void => {
    if (compacting || closed) return;
    compacting = true;
    const step = (): void => {
      if (closed || !db.isOpen) return void (compacting = false);
      try {
        if (store.compact(2000) > 0) return void setTimeout(step, 10).unref();
      } catch (err) {
        ctx.log.warn({ err }, 'No se pudo compactar la base de datos');
      }
      compacting = false;
    };
    setTimeout(step, 50).unref();
  };
  const pruneBatch = (): number => {
    const { retentionDays, retentionMaxRuns } = store.getSettings();
    if (!retentionDays && !retentionMaxRuns) return 0;
    return store.pruneRuns({ days: retentionDays, maxRuns: retentionMaxRuns }, Date.now(), RETENTION_BATCH);
  };
  const applyRetention = (): number => {
    const deleted = pruneBatch();
    if (deleted >= RETENTION_BATCH && !pruning) {
      pruning = true;
      let total = deleted;
      const next = (): void => {
        if (closed || !db.isOpen) return void (pruning = false);
        try {
          const more = pruneBatch();
          total += more;
          if (more >= RETENTION_BATCH) return void setTimeout(next, 5).unref();
          ctx.log.info({ deleted: total }, 'Retención del historial aplicada');
        } catch (err) {
          ctx.log.warn({ err }, 'No se pudo completar la retención del historial');
        }
        pruning = false;
        compactLater();
      };
      setTimeout(next, 5).unref();
    } else if (deleted) compactLater();
    return deleted;
  };
  const runs = new RunManager({
    store,
    tools,
    llm,
    workspaceDir: config.workspaceDir,
    retryBaseDelayMs: overrides.retryBaseDelayMs,
    onRunFinished: applyRetention,
    log: () => ctx.log,
  });
  // La retención por antigüedad se aplica al arrancar y, después, cada hora (sin impedir que el proceso termine).
  applyRetention();
  const retentionTimer = setInterval(() => {
    try {
      applyRetention();
    } catch (err) {
      ctx.log.warn({ err }, 'No se pudo aplicar la retención del historial; se reintentará en la siguiente pasada');
    }
  }, 3_600_000);
  retentionTimer.unref();
  const scheduler = new Scheduler({
    store,
    runs,
    validate: (wf) => validateWorkflow(wf, { agentIds: store.listAgents().map((a) => a.id), toolNames: tools.names(), workflows: store.listWorkflows(), selfId: wf.id }),
    log: () => ctx.log,
  });
  const ctx: AppContext = {
    config,
    db,
    store,
    tools,
    mcp,
    llm,
    runs,
    scheduler,
    startedAt: Date.now(),
    log: silentLogger,
    interruptedRuns,
    restored,
    applyRetention,
    async stopRuns() {
      closed = true;
      clearInterval(retentionTimer);
      scheduler.stop();
      return runs.shutdown(config.shutdownGraceMs);
    },
    async close() {
      await ctx.stopRuns();
      await mcp.close();
      if (db.isOpen) db.close();
      releaseLock();
    },
  };
  // Los servidores MCP se conectan en segundo plano: el arranque no espera a programas externos.
  void mcp.start();
  return ctx;
}
