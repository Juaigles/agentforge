# AgentForge — Progreso

_Última actualización: 2026-11-09 (hito 3: producto completo verificado de extremo a extremo)._

## Estado real

| Área | Estado | Cómo se ha verificado |
|---|---|---|
| Tipos compartidos, plantillas, validación de grafos | Hecho | Tests unitarios |
| Persistencia SQLite + cifrado de API keys | Hecho | Tests sobre BD en disco + 3 reinicios reales del servidor |
| Adaptador Ollama nativo | Hecho | Tests de protocolo + Ollama real |
| Adaptador OpenAI-compatible | Hecho | Tests de protocolo + endpoint `/v1` de Ollama real |
| Herramientas (11 integradas + HTTP personalizadas) | Hecho | Tests + banco de pruebas en el navegador |
| Motor (paralelismo, ramas, reintentos, límites, cancelación) | Hecho | 31 tests + ejecuciones reales |
| API REST + SSE | Hecho | Tests (incluye SSE con `Last-Event-ID`) |
| Frontend (panel, agentes, constructor, monitor, herramientas, ajustes, glosario) | Hecho | Navegador, con modelo real |
| Responsive y temas claro/oscuro | Hecho | 9 rutas a 375 px sin desbordamiento horizontal |
| Dependencias | `npm audit`: 0 vulnerabilidades | Tras actualizar `@fastify/static` y Vitest |

## Problemas encontrados y resueltos

1. **Puerto 8787 ocupado** por otro proceso de la máquina → puerto por defecto 4310.
2. **Bucle de llamadas idénticas fallidas** (el modelo repetía `web_fetch` a URLs inventadas) → guardarraíl:
   una llamada idéntica que ya falló no se vuelve a ejecutar.
3. **Contaminación por el ejemplo de la descripción de la calculadora** → descripción sin ejemplo numérico;
   los agentes del workflow principal no llevan herramientas.
4. **`app.close()` colgado con clientes SSE conectados** → `forceCloseConnections: true`.
5. **Vía OpenAI-compatible el modelo razonaba siempre** y agotaba los tokens → `reasoning_effort: "none"` si
   el agente tiene el razonamiento desactivado, con caché de parámetros que el servidor rechace.
6. **`htmlToText` dejaba espacios tras los saltos de línea** → normalización corregida.
7. **El uso (tokens) se perdía si un agente fallaba a medias** → contabilidad incremental (`onUsage`).
8. **Grafo vacío en el monitor**: `structuredClone` no clona los Proxy reactivos de Vue → copia vía JSON
   (también afectaba a «duplicar nodo»).
9. **Página en blanco tras recompilar el frontend sin reiniciar**: `@fastify/static` con `wildcard: false`
   solo servía los archivos existentes al arrancar → resolución dinámica, 404 para assets inexistentes,
   `no-cache` en `index.html` e `immutable` en assets. Cubierto por `static.test.ts`.
10. **Pasos listados en orden de creación** → se guardan en orden topológico.
11. **Nodos nuevos apilados en el lienzo** → se colocan a la derecha del seleccionado, buscan hueco libre y se
    conectan automáticamente.
12. **Encuadre del grafo antes de medir los nodos** → `onNodesInitialized`.
13. **Vulnerabilidades en `@fastify/static` ≤ 10.1.8 y dependencias de Vitest** → actualizadas.

## Pendiente y limitaciones

- **Sin autenticación ni multiusuario.** Pensado para uso local (escucha en 127.0.0.1).
- **Los workflows son DAG**: no hay bucles ni iteración sobre listas («para cada elemento…»).
- **Sin ejecución programada** (cron) ni disparadores externos (webhooks).
- **Sin MCP**: las herramientas son las integradas y las HTTP personalizadas.
- **El historial de eventos crece sin límite**; se vacía a mano («Vaciar historial»). No hay retención
  automática.
- **Una ejecución interrumpida por un apagado no se reanuda sola**: se marca como fallida y se puede
  «reintentar desde el fallo».
- **`run_javascript` no es un sandbox fuerte** (por eso está desactivado por defecto).
- **Protección SSRF sin fijación de DNS**: se valida la IP resuelta antes de conectar, pero un DNS
  malicioso con TTL 0 podría cambiarla entre la comprobación y la conexión (rebinding).
- **Los proveedores OpenAI reales (de pago) no se han probado**; el adaptador se ha verificado contra el
  endpoint compatible de Ollama y contra un servidor de pruebas que habla el protocolo.
- **El editor de herramientas HTTP no edita `enum` ni valores por defecto** de los parámetros (los conserva).
- **Paralelismo real limitado por el proveedor**: Ollama atiende las peticiones a un mismo modelo según
  `OLLAMA_NUM_PARALLEL`; el motor las lanza en paralelo igualmente.
- **Sin tests end-to-end automatizados del navegador** (Playwright): la interfaz se ha verificado a mano en
  el navegador; la lógica de estado en vivo sí tiene tests unitarios.
- Las estadísticas diarias se agrupan por fecha UTC.

## Próximos pasos sugeridos

1. Nodo «para cada» y subworkflows.
2. Cliente MCP como tercera fuente de herramientas.
3. Retención automática de eventos y exportación/importación de workflows en JSON.
4. Tests end-to-end con Playwright en CI.
