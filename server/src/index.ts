import { buildApp } from './app';
import { loadConfig } from './config';
import { createContext } from './context';
import { seedIfEmpty } from './seed';

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = createContext(config);
  if (ctx.interruptedRuns) console.log(`[agentforge] ${ctx.interruptedRuns} ejecución(es) interrumpidas por el reinicio anterior.`);
  if (config.seed && (await seedIfEmpty(ctx))) console.log('[agentforge] Base de datos vacía: se han creado los datos de ejemplo.');

  const app = await buildApp(ctx);
  await app.listen({ port: config.port, host: config.host });
  ctx.scheduler.start(config.schedulerTickMs);
  console.log(`[agentforge] API en http://${config.host}:${config.port}  ·  datos en ${config.dataDir}`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('[agentforge] Deteniendo…');
    await app.close();
    await ctx.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[agentforge] Error fatal al arrancar:', err);
  process.exit(1);
});
