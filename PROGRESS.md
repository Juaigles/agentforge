# AgentForge — Progreso

_Última actualización: 2026-11-09 (hito 1: backend completo y verificado)._

## Estado real

| Área | Estado | Notas |
|---|---|---|
| Tipos compartidos, plantillas, validación de grafos | Hecho y probado | `shared/` |
| Persistencia SQLite (`node:sqlite`) + cifrado de API keys | Hecho y probado | Migraciones por `PRAGMA user_version` |
| Adaptador Ollama nativo | Hecho; verificado con Ollama real | Streaming NDJSON, tool-calls, `think` |
| Adaptador OpenAI-compatible | Hecho; verificado contra `/v1` de Ollama | SSE, tool-calls troceadas, `reasoning_effort` |
| Herramientas (11 integradas + HTTP personalizadas) | Hecho y probado | SSRF bloqueado por defecto; código desactivado por defecto |
| Motor (agent-runner, workflow-engine, run-manager) | Hecho y probado | Paralelismo, ramas, reintentos, timeouts, límites, cancelación |
| API REST + SSE | Hecho y probado | |
| Datos de ejemplo (seed) | Hecho y probado | 5 agentes, 2 workflows |
| Frontend | **Pendiente** | Siguiente hito |

## Problemas encontrados y resueltos

1. **Puerto 8787 ocupado** por otro proceso de la máquina → puerto por defecto 4310.
2. **Bucle de llamadas idénticas fallidas** (el modelo pequeño repetía `web_fetch` a URLs inventadas) →
   guardarraíl en `agent-runner`: una llamada idéntica que ya falló no se vuelve a ejecutar.
3. **Contaminación por el ejemplo de la descripción de la calculadora** (el modelo calculó el ejemplo y lo
   metió en el informe) → descripción sin ejemplo numérico; agentes del workflow principal sin herramientas.
4. **`app.close()` colgado con clientes SSE conectados** → `forceCloseConnections: true`.
5. **Vía OpenAI-compatible el modelo razonaba siempre** y agotaba los tokens → se envía
   `reasoning_effort: "none"` si el agente tiene el razonamiento desactivado, con caché de parámetros rechazados.
6. **`htmlToText` dejaba espacios tras los saltos de línea** → normalización corregida.
7. **El uso (tokens) se perdía si un agente fallaba a medias** → contabilidad incremental (`onUsage`).

## Próximos pasos

1. Frontend: sistema de diseño, layout, cliente API, stores.
2. Vistas: Dashboard, Agentes (+ banco de pruebas), Workflows (constructor visual), Ejecuciones (monitor en vivo),
   Herramientas, Ajustes.
3. Verificación end-to-end en navegador con modelo real y reinicio.
4. Revisión crítica y documentación final (README).
