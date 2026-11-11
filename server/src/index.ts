import { buildApp } from './app';
import { ConfigurationError, isLoopbackHost, loadConfig } from './config';
import { createContext, type AppContext } from './context';
import { seedIfEmpty } from './seed';
import { errorMessage } from './util';

async function main(): Promise<void> {
  const config = loadConfig();
  let ctx: AppContext | null = null;
  try {
    ctx = createContext(config);
    const app = await buildApp(ctx);
    const { log } = app;
    if (ctx.restored) log.warn({ backup: ctx.restored.name, replaced: ctx.restored.replacedDir }, 'Se ha restaurado una copia de seguridad; los datos anteriores se han conservado aparte');
    if (ctx.interruptedRuns) log.warn({ interrupted: ctx.interruptedRuns }, 'Hay ejecuciones interrumpidas por el cierre anterior; la interfaz ofrece reanudarlas');
    if (config.seed && (await seedIfEmpty(ctx))) log.info('Base de datos vacía: se han creado los datos de ejemplo');

    await app.listen({ port: config.port, host: config.host });
    ctx.scheduler.start(config.schedulerTickMs);
    // Las ejecuciones que esperaban una aprobación (y, si así se ha configurado, todas las interrumpidas) siguen solas.
    ctx.runs.autoResume();
    log.info({ dataDir: config.dataDir, auth: Boolean(config.authToken) }, `AgentForge en http://${config.host}:${config.port}`);
    if (!isLoopbackHost(config.host)) log.warn('El servidor es accesible desde otros equipos: todas las peticiones a la API exigen la clave de acceso');
    // El aviso de arranque se escribe siempre, también con el registro silenciado.
    if (config.logLevel === 'silent') console.log(`[agentforge] http://${config.host}:${config.port}  ·  datos en ${config.dataDir}`);

    let closing = false;
    const shutdown = async (reason: string, exitCode = 0) => {
      if (closing) {
        // Segunda señal: el usuario no quiere esperar más.
        log.warn('Segunda señal de parada: salida inmediata');
        process.exit(1);
      }
      closing = true;
      log.info({ reason }, 'Deteniendo el servidor');
      // Red de seguridad: si algo no reacciona, el proceso no se queda colgado para siempre.
      const hardStop = setTimeout(() => {
        log.error('El apagado ha superado su plazo: salida forzada');
        process.exit(1);
      }, config.shutdownGraceMs + 5000);
      hardStop.unref();
      try {
        // Primero las ejecuciones (quedan interrumpidas y reanudables, y sus clientes reciben el estado final);
        // después las conexiones; por último la base de datos.
        await ctx!.stopRuns();
        await app.close();
        await ctx!.close();
      } catch (err) {
        log.error({ err }, 'Error durante el apagado');
        exitCode = 1;
      }
      process.exit(exitCode);
    };
    // SIGBREAK (Ctrl+Pausa) y SIGHUP (cerrar la ventana de la consola) también apagan con orden.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) process.on(signal, () => void shutdown(signal));
    // En Windows un proceso no puede enviar SIGTERM a otro (lo mata sin más). Un gestor de procesos que haya
    // lanzado el servidor con canal IPC puede pedir el apagado ordenado con el mensaje «shutdown».
    process.on('message', (message) => {
      if (message === 'shutdown') void shutdown('mensaje shutdown');
    });
    process.on('unhandledRejection', (reason) => log.error({ err: reason }, 'Promesa rechazada sin gestionar'));
    process.on('uncaughtException', (err) => {
      log.error({ err }, 'Excepción no capturada: se apaga el servidor');
      void shutdown('uncaughtException', 1);
    });
  } catch (err) {
    await ctx?.close().catch(() => undefined);
    throw err;
  }
}

main().catch((err) => {
  const code = (err as NodeJS.ErrnoException).code;
  if (err instanceof ConfigurationError) console.error(`[agentforge] ${err.message}`);
  else if (code === 'EADDRINUSE') console.error(`[agentforge] El puerto ya está ocupado por otro programa. Ciérralo o arranca con otro puerto (variable PORT). Detalle: ${errorMessage(err)}`);
  else if (code === 'EACCES') console.error(`[agentforge] No hay permiso para escuchar en esa dirección o puerto. Detalle: ${errorMessage(err)}`);
  else console.error('[agentforge] Error fatal al arrancar:', err);
  process.exit(1);
});
