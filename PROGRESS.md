# AgentForge — Progreso

_Última actualización: 2026-11-11 (hito 5, fases 1 y 2; ver «Hito 5» más abajo)._

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

### 4.5 Capacidades del motor — HECHO

- **Nodo «para cada»**: itera sobre una lista (JSON, viñetas, numerada o un elemento por línea) con concurrencia
  limitada (1-8), reintentos **por elemento**, tope de elementos, `{{item}}`/`{{index}}`/`{{total}}` y salida por
  apartados o JSON. 16 tests del motor (`server/test/foreach.test.ts`), paleta, inspector y validación en el
  constructor, avance en vivo en el monitor y 1 test e2e.
- **Exportar/importar workflows en JSON** desde la lista y desde el constructor. El archivo lleva la definición y
  los agentes que usa (sin proveedor ni claves). Al importar, cada agente se enlaza con uno existente (por id o por
  nombre) o se crea con el proveedor por defecto; se avisa de las herramientas que no existen y el workflow queda
  como borrador con los errores señalados. 5 tests de API y 3 e2e (descarga real del archivo y subida).
- **Ejecución programada sencilla**: cada workflow puede lanzarse cada N minutos/horas/días o a una hora fija cada
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

## Pendiente y limitaciones

- **Sin multiusuario.** Una única clave de acceso opcional (obligatoria fuera de este equipo); no hay cuentas ni permisos.
- **El apagado ordenado por señal no se ha podido ejercitar en Windows** (un proceso no puede enviar `SIGINT` a
  otro). Se ha comprobado de punta a punta por el mensaje IPC `shutdown`, que recorre el mismo código.
- **El aislamiento en contenedor no se ha ejecutado**: Docker Desktop estaba apagado en esta máquina. Están
  probados los argumentos, la detección y el rechazo cuando no hay motor; el test que lo ejecuta se omite solo.
- **El corte de red del proceso aislado no es una frontera del sistema operativo**: el proceso inutiliza sus
  propias API de red. Para código no confiable, el contenedor.
- **Las cabeceras con credenciales de las herramientas HTTP siguen guardándose en claro** (previsto en la fase 5).
- **La política de contenido admite estilos en línea** (`style-src 'unsafe-inline'`): Vue y Vue Flow los necesitan.
- **Los workflows son DAG**: no hay bucles; la iteración sobre listas se hace con el nodo «para cada» (un solo agente por elemento, sin subflujos).
- **«Para cada» ejecuta un solo agente por elemento**: no admite un subflujo de varios nodos ni una herramienta
  como cuerpo. Si falla un elemento falla el nodo entero, y al reintentar desde el fallo se repiten todos.
- **Programación sencilla, no cron**: intervalos o una hora diaria; sin días de la semana ni zonas horarias (usa la
  hora local del servidor). Solo corre con el servidor en marcha; tras un apagado se lanza **una** vez la cita
  vencida, no las perdidas. Una programación por workflow. Sin disparadores externos (webhooks).
- **La importación no trae herramientas HTTP personalizadas ni proveedores**: solo avisa de las que faltan. Los
  agentes se enlazan por nombre, así que dos agentes distintos con el mismo nombre se confunden.
- **Sin MCP**: las herramientas son las integradas y las HTTP personalizadas.
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
- **La reanudación tras un apagado la decide el usuario** (aviso en la interfaz); no hay reanudación automática
  desatendida. Un paso que estaba a medias se repite entero: el texto parcial del modelo no se recupera.
- **Fijación de DNS**: probada contra un servidor DNS local real (UDP, protocolo de cable). El producto resuelve con
  el sistema operativo; la prueba usa el resolvedor de Node apuntando a ese servidor. No se ha probado contra un
  dominio de rebinding real en Internet.
- **Los proveedores OpenAI reales (de pago) no se han probado**; el adaptador se ha verificado contra el
  endpoint compatible de Ollama y contra un servidor de pruebas que habla el protocolo.
- **El editor de herramientas HTTP no edita esquemas anidados** (`items` de listas, propiedades de objetos): los conserva.
- **Los valores permitidos se escriben separados por comas**, así que un valor no puede contener una coma.
- **Paralelismo real limitado por el proveedor**: Ollama atiende las peticiones a un mismo modelo según
  `OLLAMA_NUM_PARALLEL`; el motor las lanza en paralelo igualmente.
- **La suite e2e solo se ejecuta en Chromium** y con el modelo simulado; no hay CI configurado (se lanza a mano).
- **Las instantáneas no se deduplican**: cada ejecución guarda su copia del workflow y de sus agentes.
- **El texto parcial de un paso cancelado no se persiste**: se ve en la sesión en la que se canceló, pero no al
  volver a abrir la ejecución más tarde.
- **Glosario**: «primera aparición por sección» se ha aplicado a mano; el test no puede comprobar que no falte
  ningún término por marcar, solo que lo marcado es coherente. Los textos que llegan del servidor (descripciones de
  herramientas, mensajes de error) y los de las opciones de un desplegable no llevan tooltip.

## Próximos pasos sugeridos

1. Subworkflows y cuerpo de varios nodos en «para cada».
2. Cliente MCP como tercera fuente de herramientas.
3. Programación con expresiones cron y disparadores externos (webhooks).
4. Ejecutar la suite e2e en CI y en Firefox/WebKit.
