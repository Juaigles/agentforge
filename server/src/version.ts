// Versión de la aplicación: una sola fuente, el `package.json` de la raíz del repositorio.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readVersion(): string {
  try {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const version = (JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' && version ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const APP_VERSION: string = readVersion();
