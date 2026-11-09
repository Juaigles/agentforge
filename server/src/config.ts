import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  dbFile: string;
  workspaceDir: string;
  webDist: string;
  /** Crea datos de ejemplo si la base de datos está vacía. */
  seed: boolean;
  ollamaUrl: string;
  logger: boolean;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = path.resolve(env.AGENTFORGE_DATA_DIR ?? path.join(repoRoot, 'data'));
  return {
    port: Number(env.PORT ?? 4310),
    host: env.HOST ?? '127.0.0.1',
    dataDir,
    dbFile: path.join(dataDir, 'agentforge.db'),
    workspaceDir: path.join(dataDir, 'workspace'),
    webDist: path.join(repoRoot, 'web', 'dist'),
    seed: env.AGENTFORGE_SEED !== '0',
    ollamaUrl: env.OLLAMA_URL ?? 'http://localhost:11434',
    logger: env.AGENTFORGE_LOG === '1',
  };
}
