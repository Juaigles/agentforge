// Recorrido guiado (OnboardingTour, GettingStarted y la barra lateral). `steps` es el guion normal; `yokai`, lo que
// cambia en el Modo Yōkai (mismo recorrido, otra voz).
export default {
  region: 'Recorrido guiado',
  progress: 'Paso {n} de {total}',
  announce: 'Recorrido guiado, paso {n} de {total}: {title}',
  actions: {
    next: 'Siguiente',
    back: 'Atrás',
    skip: 'Saltar recorrido',
    close: 'Cerrar el recorrido (puedes reanudarlo luego)',
    finish: 'Terminar',
    goThere: 'Llévame allí',
    retry: 'Reintentar',
    skipToEnd: 'Ir al final del recorrido',
    openWorkflow: 'Abrir el workflow de bienvenida',
  },
  launcher: {
    start: 'Recorrido guiado',
    resume: 'Reanudar el recorrido',
    startLong: 'Hacer el recorrido guiado',
    resumeLong: 'Reanudar el recorrido guiado ({n} de {total})',
  },
  offer: {
    title: '¿Primera vez por aquí?',
    body: 'Un recorrido de unos minutos te enseña la aplicación ejecutando de verdad un workflow de ejemplo.',
    updated: 'El recorrido guiado se ha renovado desde la última vez.',
    start: 'Empezar el recorrido',
    later: 'Ahora no',
  },
  waiting: {
    launch: 'Esperando a que lances la ejecución…',
    approval: 'Esperando a que la ejecución llegue al paso de aprobación…',
    finish: 'Esperando a que termine la ejecución…',
  },
  elsewhere: 'Este paso se ve en otra pantalla.',
  preparing: 'Preparando el workflow de bienvenida…',
  prepareFailed: 'No se pudo preparar el workflow de bienvenida. Comprueba la conexión con el servidor e inténtalo otra vez.',
  noModel: {
    title: 'Falta un modelo',
    body: 'Para ejecutar el workflow hace falta un modelo que responda, y ahora mismo ningún proveedor lo hace. La guía de primeros pasos del Panel explica cómo conectarlo; cuando lo tengas, vuelve aquí y sigue.',
    guide: 'Abrir la guía de primeros pasos',
    settings: 'Ir a Ajustes',
  },
  skin: {
    label: 'Elige cómo quieres verla',
    normal: 'Normal',
    normalHint: 'Sobria: paneles, grafos y listas.',
    yokai: 'Modo Yōkai',
    yokaiHint: 'Una oficina de yōkai en pixel art.',
    later: 'Puedes cambiarla cuando quieras con el interruptor «Modo Yōkai» de la barra lateral.',
  },
  typewriter: 'Texto animado',
  narrator: 'Kitsune, tu guía',
  links: {
    title: 'Para seguir',
    createAgent: 'Crear tu propio agente',
    duplicate: 'Duplicar o editar workflows',
    glossary: 'Consultar el glosario',
    toYokai: 'Probar el Modo Yōkai',
    toNormal: 'Volver a la presentación normal',
  },
  steps: {
    welcome: {
      title: 'Bienvenido a AgentForge',
      body: 'AgentForge orquesta agentes de IA y workflows que se ejecutan con modelos en tu propio equipo. En este recorrido verás las piezas principales y ejecutarás un workflow de ejemplo de principio a fin.',
    },
    dashboard: {
      title: 'El Panel',
      body: 'Aquí tienes el resumen: cuántas ejecuciones hay en marcha, cuántas terminaron bien, el consumo de tokens y lo último que ha pasado.',
    },
    agents: {
      title: 'Agentes',
      body: 'Un agente es un modelo de lenguaje con un papel, unas instrucciones y unas herramientas. Puedes probar cada uno por separado en su banco de pruebas antes de usarlo en un workflow.',
    },
    builder: {
      title: 'El constructor de workflows',
      body: 'Este es el workflow de bienvenida. Un workflow es un diagrama: cada caja es un paso (un nodo) y las flechas dicen en qué orden se ejecutan y qué dato pasa de uno a otro. Vamos a ver los tipos de paso uno a uno.',
    },
    node: {
      input: {
        title: 'Entrada',
        body: 'Aquí empieza todo: recoge el texto con el que lanzas la ejecución. Los demás pasos lo citan como input entre llaves dobles.',
      },
      agent: {
        title: 'Agente',
        body: 'Un paso de agente le pasa una tarea a uno de tus agentes, que razona con el modelo y puede llamar a herramientas. Su respuesta es la salida del paso.',
      },
      tool: {
        title: 'Herramienta',
        body: 'Ejecuta una herramienta directamente, sin modelo: una petición HTTP, leer un archivo, una búsqueda… Es rápido y no gasta tokens.',
      },
      condition: {
        title: 'Condición',
        body: 'Decide el camino: comprueba algo sobre el dato y sigue por la salida «sí» o por la «no». Las ramas que no se toman quedan saltadas.',
      },
      transform: {
        title: 'Transformación',
        body: 'Da forma al dato con una plantilla: junta salidas de pasos anteriores, recorta o cambia el formato antes de seguir.',
      },
      foreach: {
        title: 'Para cada',
        body: 'Repite un trabajo con cada elemento de una lista (por ejemplo, cada línea de la entrada) y reúne los resultados.',
      },
      approval: {
        title: 'Aprobación humana',
        body: 'El workflow se detiene aquí hasta que una persona lo apruebe o lo rechace. Sirve para revisar antes de hacer algo importante.',
      },
      output: {
        title: 'Salida',
        body: 'El final del camino: lo que llega aquí es el resultado de la ejecución.',
      },
    },
    edges: {
      title: 'Las conexiones',
      body: 'Las flechas unen la salida de un paso con la entrada del siguiente. Los pasos sin dependencia entre sí se ejecutan a la vez; una condición tiene dos salidas, una por rama.',
    },
    launch: {
      title: 'Ejecútalo',
      body: 'Pulsa «Ejecutar», escribe una entrada (vale cualquier frase) y lánzalo. El recorrido sigue solo cuando empiece la ejecución.',
    },
    runLive: {
      title: 'La ejecución en vivo',
      body: 'El grafo muestra el estado de cada paso mientras ocurre: el que trabaja se ilumina y las partículas que recorren las flechas son el dato viajando de un paso al siguiente.',
    },
    runSteps: {
      title: 'Pasos y actividad',
      body: 'A la izquierda, la lista de pasos con su estado y su duración; elige uno para ver su salida. La pestaña «Actividad» cuenta qué hizo cada agente: qué pensó, qué herramientas llamó y qué respondieron.',
    },
    approval: {
      title: 'Te toca decidir',
      body: 'La ejecución se ha detenido en la aprobación humana. El aviso de arriba sale en cualquier pantalla: lee el mensaje, añade un comentario si quieres y pulsa «Aprobar» para que continúe.',
    },
    result: {
      title: 'Resultado',
      body: 'Aquí tienes cuánto duró, cuántas llamadas al modelo y a herramientas hizo y cuántos tokens gastó. El resultado final está en la pestaña «Resultado»; cada ejecución queda guardada en «Ejecuciones».',
    },
    finish: {
      title: '¡Listo!',
      body: 'Ya has visto el ciclo completo: diseñar un workflow, ejecutarlo, seguirlo en vivo y decidir en una aprobación. Puedes repetir este recorrido cuando quieras desde la barra lateral.',
    },
  },
  yokai: {
    welcome: {
      title: '¡Bienvenido a la oficina!',
      body: 'Soy Kitsune y hoy te enseño la casa. AgentForge es una oficina de yōkai: cada agente es un empleado que trabaja con modelos de tu propio equipo y los workflows son los encargos que pasan de sala en sala.',
    },
    dashboard: {
      body: 'El tablón de la entrada: cuántos encargos hay en marcha, cuántos salieron bien y cuánta energía (tokens) llevamos gastada.',
    },
    agents: {
      title: 'La plantilla',
      body: 'Cada agente es un yōkai de la plantilla: tiene su puesto, sus instrucciones y sus herramientas. Puedes ponerlo a prueba en su banco de pruebas antes de mandarlo a un encargo.',
    },
    builder: {
      title: 'El plano del encargo',
      body: 'Este es el encargo de bienvenida. Cada tipo de paso es una sala de la oficina y las flechas son los pasillos por los que viaja el dato. Recorramos las salas una a una.',
    },
    node: {
      input: { body: 'La recepción: aquí llega el encargo con el texto que escribas al lanzarlo.' },
      agent: { body: 'Los cubículos: un yōkai de la plantilla recibe la tarea, piensa con su modelo y responde.' },
      tool: { body: 'La sala de servidores: se usa una herramienta sin pasar por ningún modelo, rápido y sin gastar tokens.' },
      condition: { body: 'El vestíbulo: aquí se decide por qué puerta sigue el encargo, «sí» o «no».' },
      transform: { body: 'Las impresoras: el dato se recompone con una plantilla antes de seguir.' },
      foreach: { body: 'La sala de reuniones: el mismo trabajo se repite con cada elemento de una lista.' },
      approval: { body: 'El despacho: el encargo espera a que alguien estampe el sello hanko para aprobarlo, o lo rechace.' },
      output: { body: 'El correo: lo que llega aquí sale de la oficina como resultado.' },
    },
    edges: {
      body: 'Los pasillos unen una sala con la siguiente. Si dos salas no dependen una de otra, se trabaja en las dos a la vez; el vestíbulo tiene dos puertas, una por camino.',
    },
    launch: {
      body: 'Pulsa «Ejecutar», escribe lo que quieras como encargo y lánzalo. En cuanto entre por la recepción, te llevo a verlo.',
    },
    runLive: {
      title: 'La planta, en vivo',
      body: 'Esta es la oficina vista desde arriba. El fantasma mensajero lleva la llama azul (el dato) de sala en sala; el yōkai de cada paso va a su cubículo y la sala donde se trabaja se ilumina.',
    },
    runSwitch: {
      title: 'Planta o grafo',
      body: 'Con este selector cambias entre la planta de la oficina y el grafo clásico de pasos. Muestran lo mismo; elige el que prefieras.',
    },
    runSteps: {
      body: 'A la izquierda, la lista de pasos; elige uno para ver qué hizo. En «Actividad» está el diario de cada yōkai: qué pensó, qué herramientas usó y qué le respondieron.',
    },
    approval: {
      body: 'El encargo ha llegado al despacho y espera tu sello hanko. Usa el aviso de arriba (sale en cualquier pantalla): pulsa «Aprobar» para estampar el sello y que el mensajero siga su camino.',
    },
    result: {
      body: 'Encargo entregado. Aquí ves cuánto tardó, cuántas veces se consultó al modelo y a las herramientas, y cuánta energía (tokens) gastó. El resultado está en la pestaña «Resultado».',
    },
    finish: {
      title: '¡Encargo cumplido!',
      body: 'Ya conoces la oficina: diseñar un encargo, lanzarlo, seguir al mensajero y sellar una aprobación. Vuelve a llamarme cuando quieras desde la barra lateral.',
    },
  },
};
