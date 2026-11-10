# Tests end-to-end (Playwright)

Suite repetible que conduce la interfaz real en Chromium contra el servidor real de AgentForge.

```bash
npm run test:e2e           # compila el frontend y ejecuta la suite
npm run test:e2e:ui        # lo mismo, con la interfaz interactiva de Playwright
npx playwright test e2e/runs.spec.ts -g "cancelar"   # un archivo o un test concreto (requiere web/dist)
npx playwright show-report e2e/.report               # informe HTML de la última ejecución
```

La primera vez hay que descargar el navegador: `npx playwright install chromium`.

## Cómo está montada

| Pieza | Qué hace |
|---|---|
| `support/fixtures.ts` | Por cada worker arranca **el servidor de producción** (`node --import tsx server/src/index.ts`) en un puerto libre (`PORT`), con un directorio de datos temporal (`AGENTFORGE_DATA_DIR`) y `OLLAMA_URL` apuntando al modelo simulado. Sirve la interfaz compilada (`web/dist`), igual que `npm start`. Expone `app.restart()`, que **mata el proceso** (sin apagado ordenado) y lo relanza sobre los mismos datos. |
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
| `automation.spec.ts` | Exportar a un archivo e importarlo (descarga y subida reales, recreación de agentes, archivos no válidos, avisos); programar un workflow, ejecutarlo ahora, pausarlo y quitarlo; disparo por el temporizador real tras un minuto |
| `layout.spec.ts` | Tema claro/oscuro/sistema y contraste; 14 rutas a 375 × 812 sin desbordamiento horizontal en ambos temas; navegación y glosario táctiles |
