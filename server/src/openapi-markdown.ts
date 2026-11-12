// Referencia legible de la API (docs/api.md), generada a partir de la especificación OpenAPI.
// `npm run docs:api` la vuelve a escribir; un test comprueba que el archivo está al día.

type J = Record<string, any>;

/** Markdown de la referencia de la API para el documento OpenAPI dado. */
export function renderApiMarkdown(doc: J): string {
  const schemas: J = doc.components.schemas;
  const METHODS = ['get', 'post', 'put', 'delete'];
  const esc = (s: unknown) =>
    String(s ?? '')
      .replace(/\|/g, '\\|')
      .replace(/\n+/g, ' ');

  const resolve = (s: J): J => (s?.$ref ? resolve(schemas[s.$ref.split('/').pop()!]) : s);
  /** Propiedades y obligatorios de un esquema, uniendo allOf. */
  function props(s0: J): { properties: J; required: Set<string> } {
    const s = resolve(s0);
    const out = { properties: { ...(s.properties ?? {}) }, required: new Set<string>(s.required ?? []) };
    for (const part of s.allOf ?? []) {
      const p = props(part);
      Object.assign(out.properties, p.properties);
      p.required.forEach((r) => out.required.add(r));
    }
    return out;
  }

  function typeText(s: J): string {
    if (s.$ref) return `\`${s.$ref.split('/').pop()}\``;
    if (s.anyOf || s.oneOf) {
      const alts: J[] = s.anyOf ?? s.oneOf;
      const parts = alts.filter((p) => p.type !== 'null').map(typeText);
      return parts.join(' o ') + (alts.some((p) => p.type === 'null') ? ' o `null`' : '');
    }
    if (s.enum) return s.enum.map((v: unknown) => `\`${v}\``).join(' / ');
    if (s.type === 'array') return `lista de ${s.items ? typeText(s.items) : 'valores'}`;
    if (s.type === 'object') {
      const extra = s.additionalProperties;
      return extra && typeof extra === 'object' && Object.keys(extra).length ? `mapa de ${typeText(extra)}` : 'objeto';
    }
    return s.type ? `\`${s.type}\`` : 'cualquiera';
  }

  function limits(s0: J): string {
    const s = s0.anyOf ? (s0.anyOf.find((p: J) => p.type !== 'null') ?? s0) : s0;
    const out: string[] = [];
    if (s.minLength !== undefined || s.maxLength !== undefined) out.push(`${s.minLength ?? 0}-${s.maxLength ?? 'sin tope'} caracteres`);
    if (s.minimum !== undefined || s.maximum !== undefined) out.push(`de ${s.minimum ?? 'sin mínimo'} a ${s.maximum ?? 'sin máximo'}`);
    if (s.minItems !== undefined || s.maxItems !== undefined) out.push(`${s.minItems ?? 0}-${s.maxItems ?? 'sin tope'} elementos`);
    if (s.pattern) out.push(`patrón \`${s.pattern}\``);
    if ('default' in s0) out.push(`por defecto \`${JSON.stringify(s0.default)}\``);
    return out.join('; ');
  }

  function fieldTable(schema: J): string {
    const s = resolve(schema);
    if (s.oneOf) return `Uno de: ${s.oneOf.map(typeText).join(' o ')}.\n`;
    const { properties, required } = props(s);
    const names = Object.keys(properties);
    if (!names.length) return '';
    const rows = names.map((name) => {
      const p = properties[name];
      const text = p.description ?? p.anyOf?.find((a: J) => a.description)?.description ?? '';
      return `| \`${name}\` | ${typeText(p)} | ${required.has(name) ? 'sí' : 'no'} | ${esc([text, limits(p)].filter(Boolean).join(' · '))} |`;
    });
    return ['| Campo | Tipo | Obligatorio | Descripción y límites |', '| --- | --- | --- | --- |', ...rows, ''].join('\n');
  }

  const lines: string[] = [];
  const out = (s = '') => lines.push(s);

  out('> Generado a partir de `server/src/openapi.ts`; la especificación completa está en `GET /api/openapi.json`.');
  out();
  out('# Referencia de la API de AgentForge');
  out();
  out(`Versión de la especificación: OpenAPI ${doc.openapi}. Todas las rutas cuelgan de \`/api\`.`);
  out();
  out('## Dirección base');
  out();
  out(
    `\`${doc.servers[0].url}\` (${doc.servers[0].description.toLowerCase()}). Las peticiones y las respuestas son JSON (\`Content-Type: application/json\`), salvo los flujos de eventos, la subida y la descarga de copias y los webhooks, que lo indican.`,
  );
  out();
  out('## Autenticación');
  out();
  out(
    'Si el servidor se arranca con la variable `AGENTFORGE_TOKEN`, toda la API exige la clave de acceso, salvo `/api/auth/*`, `/api/health/live` y los webhooks. Sin clave configurada (por defecto, escuchando solo en `127.0.0.1`) no hace falta nada.',
  );
  out();
  out('- **Clave como cabecera:** `Authorization: Bearer <clave>`.');
  out(
    '- **Cookie de sesión:** `POST /api/auth/login` con `{ "token": "<clave>" }` deja la cookie `af_session` (HttpOnly, SameSite=Strict, 30 días); `POST /api/auth/logout` la borra.',
  );
  out('- **Webhooks:** no usan la clave de la interfaz, sino el secreto de su disparador (ver [Webhooks](#webhooks)).');
  out();
  out(
    'Antes de llegar a las rutas, una petición con un `Host` no permitido o que procede de otro sitio web (protección CSRF) se rechaza con 403 (`forbidden_host` o `cross_site`).',
  );
  out();
  out('## Errores');
  out();
  out('Toda respuesta de error es JSON con esta forma:');
  out();
  out('```json');
  out('{ "error": "Mensaje legible, en español.", "code": "not_found" }');
  out('```');
  out();
  out(
    'En una validación (`code: "validation"`) se añade `issues`, una lista de `{ "path": "campo", "message": "motivo" }`. Algunos errores traen `details` (por ejemplo, `{ "issues": [...] }` con los problemas del grafo al lanzar un workflow con errores).',
  );
  out();
  out('| Código | Cuándo aparece |');
  out('| --- | --- |');
  for (const [code, text] of Object.entries<string>(schemas.Error.properties.code['x-code-descriptions'])) out(`| \`${code}\` | ${esc(text)} |`);
  out();
  out('## Límite de tasa');
  out();
  out(
    doc.info.description
      .split('\n')
      .find((l: string) => l.startsWith('**Límite de tasa.**'))
      .replace('**Límite de tasa.** ', ''),
  );
  out();
  out('## Eventos en vivo');
  out();
  const stream = doc.paths['/api/runs/{id}/stream'].get;
  out('Tres rutas son flujos de eventos del servidor (`text/event-stream`, SSE) pensados para `EventSource`:');
  out();
  out('| Ruta | Evento | Contenido de `data` |');
  out('| --- | --- | --- |');
  out('| `GET /api/stream/runs` | `run` | El `RunSummary` de la ejecución que ha cambiado. |');
  out('| `GET /api/stream/approvals` | `approvals` | La lista completa de aprobaciones pendientes, al conectar y con cada cambio. |');
  out('| `GET /api/runs/{id}/stream` | `run-event` | Un `RunEvent`; su `id` SSE es su `seq`. |');
  out();
  out(stream.description.split('\n')[0]);
  out();
  out(
    'Para retomar el flujo de una ejecución sin perder eventos, reconecta con la cabecera `Last-Event-ID` (el navegador la envía solo) o con `?after=<seq>`: el servidor reproduce primero el historial guardado y después sigue en vivo. Los eventos transitorios (`llm.delta`, `llm.snapshot`) tienen `seq: null` y no llevan `id`. El evento `run.finished` marca el final de la ejecución; la conexión no se cierra sola.',
  );
  out();

  for (const tag of doc.tags as J[]) {
    const ops: Array<{ path: string; method: string; op: J }> = [];
    for (const [path, item] of Object.entries<J>(doc.paths))
      for (const m of METHODS) if (item[m]?.tags?.[0] === tag.name) ops.push({ path, method: m, op: item[m] });
    if (!ops.length) continue;
    out(`## ${tag.name}`);
    out();
    out(tag.description);
    out();
    out('| Método | Ruta | Qué hace |');
    out('| --- | --- | --- |');
    for (const { path, method, op } of ops) out(`| \`${method.toUpperCase()}\` | \`${path}\` | ${esc(op.summary)} |`);
    out();
    for (const { path, method, op } of ops) {
      const query = (op.parameters ?? []).filter((p: J) => p.in !== 'path');
      const body = op.requestBody?.content?.['application/json']?.schema;
      const raw = op.requestBody && !body;
      if (!query.length && !body && !raw) continue;
      out(`### \`${method.toUpperCase()} ${path}\``);
      out();
      if (op.description) {
        out(op.description);
        out();
      }
      if (query.length) {
        out('Parámetros de consulta' + (query.some((q: J) => q.in === 'header') ? ' y cabeceras' : '') + ':');
        out();
        out('| Nombre | Tipo | Obligatorio | Descripción |');
        out('| --- | --- | --- | --- |');
        for (const q of query) {
          out(
            `| \`${q.name}\`${q.in === 'header' ? ' (cabecera)' : ''} | ${typeText(q.schema)} | ${q.required ? 'sí' : 'no'} | ${esc([q.description, limits(q.schema)].filter(Boolean).join(' · '))} |`,
          );
        }
        out();
      }
      if (body) {
        const name = body.$ref ? ` (\`${body.$ref.split('/').pop()}\`)` : '';
        out(`Cuerpo JSON${op.requestBody.required === false ? ' (opcional)' : ''}${name}: ${esc(resolve(body).description ?? '')}`);
        out();
        out(fieldTable(body));
      } else if (raw) {
        out(
          `Cuerpo: ${Object.keys(op.requestBody.content)
            .map((c) => `\`${c}\``)
            .join(', ')}.`,
        );
        out();
      }
    }
  }

  out('## Esquemas de respuesta');
  out();
  out(
    'Los objetos que devuelve la API (`Agent`, `Workflow`, `Run`, `RunEvent`, `Trigger`, `Settings`…) están descritos campo a campo en `components.schemas` de la especificación (`GET /api/openapi.json`).',
  );
  out();
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}
