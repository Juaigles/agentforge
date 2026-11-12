# Informe final del hito 5

Fecha: 2026-11-12. Estado: las diez fases están confirmadas en commits locales. Nada se ha publicado ni desplegado.

Este informe dice qué se ha hecho, qué se ha comprobado y cómo, y —sobre todo— qué sigue débil o sin verificar.
El detalle de cada fase está en [PROGRESS.md](../PROGRESS.md) y las evidencias en
[TEST_RESULTS.md](../TEST_RESULTS.md).

## Resultado

| Batería | Resultado (2026-11-12, árbol final) |
|---|---|
| Lint y formato | ESLint sin errores; todo el código con el estilo de Prettier |
| Tipos | Sin errores (servidor, frontend y suite e2e) |
| Servidor | 589 tests en verde y 1 omitido (22 archivos). Cobertura: 94,3 % de sentencias, 87,0 % de ramas |
| Frontend | 330 tests en verde (31 archivos). Cobertura: 55,5 % de sentencias, 53,3 % de ramas |
| End-to-end | 213 en verde: 71 en Chromium, 71 en Firefox y 71 en WebKit |
| Dependencias | `npm audit`: 0 vulnerabilidades |

Punto de partida del hito (commit `8bef427`): 203 tests de servidor, 40 de frontend y 43 e2e solo en Chromium.

| Fase | Commit | Qué |
|---|---|---|
| 1 | `5080f10` | Fiabilidad del ciclo de vida y seguridad del servidor |
| 2 | `711a92f` | Datos y rendimiento, copias de seguridad, prueba de carga |
| 3 | `9adbff3` | Subworkflows, «para cada» ampliado, aprobación humana, reanudación automática |
| 4 | `23acc52` | Disparadores (cron, zona horaria, webhooks) y cliente MCP |
| 5 | `1477399` | Portabilidad: exportación completa e importación con revisión y atómica |
| 6 | `29f53c3` | Interfaz y accesibilidad |
| 7 | `26c6b0f` | Inglés además de español |
| 8 | `6b13f54` | Calidad y pruebas: lint, cobertura, tests que faltaban, tres navegadores, CI |
| 9 | `edf5366` | Operación y documentación: métricas, OpenAPI, versión única, Dockerfile, guías |
| 10 | (este commit) | Segunda auditoría y corrección de sus hallazgos |

## La segunda auditoría

Cuatro auditorías de solo lectura sobre el código de la fase 9 (seguridad; interfaz, accesibilidad e idiomas;
código, motor y pruebas; documentación y operación). Encontraron **0 hallazgos críticos, 5 altos y unos 31 medios**.

Los **cinco altos están corregidos**, cada uno con su test:

1. Cada evento en vivo lanzaba recuentos sobre todo el historial (hasta 0,2 s de servidor bloqueado con 50 000
   ejecuciones). Ahora la guía de primeros pasos usa una consulta de existencia (`GET /api/onboarding`) y deja de
   preguntar cuando está completa u oculta; el aviso de aprobaciones usa su propio canal; y el historial y el Panel
   solo recargan cuando cambia el estado de una ejecución.
2. Pulsar un término del glosario dentro de un diálogo sacaba de la página y destruía lo escrito.
3. «Guardar» en el editor de agentes no llevaba el foco al campo con error ni lo anunciaba.
4. El `Dockerfile` no habría construido (la compilación de la interfaz necesitaba el código del servidor).
5. La documentación prometía Node 22.13, pero el servidor usaba una propiedad que existe desde Node 22.15 (sin
   error visible: la base no se cerraba y la retención se quedaba a medias).

De los **medios, están corregidos**: la credencial de una herramienta HTTP o de un servidor MCP que se conservaba
al cambiar su dirección (también al importar un archivo ajeno con «sustituir»); los avisos de importación, que no
cubrían las herramientas MCP ni las que llevan credenciales; las subejecuciones que ocupaban huecos de ejecución;
la restauración de una copia, que se tragaba los errores de escritura; el comentario de una aprobación, que se
perdía al reintentar; los filtros del historial que se desincronizaban de la dirección; el arranque en blanco con
el almacenamiento del navegador bloqueado; las ejecuciones que seguían «en curso» tras reiniciar el servidor; las
aprobaciones pendientes que no se anunciaban; Esc y «×», que descartaban lo escrito sin preguntar; el secreto de
un webhook, que se perdía al cerrar sin copiarlo; los errores de carga sin «Reintentar»; el contraste de las
conexiones del lienzo; los ajustes del workflow inalcanzables con teclado; los nodos «Entrada» y «Salida» en la
interfaz inglesa; el comportamiento detrás de un proxy (límite de tasa común y cookie sin `Secure`); los mensajes
de error del arranque; y las cifras y nombres desfasados de la documentación.

## Lo que sigue débil

**El objetivo de «ningún hallazgo medio» no se ha alcanzado.** No queda ningún crítico ni alto conocido; quedan
estos medios, sin resolver o resueltos solo en parte:

- **El monitor de una ejecución no escala con ejecuciones muy largas**: los eventos no se paginan y la lista de
  actividad se reconstruye entera con cada evento. Un «para cada» de cientos de elementos lo hará lento. Solo se
  ha quitado el trabajo inútil cuando la ejecución ya ha terminado.
- **El primer guardado de un workflow o de un agente nuevo vuelve a montar la pantalla**: se pierden el historial
  de deshacer, la selección y el foco.
- **Deuda de estructura**: el constructor (más de 1 800 líneas), el almacén, las rutas y el motor han crecido
  mucho, y en el motor la invocación de herramientas y los reintentos están duplicados. No añadir un registro
  único de tipos de nodo sigue obligando a tocar seis sitios para cada tipo nuevo.
- **El recuento del historial sigue siendo exacto** (`COUNT(*)`) y no hay índice por tipo de ejecución: con
  historiales muy grandes, filtrar por tipo es lento.
- **Las confirmaciones destructivas** leen ya su mensaje a un lector de pantalla, pero no usan el rol
  `alertdialog` (cambiarlo obligaba a reescribir unas sesenta pruebas).
- **Cambiar solo los argumentos de un servidor MCP local** (por ejemplo, a otro programa lanzado con `npx`)
  conserva sus variables de entorno secretas.
- **En la interfaz en inglés sigue en español lo que escribe el servidor**: el detalle de los errores de
  validación, los motivos de fallo de una ejecución y los títulos y descripciones de las herramientas integradas.
- **Pendientes de la primera auditoría que siguen abiertos**: el gráfico del Panel distingue los tramos solo por
  color y no tiene tabla alternativa; tras borrar un elemento el foco vuelve al principio; por debajo de 1 100 px
  el inspector del constructor queda bajo el lienzo; el filtro «En curso» no incluye las que están en cola; no
  hay «guardar y probar» en el editor de agentes; no se pueden comparar ejecuciones ni filtrar por workflow,
  agente o fecha; no hay tokens de tipografía ni de espaciado.
- **Los hallazgos bajos de la segunda auditoría** (unos 49) están casi todos sin tocar. Están en los cuatro
  informes, con archivo y línea.
- **Sin licencia.** Elegirla es decisión del autor.

## Lo que no se ha verificado

- **Proveedores de pago reales** (OpenAI, OpenRouter, Groq…): no se han usado servicios de pago. El adaptador
  compatible con OpenAI está probado contra el extremo `/v1` de Ollama y contra un servidor local que habla el
  protocolo.
- **La imagen de Docker**: el motor de Docker ha estado apagado todo el hito. La imagen no se ha construido. Lo
  comprobado es una reproducción de sus etapas fuera de Docker y en Windows, no en Alpine: con la misma selección
  de archivos, la interfaz compila sin la carpeta del servidor; con solo las dependencias de producción (83
  paquetes) el servidor arranca, exige la clave, sirve la interfaz y responde a la sonda. Tampoco se ha ejecutado
  código de un agente dentro de un contenedor (el test correspondiente es el único omitido).
- **La integración continua**: `.github/workflows/ci.yml` no se ha ejecutado nunca.
- **Otros sistemas y versiones**: todo se ha ejecutado en Windows 11 con Node 24.19. Ni Linux, ni macOS, ni
  Node 22.
- **Safari real**: WebKit se ha probado con la compilación de Playwright para Windows.
- **Un lector de pantalla real**: los roles, nombres, foco y anuncios están comprobados en el DOM, no escuchados.
- **El inglés** no lo ha revisado una persona nativa.
- **Un proxy inverso real**: las cabeceras `X-Forwarded-*` se han probado con peticiones inyectadas.
- **Con Ollama real** se han comprobado los flujos principales de cada fase (agentes con herramientas, workflows,
  disparadores, MCP, importación, métricas, idiomas), pero no la aprobación a través de un reinicio, ni «para
  cada» con subworkflow, ni las correcciones de la fase 10 sobre subejecuciones y aprobaciones, que están
  probadas con el modelo simulado.

## Cosas que conviene saber

- **Intermitencia bajo carga.** En dos baterías completas falló una descarga de archivo en la suite e2e
  («download canceled») mientras otras tareas cargaban el equipo; repetida, pasó. La última batería completa
  pasó entera. No se ha encontrado una causa en el producto, pero tampoco está descartada.
- **Tres excepciones a la regla de «sin dobles»**, además del proveedor de modelos: `matchMedia` (no existe en el
  entorno de los tests de componentes), el punto de conexión de Vue Flow y, en los tests del monitor, el grafo
  entero sustituido por un componente vacío (ese entorno no puede pintar Vue Flow). El grafo real se prueba en
  la suite e2e.
- **La cobertura del frontend es del 55 %** porque las vistas grandes se prueban sobre todo en la suite e2e, que
  no cuenta en esa cifra.
- **La instalación real (`data/`) conserva el agente «Redactor» antiguo**: la corrección de los datos de ejemplo
  solo afecta a instalaciones nuevas.
- Durante el hito, la mayor parte de la traducción, de los tests nuevos y de las correcciones de la fase 10 la
  hicieron agentes en paralelo sobre archivos disjuntos. Todo su trabajo pasó después por las baterías completas,
  pero no se ha revisado línea a línea.
