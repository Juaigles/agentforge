// Workflow de bienvenida: un recorrido corto por casi todos los tipos de paso (entrada, agente, herramienta,
// condición, transformación, «para cada», aprobación y salida) pensado para el primer contacto con la aplicación
// y para la visita guiada de la interfaz. Está diseñado para un modelo local pequeño: cuatro llamadas al modelo
// con respuestas de pocas frases, de modo que termina en menos de un minuto (sin contar la espera de la aprobación).
//
// El workflow y su agente llevan la marca `builtin = 'welcome'` en su fila (migración v8): el servidor los
// reconoce aunque el usuario los renombre o los edite, y la marca desaparece sola si los borra.
import { DEFAULT_WORKFLOW_SETTINGS, type AgentInput, type Workflow, type WorkflowInput } from '../../shared/types';
import type { Store } from './db/store';

/** Valor de la marca `builtin` del workflow de bienvenida y de su agente. */
export const WELCOME_KEY = 'welcome';

/** Nombre que se le da al visitante si no escribe el suyo; la condición del workflow lo usa para elegir rama. */
export const WELCOME_GUEST_NAME = 'Invitado';

/** Lista del «para cada»: tres piezas de AgentForge, una por línea. */
export const WELCOME_PIECES = [
  'Agentes: asistentes con un rol, un modelo y unas instrucciones propias',
  'Herramientas: acciones seguras, como la calculadora o leer y escribir archivos',
  'Workflows: pasos encadenados que se ejecutan en orden, como este',
];

/** Proveedor y modelo con los que se crea el agente de la bienvenida. */
export type WelcomeAgentBase = Pick<AgentInput, 'providerId' | 'model'>;

/** El agente «Guía»: respuestas breves y cálidas, sin herramientas (una sola llamada al modelo por tarea). */
export function welcomeAgentInput(base: WelcomeAgentBase): AgentInput {
  return {
    ...base,
    name: 'Guía',
    role: 'anfitriona que da la bienvenida a AgentForge',
    description: 'Saluda a quien llega por primera vez y le propone ideas sencillas para empezar.',
    color: '#ec4899',
    temperature: 0.6,
    maxTokens: 300,
    maxIterations: 2,
    thinking: false,
    tools: [],
    systemPrompt:
      'Eres la Guía de AgentForge, una aplicación local para crear agentes de IA y encadenarlos en workflows (flujos de pasos) ' +
      'que se ejecutan con modelos instalados en el propio ordenador. Respondes siempre en español, con un tono cálido y cercano, ' +
      'en frases cortas. No inventes funciones de la aplicación y no superes nunca la extensión que te pidan.',
  };
}

/**
 * Definición del workflow. Las posiciones van de izquierda a derecha en columnas de 250 px; las dos ramas de la
 * condición y de la aprobación se separan arriba («sí») y abajo («no»).
 *
 *   Tu nombre → Saludo de la Guía → Calcular el tiempo ahorrado → ¿Has escrito tu nombre?
 *     sí → Mensaje personal ┐                                       ┌ sí → Bienvenida publicada
 *     no → Mensaje de invitado ┴→ Tres piezas clave → Revisar la bienvenida ┴ no → Bienvenida rechazada
 *
 * Las salidas usan `{{mensaje_personal}}{{mensaje_invitado}}`: solo una de las dos ramas se ejecuta y la referencia
 * a un paso saltado queda vacía, así que el texto sale siempre una vez.
 */
export function welcomeWorkflowInput(guideId: string): WorkflowInput {
  const message = '{{mensaje_personal}}{{mensaje_invitado}}';
  return {
    name: 'Bienvenida a AgentForge',
    description:
      'Tu primer recorrido por AgentForge: la Guía te saluda, la calculadora hace una cuenta, una condición elige la rama según hayas ' +
      'escrito tu nombre, una plantilla compone el mensaje, un «para cada» explica tres piezas clave y tú apruebas el resultado antes de publicarlo. ' +
      'Con un modelo local pequeño tarda menos de un minuto.',
    settings: { ...DEFAULT_WORKFLOW_SETTINGS, maxConcurrency: 3, maxDurationMs: 10 * 60_000, maxLlmCalls: 10, defaultRetries: 1 },
    nodes: [
      {
        id: 'nombre',
        type: 'input',
        label: 'Tu nombre',
        position: { x: 0, y: 160 },
        config: {
          description: `Escribe tu nombre. Si lo dejas como «${WELCOME_GUEST_NAME}», el workflow tomará la rama de invitado.`,
          defaultValue: WELCOME_GUEST_NAME,
        },
      },
      {
        id: 'saludo',
        type: 'agent',
        label: 'Saludo de la Guía',
        position: { x: 250, y: 160 },
        config: {
          agentId: guideId,
          prompt:
            'Saluda a {{nombre}} en una sola frase y, en otra frase, propónle un workflow sencillo que podría crear en AgentForge ' +
            'para su día a día. Máximo 50 palabras, sin listas ni títulos.',
        },
      },
      {
        id: 'calculo',
        type: 'tool',
        label: 'Calcular el tiempo ahorrado',
        position: { x: 500, y: 160 },
        // 15 minutos al día durante 220 días laborables, en horas. La calculadora es determinista y no usa la red.
        config: { tool: 'calculator', args: { expression: '15 * 220 / 60' } },
      },
      {
        id: 'tiene_nombre',
        type: 'condition',
        label: '¿Has escrito tu nombre?',
        position: { x: 750, y: 160 },
        config: { left: '{{nombre}}', operator: 'not_equals', right: WELCOME_GUEST_NAME },
      },
      {
        id: 'mensaje_personal',
        type: 'transform',
        label: 'Mensaje personal',
        position: { x: 1000, y: 40 },
        config: {
          template:
            '## ¡Hola, {{nombre}}!\n\n{{saludo}}\n\n' +
            'Como escribiste tu nombre, la condición tomó la rama **sí** y este mensaje se ha compuesto solo para ti.',
        },
      },
      {
        id: 'mensaje_invitado',
        type: 'transform',
        label: 'Mensaje de invitado',
        position: { x: 1000, y: 280 },
        config: {
          template:
            '## ¡Hola!\n\n{{saludo}}\n\n' +
            'Como no escribiste tu nombre, la condición tomó la rama **no** (la de invitado). ' +
            'Vuelve a ejecutar el workflow con tu nombre y verás la otra rama.',
        },
      },
      {
        id: 'piezas',
        type: 'foreach',
        label: 'Tres piezas clave',
        position: { x: 1250, y: 160 },
        config: {
          body: 'agent',
          agentId: guideId,
          items: WELCOME_PIECES.join('\n'),
          prompt: 'Explica a {{nombre}}, en una sola frase de 30 palabras como máximo, para qué le sirve esta pieza de AgentForge: {{item}}',
          concurrency: 3,
          maxItems: 5,
        },
      },
      {
        id: 'aprobacion',
        type: 'approval',
        label: 'Revisar la bienvenida',
        position: { x: 1500, y: 160 },
        config: {
          message:
            'Revisa la bienvenida que ha preparado el workflow. Si la apruebas, se publicará como resultado final; ' +
            'si la rechazas, el workflow terminará por la otra salida. Si dejas un comentario, aparecerá en el resultado.\n\n' +
            `${message}\n\n### Tres piezas clave\n\n{{piezas}}`,
        },
      },
      {
        id: 'bienvenida',
        type: 'output',
        label: 'Bienvenida publicada',
        position: { x: 1750, y: 40 },
        config: {
          template:
            `# Te damos la bienvenida a AgentForge\n\n${message}\n\n` +
            '## Tres piezas para empezar\n\n{{piezas}}\n\n' +
            '## Lo que calculó la herramienta\n\n' +
            'La calculadora integrada (sin red ni modelo) ha calculado cuántas horas al año suman **15 minutos al día durante 220 días laborables**:\n\n' +
            '```json\n{{calculo}}\n```\n\n' +
            '---\n\nHas aprobado este resultado en el paso de aprobación humana. Tu comentario (si dejaste alguno): {{aprobacion.comment}}',
        },
      },
      {
        id: 'rechazada',
        type: 'output',
        label: 'Bienvenida rechazada',
        position: { x: 1750, y: 280 },
        config: {
          template:
            '# Bienvenida sin publicar\n\n' +
            'Has rechazado la bienvenida en el paso de aprobación, así que el workflow ha salido por la rama **no**: así funciona una salida alternativa.\n\n' +
            'Tu comentario (si dejaste alguno): {{aprobacion.comment}}\n\n' +
            'Puedes volver a ejecutarlo cuando quieras o abrirlo en el editor para cambiar sus pasos.',
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'nombre', target: 'saludo' },
      { id: 'e2', source: 'saludo', target: 'calculo' },
      { id: 'e3', source: 'calculo', target: 'tiene_nombre' },
      { id: 'e4', source: 'tiene_nombre', target: 'mensaje_personal', sourceHandle: 'true' },
      { id: 'e5', source: 'tiene_nombre', target: 'mensaje_invitado', sourceHandle: 'false' },
      { id: 'e6', source: 'mensaje_personal', target: 'piezas' },
      { id: 'e7', source: 'mensaje_invitado', target: 'piezas' },
      { id: 'e8', source: 'piezas', target: 'aprobacion' },
      { id: 'e9', source: 'aprobacion', target: 'bienvenida', sourceHandle: 'true' },
      { id: 'e10', source: 'aprobacion', target: 'rechazada', sourceHandle: 'false' },
    ],
  };
}

/** Id de la fila marcada con `builtin = 'welcome'` en `table`, o null si no hay ninguna (o se borró). */
function markedId(store: Store, table: 'workflows' | 'agents'): string | null {
  const row = store.db.prepare(`SELECT id FROM ${table} WHERE builtin = ?`).get(WELCOME_KEY) as { id: string } | undefined;
  return row?.id ?? null;
}

function mark(store: Store, table: 'workflows' | 'agents', id: string): void {
  store.db.prepare(`UPDATE ${table} SET builtin = ? WHERE id = ?`).run(WELCOME_KEY, id);
}

/** Id del workflow de bienvenida, aunque se haya renombrado; null si no existe. */
export function welcomeWorkflowId(store: Store): string | null {
  return markedId(store, 'workflows');
}

/**
 * Crea el workflow de bienvenida si no existe y lo devuelve; si ya existe, lo devuelve tal cual (con los cambios que
 * haya hecho el usuario). Si el workflow se borró pero su agente sigue, lo reutiliza en lugar de duplicarlo.
 * Todo ocurre en una transacción: o se crean el agente, el workflow y sus marcas, o nada.
 */
export function createWelcomeWorkflow(store: Store, base: WelcomeAgentBase): Workflow {
  return store.transaction(() => {
    const existing = welcomeWorkflowId(store);
    if (existing) return store.getWorkflow(existing)!;
    let guideId = markedId(store, 'agents');
    if (!guideId) {
      guideId = store.createAgent(welcomeAgentInput(base)).id;
      mark(store, 'agents', guideId);
    }
    const wf = store.createWorkflow(welcomeWorkflowInput(guideId));
    mark(store, 'workflows', wf.id);
    return wf;
  });
}
