# Solución de problemas

Cada apartado dice **qué ves**, **por qué pasa** y **qué hacer**. Si el problema no está aquí, el registro del
servidor (la terminal donde se arrancó) suele decir la causa: es una línea JSON por suceso; con
`AGENTFORGE_LOG_LEVEL=debug` añade una línea por petición.

## Al arrancar

| Qué ves | Por qué | Qué hacer |
|---|---|---|
| `El puerto ya está ocupado por otro programa` | Hay otro AgentForge u otro programa en el puerto 4310 | Ciérralo, o arranca con otro: `PORT=4311 npm start` (en PowerShell: `$env:PORT=4311; npm start`) |
| Un mensaje que nombra una variable (`AGENTFORGE_…`) y el servidor se detiene | La configuración se valida al arrancar y ese valor no es válido | Corrige la variable que dice el mensaje |
| El servidor no arranca con `HOST=0.0.0.0` | Fuera de este equipo es obligatoria una clave de acceso | Define `AGENTFORGE_TOKEN` (16 caracteres o más) |
| «Ya hay otro servidor de AgentForge (proceso N) usando la carpeta de datos» | Otra instancia usa la misma carpeta de datos | Usa esa instancia, o ciérrala. Si murió de golpe, el bloqueo antiguo se descarta solo al arrancar |
| La página dice «La interfaz no está compilada» | No se ha compilado la interfaz | `npm run build` y vuelve a arrancar |
| `node:sqlite` no existe / error de sintaxis al arrancar | Versión de Node antigua | Hace falta Node 22.13 o posterior (`node --version`) |
| «La base de datos … tiene el esquema vN, más reciente que el que entiende esta versión» | Se abrió con una versión más nueva y ahora se arranca una anterior | Vuelve a la versión nueva, o restaura una copia de seguridad. Antes de cada cambio de esquema se guarda `agentforge.db.v<N>.bak` |
| El primer arranque tras actualizar tarda mucho | Se migra el esquema, se crean índices y se compacta (decenas de segundos con historiales grandes) | Esperar: solo ocurre una vez |

## Modelos y proveedores

| Qué ves | Por qué | Qué hacer |
|---|---|---|
| «Proveedor no disponible» al pie del menú, o la tarjeta «Primeros pasos» dice que Ollama no responde | Ollama no está en marcha o está en otra dirección | Abre Ollama (`ollama serve`). Comprueba la dirección en Ajustes → Proveedores → «Probar conexión» |
| La lista de modelos sale vacía | Ollama no tiene ningún modelo descargado | `ollama pull qwen3:8b` (o el que quieras) y recarga la lista |
| Aviso «… no declara soporte de herramientas» en el editor | Es probable que ese modelo ignore las herramientas | Elige uno que sí (en Ollama, los que muestran la capacidad `tools`) o quita las herramientas del agente |
| El agente responde vacío o corta la respuesta | Se alcanzó el máximo de tokens, o el modelo gastó el límite razonando | Sube «Máx. tokens», o desactiva el razonamiento del agente |
| El agente usa muchas herramientas y acaba con una respuesta pobre | Agotó su máximo de iteraciones: la última llamada se hace sin herramientas para forzar una respuesta | Sube el límite de iteraciones del agente o simplifica la tarea |
| Tras cambiar la dirección de un proveedor falla con error de autenticación | La API key está ligada a la dirección para la que se guardó y no se envía a otra | Vuelve a escribir la clave en el proveedor |
| «No se pudo descifrar la API key de …» | Se ha perdido o cambiado `data/secret.key` | Vuelve a escribir las API keys, o restaura la copia que contiene la clave original |
| Las ejecuciones en paralelo no van más rápido | Ollama atiende las peticiones a un modelo según `OLLAMA_NUM_PARALLEL` | Sube esa variable de Ollama si tu equipo lo permite |

## Ejecuciones

| Qué ves | Por qué | Qué hacer |
|---|---|---|
| Una ejecución se queda «En cola» | Se alcanzó el número de ejecuciones simultáneas | Espera, cancela alguna o sube el límite en Ajustes |
| Una ejecución se queda «En espera» | Hay un nodo de aprobación pendiente | Decide desde el aviso de aprobaciones (aparece en todas las pantallas) |
| «Ejecución interrumpida por un reinicio del servidor» | El servidor se apagó con la ejecución a medias | Usa «Reanudar» en el aviso: reutiliza los pasos ya terminados. Se puede automatizar en Ajustes |
| Falla con «Se alcanzó el límite de N llamadas al modelo» o «Se superó la duración máxima de la ejecución» | Límites del workflow | Súbelos en los ajustes del workflow (sin ningún nodo seleccionado) |
| Un paso falla y los siguientes aparecen «Omitido» | Con la política «detener», un fallo corta las ramas que dependen de él | Corrige la causa y usa «Reintentar desde el fallo», o cambia la política a «continuar» |
| «Ejecutar» no hace nada y la insignia muestra errores | El workflow no es válido | Pulsa la insignia: cada problema lleva al nodo que lo causa |
| Una referencia `{{nodo}}` sale vacía | Ese nodo no se ejecutó (rama no elegida) o no es anterior | La validación avisa de las referencias a nodos que no son anteriores; revisa las ramas |
| «Para cada» procesa un solo elemento | La lista no se reconoció como lista | Que el paso anterior devuelva una lista JSON, o una línea por elemento |

## Herramientas

| Qué ves | Por qué | Qué hacer |
|---|---|---|
| «Acceso bloqueado a red privada o local» al llamar a `localhost` o a una IP de tu red | Las herramientas de red bloquean las redes privadas por defecto (protección frente a páginas maliciosas) | Ajustes → «Permitir redes privadas», solo si lo necesitas |
| `run_javascript` no aparece o está desactivada | Viene apagada por seguridad | Ajustes → «Permitir ejecución de código» y lee el aviso |
| El modo «Contenedor» da error | No hay Docker ni Podman en marcha, o falta la imagen | Arranca el motor y `docker pull node:24-alpine`; AgentForge no la descarga solo |
| «El archivo superaría el límite de 5 MB por archivo» (o el del total) | Límite de 5 MB por archivo y 100 MB en total | Borra archivos en Herramientas → Espacio de trabajo |
| Un servidor MCP queda «Error» | El programa no existe, terminó con error o tardó en responder | El motivo se muestra junto al servidor; pruébalo a mano en una terminal con el mismo comando |
| Tras renombrar un servidor MCP los agentes pierden sus herramientas | El nombre del servidor forma parte del nombre de cada herramienta | Vuelve a asignarlas en los agentes |

## Disparadores y webhooks

| Qué ves | Por qué | Qué hacer |
|---|---|---|
| Un disparador con horario no se lanzó | El servidor no estaba en marcha a esa hora | Solo corren con el servidor encendido. Una hora fija con más de una hora de retraso se omite a propósito |
| «Se omitió una ejecución porque la anterior seguía en curso» | Un disparador no se solapa consigo mismo | Espacia el horario o acorta el workflow |
| El webhook responde 401 («Webhook desconocido o secreto incorrecto») | Falta el secreto, no coincide o el disparador se eliminó | Envía el secreto como indica el diálogo; si lo perdiste, regenera el secreto |
| El webhook responde 409 («Este webhook está desactivado») | El disparador está en pausa | Actívalo en el diálogo de disparadores |

## Interfaz

| Qué ves | Por qué | Qué hacer |
|---|---|---|
| Franja roja «Sin conexión con el servidor» | El proceso del servidor no responde | Comprueba la terminal donde se arrancó. La interfaz se reconecta sola al volver |
| «Demasiadas peticiones» (429) | Límite de 1 200 peticiones por minuto por cliente | Espera unos segundos. Para automatizaciones, sube `AGENTFORGE_RATE_LIMIT` |
| Te pide una clave al entrar | El servidor tiene `AGENTFORGE_TOKEN` | Escribe esa clave |
| «Petición rechazada: procede de otro sitio web» o «Host no permitido» | Se accede por un nombre que el servidor no reconoce (por ejemplo, detrás de un proxy) | Declara ese nombre en `AGENTFORGE_ALLOWED_HOSTS` |
| Los cambios no se guardan al cerrar un diálogo | Si has escrito algo, pulsar fuera no lo cierra; Esc sí | Usa «Guardar» antes de cerrar |
| La interfaz sale en inglés (o en español) sin haberlo elegido | Se usa el idioma del navegador hasta que eliges uno | Selector ES / EN al pie del menú lateral |
| Con la interfaz en inglés, algunos mensajes salen en español | Los escribe el servidor (detalle de errores, descripciones de herramientas) | Es una limitación conocida |

## Datos

| Qué quieres | Cómo |
|---|---|
| Empezar de cero | Para el servidor y borra la carpeta `data/` |
| Mover la instalación a otro equipo | Ajustes → Copias de seguridad → crear y descargar; en el otro equipo, añadir la copia y restaurar (pide reiniciar) |
| Que el historial no crezca sin límite | Ajustes → Datos → retención por días y por número de ejecuciones |
| Copiar `data/` a mano | Solo con el servidor parado: con él en marcha parte de los datos está en `agentforge.db-wal` |

## Para informar de un fallo

Incluye la versión (Panel → Sistema), el sistema operativo, la versión de Node, los pasos para reproducirlo y las
líneas del registro del servidor en torno al momento del fallo. El registro no contiene API keys, pero sí puede
contener nombres de agentes y direcciones: revísalo antes de compartirlo.
