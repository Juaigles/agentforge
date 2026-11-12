# Tests end-to-end (Playwright)

Suite repetible que conduce la interfaz real en **Chromium, Firefox y WebKit** contra el servidor real de AgentForge. Los tests buscan
los textos en español (el navegador de la suite pide `es-ES`); `i18n.spec.ts` cubre el inglés.

```bash
npm run test:e2e           # compila el frontend y ejecuta la suite en Chromium
npm run test:e2e:all       # lo mismo en Chromium, Firefox y WebKit (uno detrás de otro)
npx playwright test --project=firefox e2e/runs.spec.ts   # un motor y un archivo (requiere web/dist)
npm run test:e2e:ui        # lo mismo, con la interfaz interactiva de Playwright
npx playwright test e2e/runs.spec.ts -g "cancelar"   # un archivo o un test concreto (requiere web/dist)
npx playwright show-report e2e/.report               # informe HTML de la última ejecución
```

La primera vez hay que descargar los navegadores: `npx playwright install` (o `npx playwright install chromium`).

Diferencias entre motores que la suite tiene en cuenta:

- **WebKit no detiene el tabulador en los enlaces** (ajuste de Safari): el test del enlace «Saltar al contenido»
  lo enfoca directamente en ese motor.
- **WebKit en Windows no conserva `SameSite` en su almacén de cookies**: se comprueba en la cabecera de la respuesta.
- Cada motor describe a su manera un fallo de red (`net::ERR_`, «NetworkError», «due to access control checks»):
  los tres textos se tratan como ruido esperado cuando el propio test para el servidor.

## Cómo está montada

| Pieza | Qué hace |
|---|---|
| `support/fixtures.ts` | Por cada worker arranca **el servidor de producción** (`node --import tsx src/index.ts` desde `server/`) en un puerto libre (`PORT`), con un directorio de datos temporal (`AGENTFORGE_DATA_DIR`) y `OLLAMA_URL` apuntando al modelo simulado. Sirve la interfaz compilada (`web/dist`), igual que `npm start`. Expone `app.restart()`, que **mata el proceso** (sin apagado ordenado) y lo relanza sobre los mismos datos, y `app.shutdown()`, que pide un apagado **ordenado** por el canal IPC (lo mismo que Ctrl+C) y espera a que el proceso termine solo. |
| `support/fake-ollama.ts` | Servidor HTTP local que habla el protocolo de cable de Ollama (`/api/tags`, `/api/chat` en NDJSON con streaming y tool-calls) y el de OpenAI (`/v1/models`, `/v1/chat/completions` en SSE). AgentForge se conecta a él con sus adaptadores de producción. Es el **único** doble de prueba. |
| `*.spec.ts` | Los tests. Cada uno crea sus propios datos con nombres únicos, así que no dependen del orden. |

Además, todo test falla si la página emite un error de JavaScript o un `console.error`.

### Guion del modelo simulado

La respuesta se decide con directivas escritas en las instrucciones del agente o en la tarea:

| Directiva | Efecto |
|---|---|
| *(ninguna)* | Responde `Eco: <tarea>` |
| `[[decir:TEXTO]]` | Responde exactamente `TEXTO` |
| `[[ritmo:MS]]` / `[[palabras:N]]` | Milisegundos entre fragmentos / número de palabras de la respuesta |
| `[[lento]]` | ≈40 s de streaming (para cancelar o cortar a medias) |
| `[[lentosi:CLAVE]]` | Como `[[lento]]`, pero solo mientras `app.fake.failing` contenga `CLAVE` |
| `[[pensar]]` | Emite antes un fragmento de razonamiento |
| `[[fallo:CLAVE]]` | Falla mientras `app.fake.failing` contenga `CLAVE` |
| `[[herramienta:NOMBRE {json}]]` | Pide esa herramienta y luego responde `Resultado de NOMBRE: <resultado>` |

`app.fake.chats` guarda cada petición recibida (mensajes, herramientas ofrecidas, cabecera `Authorization`),
para comprobar qué llegó de verdad al proveedor.

## Qué cubre

| Archivo | Cobertura |
|---|---|
| `agents.spec.ts` | Alta de un agente desde la interfaz y ejecución en el banco de pruebas con herramienta; streaming y cancelación; cambios sin guardar, duplicar y eliminar; aviso de modelo sin herramientas |
| `workflow-builder.spec.ts` | Construcción de un workflow desde cero en el lienzo (paleta, arrastre, conexiones a mano, rechazo de ciclos, inspector, validación), guardado, ejecución y monitor en vivo; ramas de una condición; nodo «para cada»; bloqueo de la ejecución con errores |
| `runs.spec.ts` | Cancelar (monitor y lista), reintentar desde el fallo, repetir, política «continuar», historial con filtros y búsqueda, actualización en vivo de la lista, ejecución inexistente |
| `persistence.spec.ts` | Datos y ejecuciones tras matar y relanzar el servidor; aviso para reanudar o descartar las ejecuciones interrumpidas; reconexión de una página abierta |
| `tools.spec.ts` | Herramienta HTTP personalizada (alta, prueba, uso por un agente contra una API local, edición de valores permitidos y valor por defecto, desactivar, borrar); POST con cuerpo; nombres en conflicto; búsqueda y banco de pruebas; visor y borrado de archivos |
| `settings.spec.ts` | Proveedores (alta con API key, modelos antes de guardar, edición sin reenviar la clave, quitar clave, activar/desactivar, borrado); concurrencia máxima; ejecución de código; redes privadas; retención del historial; eliminar ejecuciones terminadas |
| `automation.spec.ts` | Exportar a un archivo e importarlo (descarga y subida reales, **revisión previa** de lo que trae el archivo, recreación de agentes, archivos no válidos, avisos); **importar con conflictos** (un agente que existe pero es distinto se sustituye desde el diálogo; la credencial de una herramienta HTTP no viaja ni se enseña) y **exportar e importar un agente suelto** con su herramienta HTTP; **disparadores**: tres con horario en un mismo workflow (intervalo, días y hora con zona horaria, cron con vista previa), ejecutar ahora, pausar, editar y borrar; **webhook** (secreto mostrado una vez, llamada externa real con y sin secreto, regenerarlo); disparo por el temporizador real tras un minuto |
| `mcp.spec.ts` | Añadir un **servidor MCP** real (proceso hijo), probar una de sus herramientas en el banco de pruebas, usarla desde un agente, desactivarlo y eliminarlo; un servidor que no arranca queda señalado con su motivo |
| `access.spec.ts` | Clave de acceso: con `AGENTFORGE_TOKEN` la API responde 401 y la interfaz solo muestra la pantalla de entrada; clave incorrecta y correcta; cookie de sesión `HttpOnly`; flujos en vivo con la sesión. Lanza su propio servidor |
| `backup.spec.ts` | Copias de seguridad desde Ajustes: crear, descargar el archivo, preparar y cancelar una restauración, aplicarla con un reinicio ordenado del servidor (los datos vuelven a ser los de la copia), añadir una copia desde un archivo, rechazar un archivo que no lo es y borrar |
| `flow.spec.ts` | Aprobación humana construida en el lienzo (la ejecución espera, se rechaza con comentario y se aprueba desde el aviso); una ejecución en espera que sobrevive a un reinicio ordenado; subworkflow elegido en el inspector, con su subejecución enlazada y el ciclo entre workflows señalado; «para cada» con una herramienta y política «continuar» |
| `a11y.spec.ts` | **Teclado y foco**: «Saltar al contenido», foco y anuncio al cambiar de página, trampa de foco e `inert` en los diálogos, avisos de error persistentes; **constructor**: deshacer y rehacer (botones y teclado), seleccionar, conectar y desconectar nodos sin ratón, Ctrl+S, copiar, pegar y ordenar; **historial** con los filtros en la URL; **guía de primeros pasos** que se marca sola; y **estado de conexión**: se mata el servidor y la interfaz lo dice y se recupera |
| `i18n.spec.ts` | **Idiomas**: el selector cambia la interfaz a inglés sin recargar y se recuerda; todas las pantallas en inglés y en español sin claves sin traducir; validación de workflows, formatos y errores del servidor según el idioma; idioma inicial según el navegador |
| `layout.spec.ts` | Tema claro/oscuro/sistema y contraste; 14 rutas a 375 × 812 sin desbordamiento horizontal en ambos temas; navegación y glosario táctiles |
