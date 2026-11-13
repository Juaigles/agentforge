# Guía de usuario de AgentForge

AgentForge sirve para montar equipos de agentes de IA que trabajan en tu propio ordenador: defines qué hace cada
agente, los conectas en un workflow y ves cómo trabajan paso a paso. Esta guía recorre lo que harás, en el orden
en que lo harás. Los términos técnicos están explicados en el **Glosario** de la propia aplicación (menú lateral)
y aparecen subrayados con puntos: al pasar el ratón, enfocarlos o tocarlos se ve su definición.

La interfaz está en español y en inglés (selector ES / EN al pie del menú lateral). En inglés se traducen también
los mensajes del servidor: los errores de un formulario, el motivo por el que falla una ejecución y los textos de
las herramientas integradas. Lo que responde un modelo o un servicio externo se muestra tal cual, y las
ejecuciones anteriores a la versión 1.0 conservan su mensaje en español.

## 1. Antes de empezar: conectar un modelo

Un agente necesita un modelo de lenguaje. Lo habitual es [Ollama](https://ollama.com/download), que los ejecuta
en tu equipo, gratis y sin enviar datos fuera:

1. Instala Ollama y déjalo abierto.
2. Descarga un modelo con soporte de herramientas: `ollama pull qwen3:8b` (o el que prefieras).
3. Arranca AgentForge (`npm install`, `npm run build`, `npm start`) y abre <http://127.0.0.1:4310>.

La primera vez, el **Panel** muestra la tarjeta «Primeros pasos». Si el punto junto a «Conecta un modelo» no se
marca, la tarjeta dice por qué (por ejemplo, que Ollama no responde) y qué comando ejecutar. El botón «Probar
conexión» vuelve a comprobarlo.

Para usar un servicio remoto en lugar de Ollama: **Ajustes → Proveedores de modelos → Añadir proveedor**, elige
la plantilla, pega la dirección y la API key, y pulsa «Probar conexión» antes de guardar. La clave se guarda
cifrada y no se vuelve a mostrar.

### El recorrido guiado

La primera vez, la tarjeta «Primeros pasos» ofrece también un **recorrido guiado** de unos minutos. Abre el
workflow de ejemplo «Bienvenida a AgentForge» (lo crea si no existe), explica el Panel, los agentes y cada tipo de
paso señalándolos en pantalla y te acompaña mientras lo **ejecutas de verdad**: lanzas la ejecución, la sigues en
vivo, apruebas el paso de aprobación humana y ves el resultado con sus tokens y su duración. En el primer paso eliges
la presentación (normal o Modo Yōkai); con el Modo Yōkai, la guía es Kitsune y habla de la oficina, sus salas y el
mensajero.

La tarjeta no bloquea la aplicación: puedes pulsar lo que te pide (Ejecutar, Aprobar) con ella abierta. «Siguiente»
y «Atrás» se mueven por los pasos, **Esc** o la × la cierran sin perder el progreso y «Saltar recorrido» lo abandona.
Para empezarlo otra vez o reanudarlo: «Recorrido guiado» al pie del menú lateral, o el botón de la tarjeta «Primeros
pasos». Si no hay ningún modelo que responda, el recorrido lo dice al llegar a la ejecución y remite a esta guía.

## 2. Agentes

Un **agente** es un modelo con un papel, unas instrucciones y unas herramientas.

- **Agentes → Nuevo agente.** Lo mínimo es un nombre, un proveedor y un modelo. Las *instrucciones* (prompt de
  sistema) dicen cómo debe comportarse siempre; la tarea concreta se la darás cada vez.
- **Herramientas.** Marca las que pueda usar: calculadora, fecha, leer una página web, peticiones HTTP, archivos
  del espacio de trabajo, memoria compartida, delegar en otro agente… Las que actúan fuera de la conversación
  llevan la marca «Sensible». Si el modelo elegido no admite herramientas, el editor lo avisa.
- **Banco de pruebas** (a la derecha del editor). Escribe una tarea y pulsa «Ejecutar» (o Ctrl+Intro): verás la
  respuesta llegar palabra a palabra, las herramientas que usa y cuánto tarda. Hay que guardar los cambios para
  probar la versión nueva.
- **Exportar, duplicar y eliminar** están en la lista de agentes. Al eliminar uno, el aviso dice qué workflows
  dejarán de poder ejecutarse.

Consejos: instrucciones cortas y concretas («responde con una lista de cinco puntos»), temperatura baja para
tareas exactas y un límite de iteraciones razonable (cada iteración es una llamada al modelo).

## 3. Workflows

Un **workflow** conecta varios pasos. Cada paso es un **nodo**:

| Nodo | Qué hace |
|---|---|
| Entrada | Recibe el texto con el que se lanza el workflow |
| Agente | Un agente realiza una tarea |
| Herramienta | Ejecuta una herramienta directamente, sin modelo |
| Condición | Elige la rama «sí» o «no» según un texto |
| Para cada | Repite una tarea con cada elemento de una lista, varios a la vez |
| Subworkflow | Ejecuta otro workflow como un paso |
| Aprobación | Detiene la ejecución hasta que una persona aprueba o rechaza |
| Transformación | Compone un texto con una plantilla |
| Salida | El resultado final |

### Construirlo

- **Workflows → Nuevo workflow.** Pulsa un agente o un bloque de la paleta para añadirlo; si hay un nodo
  seleccionado, el nuevo se conecta a él. También puedes arrastrar desde la paleta y unir los puntos a mano.
- **Propiedades** (panel derecho): selecciona un nodo para editar su etiqueta, su agente y su tarea.
- **Referencias.** En la tarea de un nodo puedes citar lo que produjeron otros: `{{input}}` es la entrada del
  workflow, `{{upstream}}` lo que llega por las conexiones entrantes y `{{id_del_nodo}}` la salida de un nodo
  anterior concreto. Los botones «Insertar referencia» las escriben por ti y solo ofrecen las que son válidas.
- **Validación.** La insignia de la barra dice «Válido» o cuántos errores hay. Al pulsarla ves la lista; cada
  problema lleva al nodo que lo causa. Un workflow con errores no se puede ejecutar.
- **Deshacer y rehacer** (Ctrl+Z, Ctrl+Mayús+Z), **copiar y pegar** nodos (Ctrl+C, Ctrl+V), **Ordenar** para
  recolocarlos de izquierda a derecha y **Ctrl+S** para guardar.
- **Sin ratón.** Tabula hasta un nodo y pulsa Intro para abrir sus propiedades; en ellas, el bloque «Conexiones»
  une y separa nodos. La lista «Nodos» de los ajustes del workflow lleva a cualquiera.

### Ajustes del workflow

Sin ningún nodo seleccionado, el panel derecho muestra los límites: cuántos nodos pueden ejecutarse a la vez,
reintentos por defecto, duración máxima, número máximo de llamadas al modelo y qué hacer si un nodo falla
(detenerlo todo o seguir con el resto).

### Ejecutarlo

«Ejecutar» pide la entrada y abre el **monitor**: el grafo con el estado de cada nodo, la lista de pasos, el
texto que se va generando y el registro de actividad (cada llamada al modelo y a una herramienta, con sus
argumentos y su resultado). En una ejecución larga el registro enseña las 100 entradas más recientes; «Cargar
anteriores» trae las de antes, por tandas.

## 4. Ejecuciones

**Ejecuciones** guarda el historial. Se puede filtrar por estado, por tipo, por workflow o agente y por fecha de
inicio (desde y hasta, ambos días incluidos), y buscar en el nombre, la entrada y el resultado; los filtros quedan
en la dirección de la página, así que se pueden guardar como favorito. «En curso» reúne todo lo que no ha
terminado: lo que se está ejecutando, lo que espera en la cola y lo que espera una aprobación. El filtro por
agente muestra las ejecuciones directas de ese agente, no las de los workflows que lo usan.

Desde el monitor de una ejecución:

- **Cancelar** una que está en curso.
- **Repetir**: la lanza de nuevo entera con la misma entrada.
- **Reintentar desde el fallo**: crea una ejecución nueva que reutiliza los pasos que terminaron bien y solo
  repite a partir del que falló. Es lo que quieres cuando falló el último paso de un workflow largo.
- Una ejecución fallida se abre directamente en el paso que falló, con el motivo y lo que llevaba escrito.

Si el servidor se apaga con ejecuciones a medias, al volver aparece un aviso para **reanudarlas** o descartarlas.
Las **aprobaciones** pendientes se deciden desde un aviso visible en cualquier pantalla.

## 5. Automatizar: disparadores

En la lista de workflows o en el constructor, **Disparadores** permite que un workflow se lance solo. Puede tener
varios a la vez:

- **Cada cierto tiempo** (cada N minutos, horas o días).
- **Días y hora** (por ejemplo, de lunes a viernes a las 9:00, con su zona horaria).
- **Cron**, con vista previa de las próximas ejecuciones.
- **Webhook**: una dirección que otro programa llama para lanzarlo. El secreto se muestra una sola vez; guárdalo.

Los disparadores con horario solo funcionan con el servidor en marcha.

## 6. Herramientas

**Herramientas** muestra el catálogo y permite probar cada una con sus argumentos reales.

- **Herramienta HTTP personalizada**: describe una llamada a una API (método, dirección con huecos `{{x}}`,
  parámetros, cabeceras). Las cabeceras con credenciales se guardan cifradas.
- **Servidores MCP**: conecta programas o servicios que ofrecen herramientas con el protocolo MCP. Un servidor
  local es un programa que se ejecuta en tu equipo con los mismos permisos que AgentForge: añade solo los que
  conozcas.
- **Archivos** (el espacio de trabajo): lo que escriben las herramientas, con vista previa y borrado.

## 7. Llevarse el trabajo: exportar, importar y copias

- **Exportar** un workflow o un agente genera un archivo JSON con todo lo que necesita (agentes, subworkflows,
  herramientas HTTP, proveedores y disparadores) y **ningún secreto**.
- **Importar** enseña primero qué trae el archivo y qué pasará con lo que ya existe; nada se crea hasta que
  confirmas, y si algo falla no queda nada a medias.
- **Copias de seguridad** (Ajustes): un único archivo con la base de datos, la clave de cifrado y el espacio de
  trabajo. Restaurar exige reiniciar el servidor. Guarda las copias en un sitio seguro: contienen la clave con la
  que se descifran las API keys.

## 8. Ajustes que conviene conocer

| Ajuste | Para qué |
|---|---|
| Ejecuciones simultáneas máximas | Con modelos locales, un valor bajo evita saturar el equipo; el resto espera en cola |
| Reanudar automáticamente tras un apagado | Si está activado, las ejecuciones interrumpidas continúan solas al arrancar |
| Permitir redes privadas | Deja que las herramientas de red llamen a tu red local. Desactivado por defecto por seguridad |
| Permitir ejecución de código | Activa la herramienta `run_javascript`. Lee el aviso antes de activarla |
| «Conservar el historial (días)» y «Máximo de ejecuciones guardadas» (sección Datos) | Cuánto historial se conserva (0 = sin límite) |

## 9. Si algo no va

Mira [solucion-problemas.md](solucion-problemas.md). Lo más habitual: Ollama no está en marcha, el modelo no
admite herramientas o el agente agotó su límite de iteraciones.
