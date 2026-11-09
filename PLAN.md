# AgentForge — Plan

Plataforma web local para crear, gestionar y ejecutar sistemas de agentes de IA.

## Objetivos

1. Crear agentes (rol, modelo, instrucciones, herramientas) y ejecutarlos contra un modelo real.
2. Coordinar varios agentes en workflows (DAG) con ejecución secuencial y paralela.
3. Persistir todo (agentes, proveedores, workflows, ejecuciones, eventos) y sobrevivir a reinicios.
4. Observar las ejecuciones en tiempo real; cancelar, reintentar y limitar.
5. Funcionar 100 % en local con software libre (Ollama); APIs compatibles con OpenAI como opción.

## Arquitectura

```
shared/   Tipos del dominio, motor de plantillas {{ref}} y validación de grafos (usado por server y web)
server/   Node 24 + TypeScript (tsx) + Fastify 5 + node:sqlite
  db/        esquema, migraciones (PRAGMA user_version) y Store (repositorios)
  crypto/    cifrado AES-256-GCM de API keys en reposo
  llm/       adaptadores: Ollama nativo (/api/chat, NDJSON) y OpenAI-compatible (/chat/completions, SSE)
  tools/     registro extensible + herramientas integradas + herramientas HTTP personalizadas (BD)
  engine/    agent-runner (bucle LLM↔herramientas), workflow-engine (planificador DAG), run-manager (cola, cancelación, eventos)
  routes/    API REST + SSE
web/      Vue 3 + Vite + Pinia + Vue Router + Vue Flow
```

### Decisiones clave

| Decisión | Motivo |
|---|---|
| `node:sqlite` (integrado en Node 24) | Sin binarios nativos que compilar en Windows; SQLite con WAL es suficiente para uso local. |
| SSE en lugar de WebSocket | El flujo es unidireccional (servidor→cliente); SSE reconecta solo y admite `Last-Event-ID` para reanudar. |
| Eventos persistidos con `seq` por ejecución | El historial se reproduce igual que el directo; los *deltas* de tokens son transitorios (no se guardan). |
| Ejecución de agente = workflow de un nodo | Un único motor y un único camino de código para límites, reintentos, cancelación y eventos. |
| Snapshot del workflow y agentes en cada run | El historial es reproducible aunque luego se edite el workflow. |
| Clientes LLM propios sobre `fetch` | Control total de streaming, tool-calls y errores; sin SDKs de pago ni dependencias pesadas. |
| El servidor escucha en 127.0.0.1 | Seguridad razonable por defecto: no se expone a la red. |

### Modelo de ejecución

- Workflow = nodos (`input`, `agent`, `tool`, `condition`, `transform`, `output`) + aristas.
- Un nodo está listo cuando todos sus padres han terminado. Se ejecuta si al menos una arista entrante está activa
  y ningún padre ha fallado; si no, se marca `skipped` (rama no tomada o dependencia fallida).
- Los nodos listos se lanzan en paralelo hasta `maxConcurrency`.
- Los resultados se comparten mediante plantillas: `{{input}}`, `{{upstream}}`, `{{id_nodo}}`.
- Límites por run: duración máxima, nº máximo de llamadas LLM, iteraciones por agente, timeout y reintentos por nodo
  (backoff exponencial). Política de error `fail` (aborta) o `continue`.
- Cancelación con `AbortController` propagado hasta el `fetch` del LLM y las herramientas.

## Tareas

- [x] T0 Inspección del entorno
- [ ] T1 Base del monorepo, tipos compartidos, plantillas y validación de grafo
- [ ] T2 Persistencia (SQLite + Store + cifrado de secretos)
- [ ] T3 Adaptadores LLM (Ollama, OpenAI-compatible)
- [ ] T4 Sistema de herramientas (integradas + HTTP personalizadas)
- [ ] T5 Motor: agent-runner, workflow-engine, run-manager
- [ ] T6 API REST + SSE + datos de ejemplo (seed)
- [ ] T7 Tests del backend (unidad, protocolo, motor, API, persistencia)
- [ ] T8 Verificación con modelo real (Ollama)
- [ ] T9 Frontend: sistema de diseño, layout, API client, stores
- [ ] T10 Vistas: Dashboard, Agentes (+playground), Workflows (constructor visual), Ejecuciones (monitor), Herramientas, Ajustes
- [ ] T11 Verificación end-to-end en navegador + reinicio
- [ ] T12 Revisión crítica, endurecimiento, documentación final

Prioridad: T1→T8 (núcleo verificable) antes que la interfaz; después T9→T11; T12 continuo.
