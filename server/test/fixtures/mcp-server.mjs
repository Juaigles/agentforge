// Servidor MCP real para los tests: se arranca como proceso hijo (stdio) o se monta sobre HTTP (ver mcp.test.ts).
// Usa el SDK oficial de servidor, así que el cliente de AgentForge habla con el protocolo de verdad.
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const text = (value) => ({ content: [{ type: 'text', text: String(value) }] });

export function buildServer() {
  const server = new McpServer({ name: 'servidor-de-pruebas', version: '1.0.0' });
  server.registerTool('sumar', { description: 'Suma dos números.', inputSchema: z.object({ a: z.number(), b: z.number() }) }, async ({ a, b }) => text(a + b));
  server.registerTool(
    'getEnv-Value',
    { description: 'Devuelve una variable de entorno del servidor.', inputSchema: z.object({ name: z.string() }) },
    async ({ name }) => text(process.env[name] ?? '(sin definir)'),
  );
  server.registerTool(
    'buscar',
    {
      description: 'Busca productos con filtros anidados.',
      inputSchema: z.object({ filtro: z.object({ categoria: z.string(), precio: z.object({ max: z.number() }).optional() }), etiquetas: z.array(z.string()).optional() }),
    },
    async ({ filtro, etiquetas }) => ({
      content: [
        { type: 'text', text: `categoria=${filtro.categoria} max=${filtro.precio?.max ?? '-'} etiquetas=${(etiquetas ?? []).join('+')}` },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
    }),
  );
  server.registerTool('fallar', { description: 'Siempre devuelve un error.', inputSchema: z.object({}) }, async () => ({ ...text('no hay stock de ese producto'), isError: true }));
  server.registerTool('lenta', { description: 'Tarda lo que se le pida.', inputSchema: z.object({ ms: z.number() }) }, async ({ ms }) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return text('terminé');
  });
  server.registerTool('ampliar', { description: 'Añade una herramienta nueva al servidor.', inputSchema: z.object({}) }, async () => {
    server.registerTool('extra', { description: 'Herramienta añadida en caliente.', inputSchema: z.object({}) }, async () => text('soy nueva'));
    return text('ampliado');
  });
  server.registerTool('salir', { description: 'Termina el proceso del servidor.', inputSchema: z.object({}) }, async () => {
    setTimeout(() => process.exit(0), 30);
    return text('adiós');
  });
  return server;
}

// Ejecutado directamente: servidor por stdio.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const { StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
  if (process.argv.includes('--romper')) {
    console.error('configuración incompleta: falta la clave');
    process.exit(3);
  }
  await buildServer().connect(new StdioServerTransport());
}
