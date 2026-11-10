# AgentForge — Progreso

_Última actualización: 2026-11-10 (hito 4: endurecimiento punto por punto; ver «Hito 4» más abajo)._

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

## Hito 4 — Endurecimiento hacia nivel comercial

Se trabaja punto por punto, sin pasar al siguiente hasta implementar, verificar y documentar el actual.

### 4.1 Interfaz con tests repetibles — HECHO

- **Suite end-to-end con Playwright (Chromium)**: 21 tests en 5 archivos (`e2e/`), script `npm run test:e2e`.
  Arranca el servidor de producción en un puerto libre con datos temporales y un servidor local que habla el
  protocolo real de Ollama (NDJSON, streaming, tool-calls) y de OpenAI (SSE). Documentada en `e2e/README.md`.
- **Tests de componentes** (Vitest + Vue Test Utils + jsdom): `Term.vue`, `RunActivity.vue`, `FlowNode.vue` y el
  formulario de agentes (`AgentEditorView.vue`), este último contra la API real arrancada en el propio test.
- **Defectos reales que la suite destapó y que se han corregido:**
  14. **La página se desbordaba ~600 px en horizontal en móvil** en «Ejecuciones» en cuanto había filas: el
      `.sr-only` de la cabecera de la tabla escapaba del contenedor con scroll. La comprobación manual anterior
      («9 rutas sin desbordamiento») se hizo sin datos suficientes. → `.table-wrap` es ahora bloque contenedor.
  15. **Escribir en «Tokens de salida máximos» lanzaba una excepción** (`v.trim is not a function`): Vue entrega
      un número en los `<input type="number">`.
  16. **En móvil los enlaces de navegación no tenían nombre accesible** (solo un icono) → `aria-label` y `title`.
  17. **Un nodo añadido desde la paleta podía quedar fuera del lienzo visible** (debajo del inspector), sin forma
      de conectarlo sin desplazar el lienzo → el lienzo se reencuadra si el nodo nuevo no se ve.
  18. **Desde un nodo «Condición» el nodo siguiente no se conectaba** → ahora ocupa la primera rama libre.
  19. **La calculadora devolvía ruido de coma flotante** (`2965.4680000000003`) → 12 cifras significativas.
  20. **Al cancelar se perdía de la pantalla el texto que el modelo ya había generado** → se conserva en el
      banco de pruebas y en el monitor (solo en la sesión abierta: el texto parcial no se persiste).
  21. **Vulnerabilidades moderadas en dependencias transitivas** de `@vue/test-utils` (`glob`, `minimatch`) →
      `overrides` en `package.json`; `npm audit` vuelve a dar 0.

### 4.2 Vistas no ejercitadas (Herramientas, Ajustes, proveedores) — HECHO

- **Ejercitadas de punta a punta** con 13 tests e2e nuevos (`e2e/tools.spec.ts`, `e2e/settings.spec.ts`) y a mano en
  el navegador con Ollama real: alta/edición/desactivación/borrado de una herramienta HTTP y su uso real por un
  agente contra una API local (con «redes privadas» bloqueadas primero y permitidas después); método POST con
  plantilla de cuerpo; visor (Markdown y texto) y borrado de archivos del espacio de trabajo; alta, prueba, edición
  y borrado de proveedores; cada interruptor de Ajustes con su efecto real; «Eliminar ejecuciones terminadas».
- **API key**: comprobado en la petición real que al editar sin tocar la clave el cuerpo **no lleva** `apiKey`, que
  «Quitar clave» envía `apiKey: null`, y que la clave no aparece ni en la respuesta de la API ni en la página.
- **Completado lo que faltaba:**
  - El editor de herramientas edita ahora los **valores permitidos (`enum`)** y el **valor por defecto** de cada
    parámetro, con validación por tipo en el formulario y en el servidor (antes solo los conservaba).
  - Nuevo endpoint `POST /api/providers/models`: lista los modelos de una configuración **sin guardar**. El modal
    de proveedor carga la lista al pulsar «Probar», también en el alta.
- No aparecieron defectos funcionales en estas vistas más allá de esas dos carencias; los defectos de este hito
  salieron de las vistas del punto 4.1.

### 4.3 Glosario completo — HECHO

- Revisadas todas las pantallas y modales: el glosario pasa de 34 a **44 entradas** (API, URL, cabecera, método
  HTTP, cola, en paralelo, capacidades, cifrado, base de datos, Node.js) y de 56 a 95 usos de `<Term>`.
- Las cinco entradas que existían pero no se usaban en ninguna pantalla (condición, delegación, instantánea,
  memoria compartida, prompt) tienen ahora su sitio, con texto de ayuda nuevo donde hacía falta (p. ej. la nota
  «Se muestra la instantánea del workflow…» sobre el grafo de una ejecución).
- Dos términos estaban dentro de títulos `h2`, en contra de la norma: se han pasado al texto de ayuda.
- **Test de coherencia** (`web/src/lib/glossary.test.ts`): analiza las plantillas con el compilador de Vue y falla
  si un `<Term id>` no existe, si una entrada no se usa, si un término está dentro de un botón, enlace, código o
  título, o si una definición no cabe en un tooltip. Comprobado que detecta cada infracción introduciéndolas a mano.

### 4.4 Robustez del servidor — HECHO

- **(a) Retención automática del historial**, configurable en *Ajustes → Datos*: días de conservación y número
  máximo de ejecuciones terminadas (0 = sin límite). Borra ejecuciones con sus pasos y eventos; nunca las que están
  en curso ni las pendientes de reanudar. Se aplica al arrancar, cada hora, al terminar cada ejecución y al guardar
  el ajuste. Tests de almacén, de API y e2e.
- **(b) SSRF con la IP fijada**: `safeFetch` se ha reescrito sobre `node:http(s)` con una función `lookup` que
  entrega al socket la IP ya validada; el nombre se resuelve una sola vez por salto. Test de rebinding con dos
  servidores reales en 127.0.0.1 y 127.0.0.2 y un DNS que cambia de respuesta. De paso se encontró y cerró un
  **hueco real**: `http://[::ffff:127.0.0.1]/` (el analizador de URL lo normaliza a `::ffff:7f00:1`) **saltaba el
  filtro** y llegaba a localhost. Ahora se reconocen las IPv4 mapeadas, compatibles y NAT64 en cualquier notación.
- **(c) Reanudación tras un apagado**: las ejecuciones interrumpidas se marcan (migración de esquema v2) y la
  interfaz muestra en cualquier pantalla un aviso para **reanudarlas** —reutilizando los pasos completados— o
  **descartarlas**. Aparece también sin recargar si el servidor se reinicia con la página abierta. Verificado con
  Ollama real: matando el servidor con «Redactar informe» en curso, la reanudación reutilizó `tema`,
  `investigar` y `analizar` e hizo solo 2 llamadas al modelo.
- **(d) `run_javascript` endurecido**: el contexto `node:vm` vive ahora en un **proceso hijo** con
  `--permission`, sin entorno heredado, con límite de memoria, de tiempo (también para promesas), de salida y de
  concurrencia (4). Admite código asíncrono. El README detalla lo que **no** es (ver «Seguridad»).

## Pendiente y limitaciones

- **Sin autenticación ni multiusuario.** Pensado para uso local (escucha en 127.0.0.1).
- **Los workflows son DAG**: no hay bucles ni iteración sobre listas («para cada elemento…»).
- **Sin ejecución programada** (cron) ni disparadores externos (webhooks).
- **Sin MCP**: las herramientas son las integradas y las HTTP personalizadas.
- **La retención viene desactivada** (0 = sin límite): hasta que se configure, el historial crece. Tras borrar no
  se compacta el archivo de la base de datos (`VACUUM`); SQLite reutiliza el espacio, pero el archivo no encoge.
- **La reanudación tras un apagado la decide el usuario** (aviso en la interfaz); no hay reanudación automática
  desatendida. Un paso que estaba a medias se repite entero: el texto parcial del modelo no se recupera.
- **`run_javascript` no es un sandbox fuerte** (desactivado por defecto): sin contenedor ni aislamiento del sistema
  operativo, y con Node 22–24 el proceso aislado conserva acceso a la red si el código escapa de `node:vm`.
- **Fijación de DNS**: la resolución de nombres del test de rebinding se inyecta como función (no hay un servidor
  DNS real en la prueba); la conexión a la IP fijada sí se comprueba con sockets reales. No se ha probado contra un
  dominio de rebinding real en Internet.
- **Los proveedores OpenAI reales (de pago) no se han probado**; el adaptador se ha verificado contra el
  endpoint compatible de Ollama y contra un servidor de pruebas que habla el protocolo.
- **El editor de herramientas HTTP no edita esquemas anidados** (`items` de listas, propiedades de objetos): los conserva.
- **Los valores permitidos se escriben separados por comas**, así que un valor no puede contener una coma.
- **Paralelismo real limitado por el proveedor**: Ollama atiende las peticiones a un mismo modelo según
  `OLLAMA_NUM_PARALLEL`; el motor las lanza en paralelo igualmente.
- **La suite e2e solo se ejecuta en Chromium** y con el modelo simulado; no hay CI configurado (se lanza a mano).
- **El texto parcial de un paso cancelado no se persiste**: se ve en la sesión en la que se canceló, pero no al
  volver a abrir la ejecución más tarde.
- **Glosario**: «primera aparición por sección» se ha aplicado a mano; el test no puede comprobar que no falte
  ningún término por marcar, solo que lo marcado es coherente. Los textos que llegan del servidor (descripciones de
  herramientas, mensajes de error) y los de las opciones de un desplegable no llevan tooltip.
- Las estadísticas diarias se agrupan por fecha UTC.

## Próximos pasos sugeridos

1. Nodo «para cada» y subworkflows.
2. Cliente MCP como tercera fuente de herramientas.
3. Retención automática de eventos y exportación/importación de workflows en JSON.
4. Ejecutar la suite e2e en CI y en Firefox/WebKit.
