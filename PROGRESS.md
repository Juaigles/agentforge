# AgentForge — Progreso

_Última actualización: 2026-11-12 (versión 1.0.0: hito 5 completo, fases 1 a 10, más la pasada de cierre; informe
del hito en `docs/informe-hito5.md`, cambios de la 1.0 en `CHANGELOG.md`)._

## Estado real

| Área | Estado | Cómo se ha verificado |
|---|---|---|
| Tipos compartidos, plantillas, validación de grafos | Hecho | Tests unitarios |
| Persistencia SQLite + cifrado de API keys | Hecho | Tests sobre BD en disco + 3 reinicios reales del servidor |
| Adaptador Ollama nativo | Hecho | Tests de protocolo + Ollama real |
| Adaptador OpenAI-compatible | Hecho | Tests de protocolo + endpoint `/v1` de Ollama real |
| Herramientas (11 integradas + HTTP personalizadas) | Hecho | Tests + banco de pruebas en el navegador |
| Motor (paralelismo, ramas, reintentos, límites, cancelación) | Hecho | `engine.test.ts`, `foreach.test.ts`, `flow.test.ts` y `gaps.test.ts` + ejecuciones reales |
| API REST + SSE | Hecho | Tests (incluye SSE con `Last-Event-ID`) |
| Frontend (panel, agentes, constructor, monitor, herramientas, ajustes, glosario) | Hecho | Navegador, con modelo real |
| Responsive y temas claro/oscuro | Hecho | 14 rutas × 2 temas a 375 px sin desbordamiento horizontal (`e2e/layout.spec.ts`), en tres navegadores |
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

### 4.5 Capacidades del motor — HECHO

- **Nodo «para cada»**: itera sobre una lista (JSON, viñetas, numerada o un elemento por línea) con concurrencia
  limitada (1-8), reintentos **por elemento**, tope de elementos, `{{item}}`/`{{index}}`/`{{total}}` y salida por
  apartados o JSON. 16 tests del motor (`server/test/foreach.test.ts`), paleta, inspector y validación en el
  constructor, avance en vivo en el monitor y 1 test e2e.
- **Exportar/importar workflows en JSON** desde la lista y desde el constructor. El archivo lleva la definición y
  los agentes que usa (sin proveedor ni claves). Al importar, cada agente se enlaza con uno existente (por id o por
  nombre) o se crea con el proveedor por defecto; se avisa de las herramientas que no existen y el workflow queda
  como borrador con los errores señalados. 5 tests de API y 3 e2e (descarga real del archivo y subida).
- **Ejecución programada sencilla** (sustituida por los disparadores en la fase 4 del hito 5): cada workflow puede lanzarse cada N minutos/horas/días o a una hora fija cada
  día (esquema v3, `server/src/engine/scheduler.ts`). Sin solapes, con «Ejecutar ahora», pausa y registro del motivo
  cuando una cita no se lanza. Las ejecuciones llevan la marca «programada». 10 tests del servidor y 2 e2e, uno de
  ellos esperando **al temporizador real** un minuto.
- **Verificado con Ollama real** (`qwen3.5:4b-q4_K_M`): ver `TEST_RESULTS.md`, sección 1.1.
- Defecto encontrado por los tests y corregido: un arranque de cola pendiente podía ejecutarse **después** de
  cerrar la base de datos al apagar (`database is not open`).

## Hito 5 — Llevarlo a primer nivel

Plan, auditoría inicial (siete informes) y fases en `PLAN.md`. Se trabaja por fases; cada una termina con las
cuatro baterías en verde, verificación real y un commit.

### Fase 1 · Fiabilidad y seguridad del servidor — HECHA (2026-11-11)

**Ciclo de vida de las ejecuciones**

- **El apagado ordenado deja las ejecuciones reanudables.** Antes, Ctrl+C las cerraba como «canceladas por el
  usuario» y la reanudación solo funcionaba tras una muerte brusca. Ahora se abortan con un motivo propio
  (`ShutdownSignal`), quedan «interrumpidas» —también las que esperaban en la cola— y al volver se ofrecen para
  reanudar. El apagado tiene plazo (`AGENTFORGE_SHUTDOWN_GRACE_MS`, 10 s), una segunda señal fuerza la salida, y
  se atienden `SIGBREAK`, `SIGHUP` y el mensaje IPC `shutdown` (la única vía de apagado ordenado entre procesos
  en Windows). Orden: ejecuciones → conexiones → base de datos.
- **`safeFetch` ya no se cuelga** con una respuesta comprimida que se corta o se cancela (`pipe` no propagaba el
  cierre; ahora `pipeline`). Como defensa añadida, el motor espera cada nodo en carrera con la señal: una
  herramienta que ignore la cancelación no retiene la ejecución ni el apagado.
- **Ningún paso queda «en curso»** tras un fallo inesperado: `executeNode` nunca rechaza, el planificador aborta
  y espera a los nodos en vuelo antes de salir, y el gestor cierra los pasos abiertos si el motor falla.
- **Configuración de nodos validada** al guardar y al importar (`timeoutMs` ≤ 6 h, reintentos 0-5, concurrencia
  1-8, elementos 1-100); el motor recorta además los valores heredados fuera de rango.
- **Reintentos solo de errores transitorios.** Antes se reintentaba todo lo que no llevara marca, repitiendo
  herramientas con efectos. Ahora solo lo marcado (red, tiempo de espera, 408/429/5xx).
- **Base de datos:** una base de versión más reciente que el código se rechaza al abrir; antes de migrar se
  guarda una copia coherente (`agentforge.db.v<N>.bak`); `synchronous=NORMAL`. Un solo servidor por carpeta de
  datos (`agentforge.lock`). Una API key que no se puede descifrar da un mensaje accionable.
- **Errores que ya no se tragan:** el planificador evalúa cada programación por separado y registra los fallos;
  un error al cerrar una ejecución ya no es un rechazo sin dueño; hay manejadores de `unhandledRejection` y
  `uncaughtException`.

**Seguridad**

- **Las API keys guardadas no salen hacia otra dirección.** Probar, listar modelos o guardar un proveedor con una
  URL de otro origen exige volver a escribir la clave. Antes bastaba una petición para que el servidor la enviase
  a una URL elegida por quien llamaba.
- **Cabecera `Host` siempre comprobada**, también con `HOST=0.0.0.0` (antes se desactivaba entera):
  se admiten las direcciones y el nombre del propio equipo y lo declarado en `AGENTFORGE_ALLOWED_HOSTS`.
- **Clave de acceso** (`AGENTFORGE_TOKEN`): obligatoria para escuchar fuera de este equipo —el servidor se niega
  a arrancar sin ella—; se acepta como `Authorization: Bearer` o como sesión (cookie `HttpOnly`, `SameSite=Strict`,
  derivada de la clave). La interfaz muestra una pantalla de entrada.
- **Peticiones desde otra web rechazadas** (`Sec-Fetch-Site`, `Origin`), también las lecturas y los POST sin cuerpo.
- **Cabeceras de seguridad** en todas las respuestas, con una política de contenido (CSP) que solo admite scripts
  propios y, por su hash, el script en línea de `index.html`. La suite e2e completa pasa con ella activa.
- **Límite de tasa** por cliente (`AGENTFORGE_RATE_LIMIT`, 1200/min), diez veces más estricto para lo que lanza
  trabajo caro y de 10/min para el inicio de sesión.
- **Las herramientas no pueden llamar a la propia API**, ni con «redes privadas» permitidas.
- **Redirecciones:** las cabeceras de la herramienta no viajan a otro origen y se rechaza pasar de https a http.
- **Condición «coincide con»** evaluada en un hilo aparte con límite de tiempo: una expresión con retroceso
  catastrófico ya no congela el servidor.
- **Plantillas del cuerpo** de las herramientas HTTP escapadas para JSON; saltos de línea fuera de las cabeceras.
- **Cuota del espacio de trabajo** (5 MB por archivo, 100 MB en total) y lectura acotada al mostrar un archivo.
- **Direcciones privadas disfrazadas:** 6to4, Teredo, NAT64 local y `192.88.99.0/24`.
- **`run_javascript` sin red.** Node 24 no tiene permiso de red, así que el proceso aislado inutiliza sus propias
  API de red antes de ejecutar nada; donde exista `--allow-net` lo deniega el propio modelo de permisos. El
  servidor lo **comprueba con una conexión real** y lo muestra en Ajustes. `import()` ya no entrega objetos del
  proceso anfitrión. Nuevo **aislamiento en contenedor** (Docker o Podman, sin red, de solo lectura, sin
  privilegios), seleccionable en Ajustes; no descarga la imagen por su cuenta.
- **Vite en desarrollo** ya no puede servir la carpeta de datos.

**Operación**

- Configuración validada al arrancar, con un mensaje por variable; registro estructurado siempre activo
  (`AGENTFORGE_LOG_LEVEL`), con las credenciales excluidas; sondas `GET /api/health/live` y `/api/health/ready`
  (esta comprueba la base de datos, la carpeta de datos y el planificador); mensajes claros para puerto ocupado e
  interfaz sin compilar.

**Defectos encontrados al implementar** (además de los de la auditoría): `import()` dentro del entorno aislado
entregaba un error del proceso anfitrión; el mensaje de un parámetro de consulta no válido salía en inglés.

### Fase 2 · Datos y rendimiento — HECHA (2026-11-11)

Primero se escribió la prueba de carga (`npm run loadtest`) y se midió el commit de partida; después se
corrigieron los cuellos de botella y se volvió a medir. Cifras con **50 000 ejecuciones** (base de 891 MB),
servidor real, esta máquina. «Bloqueo» es lo que se para el resto del servidor mientras atiende la operación.

| Operación | Antes (`8bef427`) | Después | |
|---|---|---|---|
| Estadísticas del panel | 1 120 ms (bloqueo 1 103 ms) | 3,1 ms | ×360 |
| Lista filtrada por estado | 204 ms | 2,2 ms | ×93 |
| Lista por workflow / por agente | 110 / 108 ms | 0,6 / 1,4 ms | |
| Página profunda (posición 45 000) | 313 ms | 0,9 ms | ×350 |
| Ejecuciones interrumpidas | 189 ms | 0,3 ms | |
| Búsqueda (término frecuente / inexistente) | 117 / 321 ms | 4,7 / 0,3 ms | |
| Tamaño de la respuesta de una lista de 200 | 522 KB | 186 KB | |
| Inserción de eventos | 2 317 por segundo | 34 540 por segundo | ×15 |
| Retención sin nada que borrar (por ejecución terminada) | 656 ms | 1 ms | |
| Retención que borra la mitad del historial | un bloqueo de 4,5 s | tandas de ≤ 0,21 s | |
| Archivo tras borrar la mitad | no encoge (893 MB) | 1 239 → 805 MB | |

Con 10 000 ejecuciones la proporción es la misma (estadísticas de 223 a 1,7 ms). Las ejecuciones concurrentes
contra un modelo simulado no cambian de ritmo (≈ 250 por minuto con 10 a la vez): su límite es el modelo.

- **Estadísticas incrementales.** El panel leía la tabla de ejecuciones entera tres veces por petición y la
  pedía tras cada paso. Ahora hay tablas de agregados que se actualizan al terminar cada ejecución, cada paso y
  cada llamada a herramienta. Son **acumuladas**: no bajan al borrar ejecuciones. La serie diaria usa la fecha
  local (antes, la fecha UTC).
- **Índices y paginación.** Índices para los filtros reales y para la retención; la página se localiza
  recorriendo solo un índice y después se leen sus filas.
- **Listados ligeros.** Los resúmenes llevan los 300 primeros caracteres de la entrada y del resultado; el
  texto completo, solo en el detalle.
- **Búsqueda de texto completo** en el nombre, la entrada y el resultado (o el error), por subcadenas, sin
  distinguir mayúsculas ni tildes.
- **La salida ya no se guarda tres veces**: los eventos persistidos no repiten la salida del paso ni la de la
  ejecución (el evento en directo sí la lleva).
- **Retención por tandas** de 100 ejecuciones, cediendo el control entre ellas, y **compactación incremental**:
  el archivo encoge solo, sin reescribirlo.
- **Fragmentos del modelo agrupados** en ventanas de 33 ms, y Markdown pintado como mucho unas 8 veces por
  segundo: menos mensajes y menos trabajo del navegador en respuestas largas.
- **SSE**: el historial se reproduce por tandas sin perder ni duplicar lo que ocurre mientras tanto, y a un
  cliente que no lee se le corta en lugar de acumularle memoria.
- **`web_fetch`**: la conversión de HTML a texto es de coste lineal; antes, una página con miles de bloques
  sin cerrar podía congelar el servidor durante minutos.
- **Memoria compartida persistida**: reintentar desde el fallo o reanudar conserva lo que los pasos ya
  hechos guardaron con `memory_set`.
- **Copias de seguridad desde Ajustes**: crear (con ejecuciones en curso), descargar, añadir desde un
  archivo, restaurar y borrar. Una copia es un único archivo `.afbackup` con la base de datos, la clave maestra
  y el espacio de trabajo. Restaurar valida la copia, la deja preparada y la aplica **al reiniciar**; lo que
  había se conserva en `data/replaced-<fecha>/`.
- **Migración v4** comprobada sobre los datos reales de esta instalación (16 ejecuciones): estadísticas e índice
  de búsqueda reconstruidos y copia previa `agentforge.db.v3.bak`.

**Defectos encontrados al implementar:** la lista de ejecuciones se encogía sola al refrescar con más de 200
filas cargadas; al preparar una restauración quedaba abierto el archivo de la copia (en Windows, bloqueado); la
sección nueva de Ajustes desbordaba en móvil (lo detectó la suite e2e).

### Fase 3 · Motor — HECHA (2026-11-11)

- **Subworkflows.** Un nodo puede lanzar otro workflow como un paso y recibir su resultado. La subejecución es
  una ejecución propia, visible en el historial y enlazada en los dos sentidos con la que la lanza; no pasa por
  la cola, se cancela con su madre y su uso se suma al paso. La instantánea de la ejecución incluye los
  subworkflows tal como eran al lanzarla. Se anidan hasta 5 niveles; la validación impide los ciclos entre
  workflows y el servidor no deja borrar un workflow que otro usa.
- **«Para cada» ampliado.** El cuerpo puede ser un agente, una **herramienta** (sin pasar por un modelo) o un
  **subworkflow** (un flujo de varios nodos por elemento). **Política por elemento**: detener el nodo o seguir
  con los demás, señalando el fallo en el resultado. El resultado de cada elemento se guarda y, **al reintentar
  desde el fallo, los elementos ya completados no se repiten**.
- **Aprobación humana.** Nodo con dos salidas (aprobado / rechazado). La ejecución queda «en espera», aparece
  un aviso en cualquier pantalla con el texto a aprobar y se decide con un comentario opcional, que los nodos
  siguientes pueden usar (`{{id.comment}}`). Mientras espera **no ocupa un hueco de ejecución ni consume la
  duración máxima**. **Sobrevive a un reinicio**: al arrancar, la ejecución vuelve sola a pedir la decisión sin
  repetir los pasos ya hechos.
- **Reanudación automática opcional** (*Ajustes*): las ejecuciones interrumpidas por un apagado siguen solas al
  arrancar. Las que solo esperaban una aprobación se reanudan siempre.
- **Texto parcial persistido**: si un paso se cancela o falla con el modelo a media respuesta, lo que llevaba
  escrito se guarda con el paso y se ve al volver a abrir la ejecución.
- **Listas tolerantes**: «para cada» entiende un array JSON precedido de una frase, dentro de una valla de
  código, con una coma final o envuelto en un objeto; «2024. Informe» ya no se toma por un elemento numerado.
- **Respuestas cortadas (protocolo de OpenAI)**: un flujo que se cierra sin fin de mensaje es un error
  reintentable, no una respuesta; una llamada a herramienta con argumentos a medias **no se ejecuta** (el
  modelo recibe el motivo), y la respuesta cortada por el límite de tokens queda marcada.
- **Ids de nodo reservados**: un nodo no puede llamarse `input`, `total`, etc., y los ids generados lo evitan.
- **Verificado con Ollama**: un workflow real con subworkflow (Analista) → aprobación → Redactor; la decisión se
  tomó en el navegador con un comentario, que el modelo recibió.

### Fase 4 · Disparadores y MCP — HECHA (2026-11-11)

- **Disparadores en lugar de «una programación por workflow»** (esquema v6; las programaciones que había se
  convierten solas). Un workflow puede tener hasta 20, de cuatro tipos:
  - **Cada cierto tiempo.** La siguiente ocasión se cuenta desde la prevista, no desde el momento en que se
    comprobó: antes el horario se retrasaba unos segundos en cada vuelta.
  - **Días y hora**: una hora y, si se quiere, solo algunos días de la semana.
  - **Cron** de cinco campos (listas, rangos, pasos, nombres de mes y de día, alias `@daily`…), con analizador
    propio y mensajes que dicen qué campo falla. Una expresión que no se cumple nunca se rechaza al guardar.
  - **Webhook**: `POST /api/hooks/<id>` con un secreto (en claro o como firma HMAC-SHA256 del cuerpo). El secreto
    se genera en el servidor, se guarda cifrado, se enseña una sola vez y se puede regenerar. El cuerpo de la
    petición es la entrada del workflow, opcionalmente dentro de una plantilla (`{{body}}`).
- **Zona horaria** por disparador (la del servidor si no se indica), resuelta con la base de datos de zonas de
  Node. **Cambio de hora**: una tarea a una hora fija se ejecuta exactamente una vez al día; si la hora no existe
  (primavera) se ejecuta al terminar el salto, y si se repite (otoño) solo la primera vez.
- **Una hora fija que llega tarde no se ejecuta a deshora**: si el servidor estaba apagado y la ocasión llega con
  más de una hora de retraso, se omite y queda anotado. Los intervalos sí se ejecutan una vez al volver.
- **Interfaz**: diálogo de disparadores con la lista (activar o pausar cada uno, ejecutar ahora, editar, borrar),
  formulario con las **próximas cinco ocasiones calculadas por el servidor** mientras se escribe, dirección del
  webhook y ejemplo de `curl` para copiar. En el historial, las ejecuciones lanzadas por un webhook llevan su
  propia marca.
- **Cliente MCP** (`server/src/tools/mcp.ts`, SDK oficial `@modelcontextprotocol/client` 2.4): servidores por
  **stdio** (AgentForge arranca el programa) y por **HTTP** (Streamable HTTP con cabeceras). Sus herramientas son
  la tercera fuente del registro, con el nombre `servidor__herramienta`; el modelo recibe su esquema JSON completo
  (también anidado) y la validación de argumentos la hace el propio servidor MCP. Variables de entorno y cabeceras
  cifradas; la lista de herramientas se guarda para que los agentes que las usan sigan siendo válidos mientras el
  servidor arranca o si se cae; reconexión automática al usarlas; aviso de cambios en la lista; cancelación y
  tiempo máximo por llamada; el motivo por el que un programa no arranca (su salida de errores) se enseña.
- **Interfaz de MCP**: pestaña *Servidores MCP* en Herramientas (estado, herramientas, reconectar, editar sin
  reescribir los secretos, eliminar). Sus herramientas se prueban en el banco de pruebas como las demás.
- **Glosario**: disparador, cron, webhook, zona horaria y MCP.
- **Verificado con Ollama**: ver `TEST_RESULTS.md`, sección 1.1.

### Fase 5 · Portabilidad — HECHA (2026-11-12)

- **Archivo de exportación completo (formato v2)**: además del workflow y sus agentes, lleva los **subworkflows**
  que usa (también los anidados), las **herramientas HTTP personalizadas** de los agentes y de los nodos, los
  **proveedores** de los agentes y los **disparadores**. No lleva ningún secreto: ni claves de API, ni valores de
  cabeceras con credenciales, ni secretos de webhooks. Los archivos v1 se siguen pudiendo importar.
- **Agentes sueltos**: se exportan e importan desde la pantalla de Agentes, con sus herramientas HTTP y su
  proveedor.
- **Importación en dos pasos** (`server/src/portability.ts`): el plan dice, para cada elemento del archivo, si es
  nuevo, si ya existe o si existe pero es distinto, y qué se puede hacer (crear, usar el de aquí, sustituir el de
  aquí, crear una copia, no importar; en los proveedores, elegir uno local). La interfaz lo enseña en un diálogo de
  revisión antes de crear nada. Por defecto se respeta lo local; un subworkflow distinto se importa como copia.
- **Atómica**: toda la importación va en una transacción. Una decisión imposible o un fallo a medias no deja nada
  creado (antes, los agentes creados se quedaban si el workflow fallaba).
- **Avisos de seguridad** al importar: herramientas que actúan fuera de la conversación (`http_request`,
  `file_write`, `run_javascript`), a qué dirección llama cada herramienta HTTP nueva, credenciales por rellenar y
  disparadores que llegan (siempre **en pausa**; los webhooks, con un secreto nuevo).
- **Cabeceras con credenciales cifradas** en las herramientas HTTP: las que por su nombre llevan una credencial se
  guardan cifradas, la API devuelve solo su nombre y al editar la herramienta un valor vacío conserva el guardado.
  Las que una versión anterior guardó en claro se cifran al arrancar.
- **Verificado con Ollama**: ver `TEST_RESULTS.md`, sección 1.1.

### Fase 6 · Interfaz y accesibilidad — HECHA (2026-11-12)

Parte de las auditorías de accesibilidad (WCAG 2.1 AA) y de UX. Resuelto:

- **Constructor operable sin ratón** (los dos críticos de accesibilidad): Intro o Espacio sobre un nodo abre sus
  propiedades y lleva allí el foco, y Escape lo devuelve al nodo; el bloque **«Conexiones»** del inspector une y
  separa nodos sin arrastrar (solo ofrece destinos que no crean un ciclo, y una opción por rama en las
  condiciones); la lista **«Nodos»** de los ajustes llega a cualquier nodo sin pasar por el lienzo. Nodos y
  conexiones tienen nombre en español para los lectores de pantalla, el foco se ve y cada acción se anuncia.
- **Deshacer y rehacer** (botones, Ctrl+Z, Ctrl+Mayús+Z): la escritura seguida y el arrastre se agrupan en un
  paso. **Copiar, pegar y duplicar** (Ctrl+C, Ctrl+V, Ctrl+D), **Ordenar** (disposición automática por capas),
  **Ctrl+S** y Supr. Lógica en `web/src/lib/builder.ts`.
- **Sin pérdida de trabajo**: el navegador pide confirmación al cerrar o recargar con cambios sin guardar; un
  diálogo en el que se ha escrito algo ya no se cierra al pulsar fuera.
- **Diálogos**: atrapan el foco, dejan inerte lo de detrás (también con dos apilados), Escape cierra solo el de
  arriba y, en las confirmaciones destructivas, el foco empieza en «Cancelar».
- **Avisos**: los de error no desaparecen solos y se anuncian como alerta; los demás se detienen con el puntero
  o el foco encima; cinco como máximo y sin duplicados.
- **Navegación**: enlace «Saltar al contenido»; al cambiar de página el foco pasa al contenido, la página se
  anuncia y el desplazamiento vuelve arriba (antes se conservaba el de la página anterior).
- **Formularios**: cada campo queda enlazado con su pista y su error (`aria-describedby`, automático en toda la
  aplicación) y, al enviar con errores, el foco va al primer campo no válido.
- **Contraste**: el texto atenuado y los bordes de campos e interruptores alcanzan AA en los dos temas; los tonos
  de acento, éxito y aviso del tema claro, 4,5:1 sobre su fondo suave; los enlaces dentro de un texto van
  subrayados; los pasos omitidos y las herramientas apagadas ya no se atenúan con opacidad.
- **Monitor de ejecuciones**: los cambios de estado de la ejecución y de cada paso se anuncian; una ejecución
  fallida se abre en el paso que falló.
- **Estado real de la conexión**: si el servidor deja de responder aparece una franja fija «Sin conexión con el
  servidor», la barra lateral lo dice, se reintenta cada 3 s y, al volver, se recargan los datos y la ejecución
  abierta. Antes la interfaz seguía mostrando «disponible».
- **Primera sesión guiada**: tarjeta «Primeros pasos» en el Panel con tres pasos que se marcan solos (conectar un
  modelo, probar un agente, ejecutar un workflow). Si Ollama no responde explica qué es, enlaza la descarga, da el
  comando `ollama pull` con el modelo configurado y ofrece la alternativa de una API compatible con OpenAI.
- **Historial**: los filtros (estado, tipo y búsqueda) viven en la URL y sobreviven a abrir una ejecución y
  volver, a recargar y a compartir el enlace.
- **Eliminar un agente** avisa de qué workflows dejarán de poder ejecutarse, con el mismo texto en la lista y en
  la ficha.
- **Datos de ejemplo**: el agente «Redactor» ya no fuerza un «informe ejecutivo»; el formato lo pide la tarea del
  nodo. Solo afecta a instalaciones nuevas: una base de datos ya sembrada conserva el agente anterior.
- Otros: `h1` en el constructor y en «No encontrado»; interruptores y botón de cerrar aviso de 24 px; en pantallas
  estrechas (o con zoom al 200 %) siguen visibles el selector de tema y el estado del servidor.

Defectos encontrados al verificar y corregidos:

21. La selección automática del paso fallido se arrastraba a la ejecución del **reintento** (el monitor reutiliza
    el componente): el reintento se abría mostrando solo la actividad de un paso. Lo destapó `runs.spec.ts`.
22. Los disparadores, proveedores, agentes y workflows creados en el mismo milisegundo se listaban en **orden
    aleatorio** (el desempate era el id, que es aleatorio): ahora es el orden de inserción. Lo destapó un fallo
    intermitente de `portability.test.ts`.

### Fase 7 · Inglés además de español — HECHA (2026-11-12)

- **Toda la interfaz en español e inglés** con `vue-i18n` 11: unas 1 330 claves en 32 ámbitos
  (`web/src/i18n/es/<ámbito>.ts` y `en/<ámbito>.ts`, uno por pantalla o componente; se cargan solos). Los textos
  con componentes dentro (términos del glosario, enlaces, teclas) usan `<i18n-t>`, así que la frase se puede
  reordenar en inglés.
- **Selector de idioma** en la barra lateral (ES / EN). Cambia sin recargar, se recuerda en el navegador y, si no
  se ha elegido, se toma el del navegador (español si pide español; inglés en cualquier otro caso). Actualiza
  `<html lang>`, el título de la pestaña y los anuncios para lectores de pantalla.
- **Formatos por idioma**: números (1.234,5 / 1,234.5), duraciones (7,0 s / 7.0 s), fechas, horas y tiempos
  relativos («hace 3 horas» / «3 hours ago») en `web/src/lib/format.ts`.
- **Glosario en inglés**: las 55 definiciones, en la página y en los tooltips.
- **Validación de workflows traducible**: cada problema lleva ahora un código y sus parámetros
  (`shared/validation-messages.ts`, 50 códigos); el servidor y la interfaz en español usan el mismo texto que
  antes y la interfaz en inglés lo traduce (`web/src/lib/validation-en.ts`, con los mismos códigos por tipo).
- **Errores de la API con código estable** (`code` en todas las respuestas de error: `not_found`, `validation`,
  `rate_limited`, `auth_required`, `payload_too_large`, `provider_error`, `tool_error`, `config_error`,
  `internal`). En inglés, los genéricos se muestran traducidos; el resto conserva el texto del servidor.
  (Ampliado en la pasada de cierre de la 1.0: todos los textos del servidor llevan código y parámetros; ver
  «Idiomas» en «Pendiente y limitaciones».)
- **Salvaguardas**: un test comprueba que inglés y español tienen las mismas claves, los mismos huecos y las
  mismas formas de plural, y que toda clave escrita en el código existe; la suite e2e recorre todas las pantallas
  en los dos idiomas buscando claves sin traducir.

Defecto encontrado al verificar y corregido:

23. Los errores 404 no concordaban en género («Ejecución no encontrado», «Herramienta no encontrado»).
24. **Un 429 se tomaba por «servidor sin conexión»** (defecto introducido en la fase 6): al superar el límite de
    peticiones, la franja roja decía que el servidor había caído. Ahora cualquier respuesta cuenta como servidor
    vivo. Lo destapó la suite e2e completa, que con la spec de idiomas pasó a superar las 1 200 peticiones por
    minuto; la suite arranca ahora su servidor con un límite más alto (el límite tiene sus tests en el servidor).
25. **La descarga de un archivo exportado se cancelaba a veces** con el equipo cargado: la dirección temporal se
    liberaba al segundo. Ahora se libera al minuto.

### Fase 8 · Calidad y pruebas — HECHA (2026-11-12)

- **ESLint y Prettier** (`npm run lint`, `npm run format`, `npm run format:check`): configuración plana con
  TypeScript y Vue; todo el código formateado. El código tenía solo 9 errores de lint reales, corregidos.
  `npm run check` encadena lint, formato, tipos y tests.
- **Cobertura** (`npm run test:coverage`, proveedor v8) con umbrales que hacen fallar la batería si baja:

  | Paquete | Sentencias | Ramas | Funciones | Líneas |
  |---|---|---|---|---|
  | Servidor y `shared/` | 93,9 % | 86,4 % | 94,9 % | 96,7 % |
  | Frontend | 39,8 % | 42,2 % | 41,5 % | 41,9 % |

  La del frontend cuenta todos los archivos, también los que ningún test de Vitest importa: las vistas grandes
  (constructor, Ajustes, Herramientas, monitor, Panel) se prueban en la suite e2e, que aquí no suma.
- **Tests nuevos**: 510 de servidor (eran 379) y 288 de frontend (eran 79).
  - Componentes: `TriggersModal`, `ImportModal`, `ProviderModal`, `McpServersPanel` (contra un servidor MCP real
    por stdio y por HTTP) y `ToolEditorModal`, todos contra la API real.
  - `markdown.test.ts`: saneado de la salida de los modelos con una batería de entradas hostiles.
  - `api.test.ts`, `useRunStream.test.ts` (con un `EventSource` real), `runs.test.ts`, `ui.test.ts`.
  - `server/test/gaps.test.ts` (131 tests): migraciones reales desde v1, v2 y v3 con datos en todas las tablas y
    fallos a medias; cifrado de secretos; rutas de archivos frente a salidas del espacio de trabajo; `web_fetch`;
    canales SSE por HTTP real; ramas de error del motor y de la delegación; el `code` de cada tipo de error; y un
    caso para **cada uno de los 50 códigos** de validación de workflows.
- **Tres navegadores**: la suite e2e corre en Chromium, Firefox y WebKit (`npm run test:e2e:all`);
  `npm run test:e2e` sigue lanzando solo Chromium.
- **Integración continua**: `.github/workflows/ci.yml` (lint, formato, tipos, auditoría, tests con cobertura en
  Ubuntu y Windows, y e2e en matriz de tres navegadores). **No se ha ejecutado nunca**: el repositorio no está
  publicado.

Defectos encontrados por los tests nuevos y por los otros motores, y corregidos:

26. **El monitor de una ejecución se quedaba «En curso» para siempre** si el flujo en vivo se cortaba y la
    ejecución terminaba mientras tanto (defecto conocido de la auditoría). Ahora, al fallar el flujo, se consulta
    el estado.
27. **Una segunda confirmación dejaba colgada a la primera**: quien esperaba la respuesta del primer diálogo no
    la recibía nunca.
28. **El error de un campo no se borraba al corregirlo** en el diálogo de disparadores (cron o zona horaria).
29. **El título de una página leída con `web_fetch` salía con entidades HTML sin decodificar**, y el texto las
    decodificaba dos veces.
30. **Una ruta inexistente de la API respondía sin `code`**, a diferencia del resto de errores.
31. **En Safari no se podía arrastrar un bloque de la paleta al lienzo**: WebKit descarta los tipos de dato no
    estándar al arrastrar. Ahora viaja también como texto.
32. **En Safari el foco no volvía al botón al cerrar un diálogo**: allí pulsar un botón con el ratón no lo enfoca.
33. Un test de proveedores dependía del orden en que llegaban dos peticiones de fondo (fallaba en Firefox).

### Fase 9 · Operación y documentación — HECHA (2026-11-12)

- **Métricas** (`GET /api/metrics`, formato de texto de Prometheus): ejecuciones por estado, en marcha y en cola;
  llamadas a modelos y a herramientas y tokens (acumulados); inventario; memoria del proceso, tamaño de la base de
  datos, estado del planificador y respuestas HTTP por clase. Exige la clave de acceso si la hay.
- **Especificación OpenAPI 3.1** (`GET /api/openapi.json`, `server/src/openapi.ts`): las 89 operaciones de entonces (90 tras la fase 10) de la
  API, con los cuerpos de entrada derivados de los esquemas de validación reales. Un test compara la
  especificación con **las rutas realmente registradas** (ninguna sin documentar, ninguna documentada que no
  exista) y contrasta 24 respuestas reales con su esquema. La referencia legible es `docs/api.md`, generada con
  `npm run docs:api`; otro test falla si se queda atrás.
- **Versión única**: sale del `package.json` de la raíz (`server/src/version.ts`); es la que anuncian las sondas,
  el Panel, las métricas y la especificación. Pasa a 0.5.0.
- **Códigos de error que faltaban**: una clave incorrecta al entrar (`invalid_token`) ya no se confunde con una
  clave ausente (`auth_required`); los 403 por `Host` ajeno o por petición de otra web llevan `forbidden_host` y
  `cross_site`; `api_key_required` iba dentro de `details` y ahora es el `code`.
- **`Dockerfile`** en tres etapas (compilación, dependencias de ejecución, imagen final sin privilegios, con
  volumen de datos, sonda de salud y apagado ordenado). **No se ha construido ni ejecutado.**
- **Documentación** (`docs/`): guía de usuario, solución de problemas (con los mensajes reales del servidor),
  arquitectura (piezas, recorrido de una ejecución y «dónde tocar para…») y referencia de la API. En la raíz,
  `CHANGELOG.md`, `SECURITY.md` (modelo de amenazas y lo que no cubre) y `CONTRIBUTING.md` (baterías, reglas de
  las pruebas y convenciones).
- **Verificado con Ollama real en el navegador** (2026-11-12): una ejecución del agente «Calculista» movió las
  métricas (de 55 a 57 llamadas al modelo, de 12 a 13 a herramientas, de 16 a 17 completadas); versión 0.5.0 en
  la sonda, en `agentforge_info` y en la especificación.

### Fase 10 · Segunda auditoría e iteración — HECHA (2026-11-12)

Cuatro auditorías de solo lectura sobre el código de la fase 9 (informes `auditoria2-*.md`, fuera del
repositorio): **0 críticos, 5 altos y unos 31 medios**. Corregido, cada cosa con su test:

- **Altos (los cinco)**: recuentos sobre todo el historial con cada evento en vivo (nueva ruta ligera
  `GET /api/onboarding`, canal propio para las aprobaciones, recarga solo al cambiar un estado); un término del
  glosario dentro de un diálogo sacaba de la página; «Guardar» del editor de agentes no llevaba el foco al error;
  el `Dockerfile` no habría construido (`web/tsconfig.build.json` deja los tests fuera de la compilación); y el
  servidor dependía de `db.isOpen`, que no existe en Node 22.13 y 22.14.
- **Seguridad**: la credencial de una herramienta HTTP o de un servidor MCP ya no se conserva al cambiar su
  dirección (400 `credential_required`; al importar con «sustituir», la cabecera queda sin valor y el plan enseña
  el host de aquí y el del archivo); los avisos de importación cubren herramientas MCP, herramientas locales con
  credenciales, `delegate_task` y los nodos de herramienta con argumentos fijos; las llamadas a proveedores no
  siguen redirecciones.
- **Motor y datos**: las subejecuciones no ocupan huecos de ejecución; restaurar una copia no se traga los
  errores de escritura ni se cuelga; el comentario de una aprobación se conserva al reintentar y al reanudar; el
  error al superar la profundidad de subworkflows dice lo que pasa.
- **Interfaz**: Esc y «×» piden confirmación si se ha escrito algo; cerrar con el secreto de un webhook a la
  vista, también; «Reintentar» en los errores de carga y recuperación sola al volver la conexión; botón «Ajustes
  del workflow» y Esc para deseleccionar en el constructor; conexiones del lienzo con contraste suficiente;
  nodos y ramas en el idioma activo; aprobaciones pendientes anunciadas y con aviso; pestañas del monitor con
  panel y flechas; filtros del historial sincronizados con la dirección; `localStorage` protegido; ejecuciones
  resincronizadas tras reiniciar el servidor; definición del glosario recorrible con el puntero.
- **Operación**: `AGENTFORGE_TRUST_PROXY` (cliente y protocolo reales detrás de un proxy); mensajes de arranque
  que dicen lo que pasa (carpeta de datos sin permisos, otra instancia); nombres admitidos con puerto rechazados
  al arrancar; sonda de salud del contenedor con el puerto configurado; trabajo de CI que construye la imagen.
- **Documentación**: secciones «Detrás de un proxy inverso» y «Actualizar a una versión nueva»; mensajes y
  nombres de botones corregidos en las guías; cifras antiguas eliminadas.
- **Pruebas**: `server/test/audit2.test.ts` (15) y `ops.test.ts` (11); tests de componente nuevos del
  constructor, del monitor, del historial, del aviso de aprobaciones y de los diálogos apilados; la prueba e2e de
  inglés detecta ahora texto de interfaz en español, y la de copiar y pegar comprueba la tarea y la conexión.

Defectos encontrados al verificar la propia fase 10:

34. La sonda de salud del contenedor terminaba con un fallo de aserción de Node en Windows al llamar a
    `process.exit` dentro de `fetch`: ahora fija el código de salida.
35. Dos pruebas e2e recién endurecidas fallaban por sí mismas (un nombre de agente en español creado por otra
    prueba; la tecla de selección múltiple que WebKit espera como Cmd) y un test de componente comprobaba el DOM
    antes de que el diálogo recibiera la respuesta.

## Pendiente y limitaciones

- **Lo que deja abierto la segunda auditoría (fase 10)** — medios sin resolver o resueltos en parte:
  - ~~El monitor no pagina los eventos y reconstruye la actividad entera con cada evento.~~ Resuelto en la pasada
    de cierre de la 1.0: el servidor entrega el estado de los pasos ya calculado y los eventos por páginas, y el
    registro de actividad es incremental y pinta las 100 entradas más recientes. Lo que queda: con un paso
    elegido, «Cargar anteriores» sigue trayendo páginas de toda la ejecución (no solo de ese paso), y la lista de
    pasos y el grafo sí se pintan enteros (un workflow de cientos de nodos sigue siendo pesado).
  - ~~El primer guardado de un workflow o agente nuevo vuelve a montar la pantalla.~~ Resuelto en la 1.0: la
    pantalla adopta la dirección del elemento creado sin volver a montarse (se conservan deshacer, selección y
    foco). La posición del lienzo solo está comprobada en jsdom (mismo elemento y misma transformación).
  - Archivos que han crecido mucho (constructor, almacén, rutas, motor) y lógica duplicada en el motor.
  - `GET /api/runs` sigue calculando el total exacto y no hay índice por tipo de ejecución.
  - Las confirmaciones destructivas leen su mensaje (`aria-describedby`) pero no usan `role="alertdialog"`.
  - Cambiar solo los argumentos de un servidor MCP local conserva sus variables de entorno secretas.
  - El aviso «lleva credenciales que no viajan» sale también al sustituir una herramienta en el mismo origen.
  - Sin test: la rama de excepción no capturada del arranque y deshacer con cambios simultáneos.
  - Casi todos los hallazgos bajos (unos 49) de los cuatro informes.
- **Intermitencia bajo carga**: en dos baterías completas se canceló una descarga en la suite e2e mientras otras
  tareas cargaban el equipo; repetida, pasó, y la última batería completa pasó entera. Sin causa conocida.

- **Operación y documentación (fase 9)**:
  - ~~Sin licencia.~~ Licencia MIT desde la 1.0.0 (`LICENSE`).
  - **El `Dockerfile` no se ha construido** y `SECURITY.md` no tiene un contacto real (el proyecto no está
    publicado).
  - Las métricas no incluyen histogramas de duración ni cifras por agente o por workflow; el recuento de
    respuestas HTTP se pierde al reiniciar.
  - En la especificación, los esquemas de las respuestas están escritos a mano a partir de los tipos; solo los
    cuerpos de entrada salen de los esquemas de validación. Los tests de contrato cubren 24 respuestas, no todas.
  - «Probar» un proveedor exige un nombre aunque no haga falta para probar la dirección. (`GET
    /api/runs/:id/stream` ya valida `?after=` y `Last-Event-ID` como `/events`: un valor no válido es un 400.)
  - La documentación está solo en español.

- **Pruebas (fase 8)**:
  - *Con poco test de componente*: el Panel, Ajustes y Herramientas no tienen; el constructor, el monitor y el
    historial tienen desde la fase 10 tests de lo corregido entonces, no de todo. Lo demás lo cubre la suite e2e.
  - *La integración continua no se ha ejecutado nunca.* El archivo refleja los comandos que sí se ejecutan en
    local; puede necesitar ajustes al estrenarlo (por ejemplo, las dependencias de sistema de WebKit en Linux).
  - *WebKit se ha probado con la compilación de Playwright para Windows*, no con Safari en macOS ni en iOS.
    En WebKit el tabulador no se detiene en los enlaces (es un ajuste de Safari): el enlace «Saltar al contenido»
    solo se alcanza con Opción+Tab o activando ese ajuste.
  - *Siguen sin test*: el latido de los canales en vivo, los enlaces simbólicos dentro del espacio de trabajo y
    copiar al portapapeles (no existe en el entorno de los tests de componentes).
  - El nombre repetido de una herramienta HTTP se avisa en el mensaje general del diálogo, no junto al campo.

- **Idiomas (fase 7)**:
  - ~~Siguen en español en la interfaz en inglés los textos que escribe el servidor.~~ Resuelto en su mayor parte
    en la pasada de cierre de la 1.0. El servidor acompaña ahora cada texto que llega a la pantalla de su código
    y sus parámetros, y la interfaz en inglés lo traduce; el texto en español sigue en la respuesta (y en la base
    de datos) como respaldo:
    - Tabla única de textos del servidor, `shared/server-messages.ts` (260 códigos), con su traducción en
      `web/src/lib/server-messages-en.ts`; el tipo y un test exigen los mismos códigos y los mismos parámetros en
      los dos idiomas, otro test del servidor comprueba que no queda ningún `HttpError`, `ConfigError`,
      `LimitError`, `LlmError` ni `CronError` construido con un texto suelto y que todos los códigos se usan.
    - *Validación de formularios y de parámetros*: cada problema de `issues` lleva `code` y `params` además de
      `path` y `message`, también los que zod detecta sin mensaje propio del esquema (longitud, rango, tipo,
      opción), que antes salían en inglés incluso con la interfaz en español. La interfaz los muestra junto al
      campo en el idioma activo.
    - *Errores de la API*: toda respuesta de error trae `i18n: { code, params }`. `code` sigue siendo la clase
      de error (`not_found`, `validation`…), sin cambios para quien ya lo usaba.
    - *Motivo de fallo de una ejecución, de un paso y de un elemento de «para cada»*: se guarda la referencia
      junto al texto (columnas `error_i18n`, esquema v7; lo anterior queda en `NULL` y se muestra con su texto) y
      viaja en la API (`errorI18n`) y en los eventos (`step.finished`, `step.retry`, `step.skipped`,
      `foreach.item`, `tool.result`, `run.finished`). La causa va anidada (`El nodo «X» falló: <causa>`) y se
      traduce también; lo que viene de fuera (respuesta de un proveedor, de una API o de un servidor MCP, el
      error de un programa) es un parámetro y se muestra tal cual dentro de la frase traducida. Lo mismo para el
      motivo por el que un disparador no se lanzó (`lastErrorI18n`), el resultado de probar un proveedor o una
      herramienta, el estado del contenedor y la pérdida de conexión de un servidor MCP.
    - *Herramientas integradas*: título, categoría, descripción y descripción de cada parámetro se rotulan en la
      interfaz por nombre de herramienta (`web/src/i18n/{es,en}/builtinTools.ts`; un test comprueba que el español
      coincide palabra por palabra con lo que entrega el servidor). La descripción que lee el modelo no cambia.
    - *Importación*: los avisos del plan y del resultado y las notas de cada elemento llevan su referencia en
      `warningsI18n` y `notesI18n` (misma posición que el texto).
  - *Lo que sigue en español con la interfaz en inglés*: los datos de ejemplo (agentes y workflows con que nace
    una instalación; se crean una vez y pasan a ser datos del usuario); lo que el motor escribe DENTRO de un
    resultado (el resumen de un «para cada»: «⚠ No se pudo completar…», «N de M elementos no se pudieron
    completar», su progreso en vivo «3 de 5 elementos completados», y la marca «[truncado: N caracteres más]»);
    los errores que solo se devuelven al modelo dentro del bucle de un agente (herramienta no disponible, llamada
    repetida, argumentos que no son JSON, delegación), que se ven en el registro de actividad como resultado de
    la herramienta; el detalle de un error cuando lo escribe un programa de fuera o el propio entorno aislado
    («La red está desactivada en el entorno aislado»); las comillas «» de las listas de nombres dentro de una
    frase traducida; las ejecuciones y los disparadores anteriores a esta versión (sin referencia guardada); la
    página de «interfaz no compilada», `/api/health/ready`, la documentación de la API y los registros del
    servidor. Los textos del registro de actividad se fijan al cargar: al cambiar de idioma con el monitor
    abierto, el detalle de cada entrada no cambia hasta recargar (el motivo de la ejecución y del paso, sí).
  - La traducción al inglés no la ha revisado una persona nativa.
  - Las etiquetas por defecto de un nodo nuevo se crean en el idioma activo y pasan a ser datos del workflow (no
    cambian al cambiar de idioma). En el monitor de una ejecución, las etiquetas «sí»/«no» de las ramas se fijan
    al cargar y no cambian hasta recargar.
  - La dirección del glosario sigue siendo `/glosario` y los filtros del historial usan `estado`, `tipo` y `q`.
  - La documentación (README, guías) está solo en español. Solo hay dos idiomas; añadir otro es crear su carpeta
    de mensajes, su tabla de validación y su glosario.

- **De la fase 6 (auditorías de accesibilidad y UX), sin hacer**:
  - *Historial*: comparar dos ejecuciones, ordenar por columnas; cada evento en vivo vuelve a pedir la página
    entera. (Hechos en la pasada de cierre de la 1.0: filtros por workflow, agente e intervalo de fechas, y «En
    curso» incluye las que están en cola o en espera. El filtro por agente solo ve sus ejecuciones directas, no
    las de los workflows que lo usan.)
  - *Constructor*: menú contextual, botón «×» sobre una conexión, insertar un nodo sobre una conexión, crear un
    agente sin salir del lienzo; por debajo de 1100 px el inspector queda bajo el lienzo; un workflow nuevo nace
    «Sin guardar»; «Exportar» guarda antes sin preguntar.
  - *Editor de agentes*: hay que guardar para probar (no hay «guardar y ejecutar» ni cabecera fija).
  - *Sistema de diseño*: sin tokens de tipografía ni de espaciado; colores de nodo y de avatar fuera del sistema
    (las iniciales de algunos avatares no alcanzan contraste en tema claro); terminología no unificada
    («Ejecutar/Probar», «Eliminar/Quitar/Vaciar»); casi sin transiciones y esqueletos genéricos.
  - *Accesibilidad media*: el gráfico del Panel no tiene tabla de datos alternativa y distingue los tramos solo
    por color; la definición emergente del glosario no se puede recorrer con el puntero; los grupos de opciones y
    las pestañas no responden a las flechas; tras borrar un elemento el foco vuelve al principio; los esqueletos
    de carga no se anuncian; un término del glosario dentro de un formulario navega fuera de la página.
  - *Accesibilidad baja*: títulos de pestaña sin el nombre del elemento, campos obligatorios sin marca, tablas
    sin `caption`, datos que solo están en `title`, desplazamientos suaves que no respetan «reducir movimiento».
  - *Otros*: sin búsqueda global ni paleta de comandos; cancelar desde una lista no pide confirmación; «Vaciar
    historial» sigue en la cabecera; el Panel con datos mantiene las cuatro cifras sin tendencia.
- **Con el servidor caído, el cronómetro de una ejecución abierta sigue corriendo** (la franja lo avisa y al
  reconectar se recarga, pero el tiempo mostrado mientras tanto no es fiable).
- **La guía de primeros pasos no bloquea «Ejecutar»** cuando el proveedor no responde: la ejecución falla con el
  error del proveedor.
- **Accesibilidad no comprobada con un lector de pantalla real** (NVDA, VoiceOver): están comprobados en el
  navegador los roles, nombres, foco y regiones vivas, no lo que se oye.

- **Sin multiusuario.** Una única clave de acceso opcional (obligatoria fuera de este equipo); no hay cuentas ni permisos.
- **El apagado ordenado por señal no se ha podido ejercitar en Windows** (un proceso no puede enviar `SIGINT` a
  otro). Se ha comprobado de punta a punta por el mensaje IPC `shutdown`, que recorre el mismo código.
- **El aislamiento en contenedor no se ha ejecutado**: Docker Desktop estaba apagado en esta máquina. Están
  probados los argumentos, la detección y el rechazo cuando no hay motor; el test que lo ejecuta se omite solo.
- **El corte de red del proceso aislado no es una frontera del sistema operativo**: el proceso inutiliza sus
  propias API de red. Para código no confiable, el contenedor.
- **La política de contenido admite estilos en línea** (`style-src 'unsafe-inline'`): Vue y Vue Flow los necesitan.
- **Los workflows son DAG**: no hay bucles; la iteración sobre listas se hace con el nodo «para cada».
- **Un subworkflow es una ejecución aparte**, no pasos anidados dentro de la misma: su detalle se ve abriendo la
  subejecución. Al reintentar desde el fallo la ejecución madre, el nodo de subworkflow se repite entero.
- **Una aprobación pendiente se vuelve a crear tras un reinicio** (la ejecución se reanuda como una nueva que
  reutiliza los pasos hechos): quien decide ve la misma pregunta, pero es otra petición. No hay permisos: decide
  cualquiera que tenga acceso a la interfaz. Varias aprobaciones en paralelo detienen el reloj de toda la ejecución.
- **La reutilización de elementos de «para cada»** exige que el elemento esté en la misma posición con el mismo
  texto; si la lista cambia entre intentos, se repite.
- **Sin registro único de tipos de nodo**: añadir uno sigue obligando a tocar el motor, la validación compartida,
  el esquema de la API y el inspector.
- **Los disparadores con horario solo corren con el servidor en marcha.** Tras un apagado, un intervalo se lanza
  **una** vez (no las ocasiones perdidas) y una hora fija con más de una hora de retraso se omite; no hay opción
  de «recuperar lo perdido».
- **Cron**: cinco campos, sin segundos ni extensiones (`L`, `W`, `#`). En la hora que se repite al cambiar al
  horario de invierno, las expresiones que se cumplen varias veces por hora se saltan la repetición (una hora sin
  ejecuciones); para «cada N minutos» conviene el disparador de intervalo, que no depende del reloj de pared.
- **Webhooks**: sin protección frente a repeticiones (una petición firmada capturada se puede reenviar), sin lista
  de direcciones permitidas y sin respuesta síncrona con el resultado: devuelven el id de la ejecución. No aplican
  la regla de «sin solapes»: cada llamada es una ejecución, limitada por la cola y por el límite de peticiones.
- **MCP**: solo herramientas (ni recursos, ni plantillas de prompt, ni muestreo); sin OAuth; el transporte SSE
  antiguo no está soportado. Un servidor local se ejecuta con los permisos del servidor de AgentForge, sin
  aislamiento. El resultado no textual (imágenes, audio) se sustituye por una nota. Renombrar un servidor cambia
  el nombre de sus herramientas y los agentes que las usaban hay que volver a asignarlos. Si el servidor está
  caído, sus herramientas se siguen ofreciendo al modelo y la llamada falla con un mensaje.
- **Exportación**: no viajan los servidores MCP (sus herramientas se señalan como inexistentes al importar si
  aquí no están), el historial ni los archivos del espacio de trabajo; para llevarse todo está la copia de
  seguridad. Una herramienta HTTP no se puede importar con otro nombre: si choca con una distinta, se usa la de
  aquí o se sustituye.
- **Qué cabeceras son secretas se decide por su nombre** (Authorization, Cookie, …-Key, …-Token…): una credencial
  en una cabecera con un nombre que no lo parezca se guarda y se exporta en claro, igual que una credencial
  escrita dentro de la URL o del cuerpo de una herramienta.
- **Al importar, «es distinto» compara la definición entera**: no enseña en qué se diferencia.
- **La retención viene desactivada** (0 = sin límite): hasta que se configure, el historial crece.
- **Las estadísticas del panel son acumuladas**: tokens, llamadas, actividad diaria y rankings no bajan al borrar
  ejecuciones. Los recuentos por estado y la tasa de éxito sí reflejan el historial que queda.
- **La búsqueda examina las 2 000 coincidencias más recientes** (la lista avisa cuando hay más) y solo indexa
  los primeros 2 000 caracteres de la entrada y del resultado. Con menos de tres caracteres busca solo en el nombre.
- **El índice de búsqueda ocupa sitio**: con el historial de la prueba de carga la base pasó de 891 a 1 239 MB.
- **Restaurar una copia exige reiniciar el servidor** (no se sustituye la base de datos en caliente). Una copia
  contiene la clave maestra: quien tenga el archivo puede leer las API keys.
- **La primera vez que se abre un historial grande con esta versión el arranque es lento** (23 s con 50 000
  ejecuciones: copia previa, índices nuevos y compactación). Solo ocurre una vez.
- **La retención borra en segundo plano**: con 50 000 ejecuciones tardó 21 s en borrar la mitad, en tandas que
  paran el servidor hasta 0,2 s cada una.
- **El texto del modelo llega con hasta 33 ms de retraso** añadido (los fragmentos se agrupan).
- **Sin tope global de llamadas simultáneas al modelo ni de la cola de ejecuciones**; cada pestaña mantiene su
  propia conexión en vivo (con muchas pestañas el navegador agota sus 6 conexiones por servidor).
- **Tras un apagado, un paso que estaba a medias se repite entero**: su texto parcial se conserva para
  consultarlo, pero el modelo no continúa desde él. La reanudación automática es opcional y viene desactivada.
- **Fijación de DNS**: probada contra un servidor DNS local real (UDP, protocolo de cable). El producto resuelve con
  el sistema operativo; la prueba usa el resolvedor de Node apuntando a ese servidor. No se ha probado contra un
  dominio de rebinding real en Internet.
- **Los proveedores OpenAI reales (de pago) no se han probado**; el adaptador se ha verificado contra el
  endpoint compatible de Ollama y contra un servidor de pruebas que habla el protocolo.
- **El editor de herramientas HTTP no edita esquemas anidados** (`items` de listas, propiedades de objetos): los conserva.
- **Los valores permitidos se escriben separados por comas**, así que un valor no puede contener una coma.
- **Paralelismo real limitado por el proveedor**: Ollama atiende las peticiones a un mismo modelo según
  `OLLAMA_NUM_PARALLEL`; el motor las lanza en paralelo igualmente.
- **La suite e2e usa un modelo simulado**: prueba la interfaz y el protocolo, no la calidad de las respuestas.
- **Las instantáneas no se deduplican**: cada ejecución guarda su copia del workflow y de sus agentes.
- **El texto parcial que se guarda es el de la respuesta en curso**, no el de los elementos de un «para cada»
  ni el de un agente delegado.
- **Glosario**: «primera aparición por sección» se ha aplicado a mano; el test no puede comprobar que no falte
  ningún término por marcar, solo que lo marcado es coherente. Los textos que llegan del servidor (descripciones de
  herramientas, mensajes de error) y los de las opciones de un desplegable no llevan tooltip.

## Próximos pasos sugeridos

Por orden de valor, a juicio de la segunda auditoría y de lo anotado arriba:

Hechos en la pasada de cierre de la 1.0 (2026-11-12): traducir lo que escribe el servidor, paginar los eventos
con actividad incremental, filtrar el historial por workflow, agente y fecha, y el primer guardado sin volver a
montar la pantalla. Lo que queda, por orden de valor:

1. **Decisiones del autor**: la licencia ya es MIT; si se publica, estrenar la integración continua, construir la
   imagen de Docker y poner un contacto real en `SECURITY.md`.
2. **Comprobaciones que piden algo que esta máquina no tiene**: un proveedor de pago con clave real, Docker en
   marcha (aislamiento en contenedor), Safari real y una pasada con un lector de pantalla (NVDA o VoiceOver).
3. **Instalación para quien no programa**: hoy hace falta Node 22.13+, `npm install` y `npm run build`.
4. Dividir los archivos que más han crecido (constructor, almacén, rutas, motor) y unificar en el motor la
   invocación de herramientas y los reintentos, hoy duplicados.
5. Comparar dos ejecuciones; datos de ejemplo en el idioma de la interfaz.
