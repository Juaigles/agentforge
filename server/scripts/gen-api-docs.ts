// Escribe docs/api.md a partir de la especificación OpenAPI. Uso: npm run docs:api
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApi } from '../src/openapi';
import { renderApiMarkdown } from '../src/openapi-markdown';
import { APP_VERSION } from '../src/version';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'api.md');
const text = renderApiMarkdown(buildOpenApi(APP_VERSION) as Record<string, unknown>);
fs.writeFileSync(file, text);
console.log(`docs/api.md: ${text.split('\n').length} líneas`);
