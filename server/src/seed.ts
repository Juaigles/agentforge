// Datos de ejemplo para el primer arranque: un proveedor Ollama, el workflow de bienvenida (con su agente),
// cinco agentes más y dos workflows de ejemplo.
import { DEFAULT_WORKFLOW_SETTINGS, type AgentInput, type ModelInfo, type Provider } from '../../shared/types';
import type { AppContext } from './context';
import { createWelcomeWorkflow, welcomeWorkflowId } from './welcome';

/** Modelo con el que se crean los agentes si no se encuentra ninguno instalado. */
const FALLBACK_MODEL = 'llama3.2';

/** Elige el modelo local más ligero que soporte herramientas (o, en su defecto, el más ligero de chat). */
export function pickDefaultModel(models: ModelInfo[]): string | null {
  const chat = models.filter((m) => !m.capabilities || m.capabilities.includes('completion'));
  const bySize = (a: ModelInfo, b: ModelInfo) => (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity);
  const withTools = chat.filter((m) => m.capabilities?.includes('tools')).sort(bySize);
  return (withTools[0] ?? chat.sort(bySize)[0])?.id ?? null;
}

/** Modelo por defecto: el configurado o, si no hay, el más ligero que tenga instalado el Ollama local. */
async function discoverDefaultModel(ctx: AppContext): Promise<string> {
  let model = ctx.config.defaultModel;
  if (!model) {
    try {
      const models = await ctx.llm.create({ kind: 'ollama', baseUrl: ctx.config.ollamaUrl }).listModels(AbortSignal.timeout(3000));
      model = pickDefaultModel(models) ?? '';
    } catch {
      /* Ollama no disponible: se deja un modelo por defecto que el usuario puede cambiar */
    }
  }
  return model || FALLBACK_MODEL;
}

/** El proveedor Ollama local que crea el primer arranque. */
function createLocalProvider(ctx: AppContext, model: string): Provider {
  return ctx.store.createProvider({ name: 'Ollama local', kind: 'ollama', baseUrl: ctx.config.ollamaUrl, defaultModel: model });
}

/** Proveedor que usará el agente de la bienvenida: uno activo, mejor si es local (Ollama). */
function preferredProvider(providers: Provider[]): Provider | null {
  const enabled = providers.filter((p) => p.enabled);
  return enabled.find((p) => p.kind === 'ollama') ?? enabled[0] ?? providers[0] ?? null;
}

/**
 * Garantiza que existe el workflow de bienvenida y devuelve su id (idempotente). Si se borró, lo vuelve a crear;
 * si no hay ningún proveedor, crea el Ollama local igual que el primer arranque.
 */
export async function ensureWelcomeWorkflow(ctx: AppContext): Promise<string> {
  const { store } = ctx;
  const existing = welcomeWorkflowId(store);
  if (existing) return existing;

  let provider = preferredProvider(store.listProviders());
  let model = provider?.defaultModel || (provider && store.listAgents().find((a) => a.providerId === provider!.id)?.model) || '';
  if (!provider) {
    const discovered = await discoverDefaultModel(ctx);
    // Durante la espera otra petición (o el primer arranque) puede haber creado el proveedor o la bienvenida.
    const meanwhile = welcomeWorkflowId(store);
    if (meanwhile) return meanwhile;
    provider = preferredProvider(store.listProviders()) ?? createLocalProvider(ctx, discovered);
    model = provider.defaultModel || discovered;
  }
  return createWelcomeWorkflow(store, { providerId: provider.id, model: model || ctx.config.defaultModel || FALLBACK_MODEL }).id;
}

export async function seedIfEmpty(ctx: AppContext): Promise<boolean> {
  const { store } = ctx;
  if (store.listProviders().length || store.listAgents().length || store.listWorkflows().length) return false;

  const model = await discoverDefaultModel(ctx);
  const provider = createLocalProvider(ctx, model);
  // La bienvenida va primero: es lo primero que se ve en la lista de workflows.
  createWelcomeWorkflow(store, { providerId: provider.id, model });

  const base: Pick<AgentInput, 'providerId' | 'model' | 'maxTokens' | 'maxIterations' | 'thinking'> = {
    providerId: provider.id,
    model,
    maxTokens: 1200,
    maxIterations: 6,
    thinking: false,
  };

  const investigador = store.createAgent({
    ...base,
    name: 'Investigador',
    role: 'especialista en recopilar hechos y contexto',
    description: 'Reúne los datos, conceptos y antecedentes clave sobre un tema.',
    color: '#0ea5e9',
    temperature: 0.4,
    tools: [],
    systemPrompt:
      'Tu trabajo es reunir los hechos, conceptos y antecedentes más relevantes sobre el tema que te den. ' +
      'Responde en español con una lista de 5 a 7 puntos concretos y verificables. No des opiniones. Máximo 200 palabras.',
  });
  const analista = store.createAgent({
    ...base,
    name: 'Analista',
    role: 'analista crítico de riesgos y oportunidades',
    description: 'Evalúa ventajas, inconvenientes, riesgos y oportunidades.',
    color: '#f59e0b',
    temperature: 0.5,
    tools: [],
    systemPrompt:
      'Analizas un tema con espíritu crítico. Responde en español con dos apartados: "Oportunidades" y "Riesgos", ' +
      'con 3 puntos cada uno, razonados en una frase. Máximo 200 palabras.',
  });
  const redactor = store.createAgent({
    ...base,
    name: 'Redactor',
    role: 'redactor que convierte material en textos claros',
    description: 'Sintetiza el trabajo de otros agentes en el formato que pida la tarea.',
    color: '#8b5cf6',
    temperature: 0.7,
    tools: [],
    systemPrompt:
      'Redactas textos claros en español, en Markdown, a partir del material que te proporcionen. ' +
      'Sigue el formato, el tono y la extensión que pida la tarea; si no indica ninguno, responde con un texto breve y bien ordenado. ' +
      'Usa únicamente la información recibida; no inventes datos.',
  });
  const revisor = store.createAgent({
    ...base,
    name: 'Revisor',
    role: 'editor que controla la calidad',
    description: 'Revisa un borrador y decide si está listo para publicarse.',
    color: '#10b981',
    temperature: 0.2,
    maxTokens: 500,
    tools: [],
    systemPrompt:
      'Revisas borradores de informes. Tu respuesta debe empezar con una única palabra en mayúsculas: ' +
      'APROBADO si el borrador es claro, está completo y bien estructurado, o REVISAR si necesita cambios. ' +
      'Después, en un máximo de 3 puntos breves, justifica la decisión o indica los cambios concretos necesarios.',
  });

  const calculista = store.createAgent({
    ...base,
    name: 'Calculista',
    role: 'asistente numérico que nunca calcula de cabeza',
    description: 'Resuelve problemas numéricos usando la calculadora y consulta la fecha si hace falta.',
    color: '#ef4444',
    temperature: 0.1,
    tools: ['calculator', 'current_datetime'],
    systemPrompt:
      'Resuelves problemas numéricos en español. Haz cada operación con la herramienta calculator (nunca de cabeza) ' +
      'y explica brevemente los pasos y el resultado final.',
  });

  store.createWorkflow({
    name: 'Informe de investigación multiagente',
    description:
      'Dos agentes investigan y analizan el tema en paralelo, un redactor sintetiza el informe, un revisor lo evalúa y, si pide cambios, el redactor lo corrige.',
    settings: { ...DEFAULT_WORKFLOW_SETTINGS, maxConcurrency: 2, maxLlmCalls: 30 },
    nodes: [
      {
        id: 'tema',
        type: 'input',
        label: 'Tema',
        position: { x: 0, y: 160 },
        config: { description: 'Tema sobre el que elaborar el informe', defaultValue: 'El impacto de los agentes de IA en las pequeñas empresas' },
      },
      {
        id: 'investigar',
        type: 'agent',
        label: 'Investigar hechos',
        position: { x: 250, y: 40 },
        config: { agentId: investigador.id, prompt: 'Reúne los hechos y el contexto clave sobre este tema:\n\n{{input}}' },
      },
      {
        id: 'analizar',
        type: 'agent',
        label: 'Analizar riesgos',
        position: { x: 250, y: 280 },
        config: { agentId: analista.id, prompt: 'Analiza las oportunidades y los riesgos de este tema:\n\n{{input}}' },
      },
      {
        id: 'redactar',
        type: 'agent',
        label: 'Redactar informe',
        position: { x: 500, y: 160 },
        config: {
          agentId: redactor.id,
          prompt:
            'Escribe un informe ejecutivo sobre "{{input}}" usando este material. Estructura: título, resumen (2-3 frases), hallazgos clave, riesgos y oportunidades, y recomendación final. Máximo 350 palabras.\n\n## Hechos\n{{investigar}}\n\n## Análisis\n{{analizar}}',
        },
      },
      {
        id: 'revisar',
        type: 'agent',
        label: 'Revisar calidad',
        position: { x: 750, y: 160 },
        config: { agentId: revisor.id, prompt: 'Revisa este borrador de informe:\n\n{{redactar}}' },
      },
      {
        id: 'aprobado',
        type: 'condition',
        label: '¿Aprobado?',
        position: { x: 1000, y: 160 },
        config: { left: '{{revisar}}', operator: 'contains', right: 'APROBADO' },
      },
      {
        id: 'corregir',
        type: 'agent',
        label: 'Aplicar correcciones',
        position: { x: 1250, y: 290 },
        config: {
          agentId: redactor.id,
          prompt:
            'Reescribe el siguiente informe aplicando los cambios que pide el revisor. Devuelve solo el informe final.\n\n## Informe\n{{redactar}}\n\n## Comentarios del revisor\n{{revisar}}',
        },
      },
      { id: 'informe_aprobado', type: 'output', label: 'Informe aprobado', position: { x: 1250, y: 50 }, config: { template: '{{redactar}}' } },
      { id: 'informe_corregido', type: 'output', label: 'Informe corregido', position: { x: 1500, y: 290 }, config: { template: '{{corregir}}' } },
    ],
    edges: [
      { id: 'e1', source: 'tema', target: 'investigar' },
      { id: 'e2', source: 'tema', target: 'analizar' },
      { id: 'e3', source: 'investigar', target: 'redactar' },
      { id: 'e4', source: 'analizar', target: 'redactar' },
      { id: 'e5', source: 'redactar', target: 'revisar' },
      { id: 'e6', source: 'revisar', target: 'aprobado' },
      { id: 'e7', source: 'aprobado', target: 'informe_aprobado', sourceHandle: 'true' },
      { id: 'e8', source: 'aprobado', target: 'corregir', sourceHandle: 'false' },
      { id: 'e9', source: 'corregir', target: 'informe_corregido' },
    ],
  });

  store.createWorkflow({
    name: 'Cálculo con herramientas y archivo',
    description: 'Un agente resuelve un problema numérico con la calculadora y un nodo de herramienta guarda el resultado en el espacio de trabajo.',
    settings: { ...DEFAULT_WORKFLOW_SETTINGS, maxLlmCalls: 12 },
    nodes: [
      {
        id: 'problema',
        type: 'input',
        label: 'Problema',
        position: { x: 0, y: 80 },
        config: {
          description: 'Problema numérico a resolver',
          defaultValue:
            'Una factura tiene una base imponible de 1.284,50 € y un IVA del 21 %. ¿Cuál es el total? ¿Y cuánto paga cada socio si se reparte entre 3?',
        },
      },
      {
        id: 'resolver',
        type: 'agent',
        label: 'Resolver con calculadora',
        position: { x: 260, y: 80 },
        config: {
          agentId: calculista.id,
          prompt: 'Resuelve este problema paso a paso. Usa SIEMPRE la herramienta calculator para cada operación y explica el resultado:\n\n{{input}}',
        },
      },
      {
        id: 'guardar',
        type: 'tool',
        label: 'Guardar resultado',
        position: { x: 540, y: 180 },
        config: { tool: 'file_write', args: { path: 'resultados/calculo.md', content: '# Problema\n{{input}}\n\n# Solución\n{{resolver}}\n' } },
      },
      { id: 'resultado', type: 'output', label: 'Resultado', position: { x: 540, y: 0 }, config: { template: '{{resolver}}' } },
    ],
    edges: [
      { id: 'e1', source: 'problema', target: 'resolver' },
      { id: 'e2', source: 'resolver', target: 'guardar' },
      { id: 'e3', source: 'resolver', target: 'resultado' },
    ],
  });

  return true;
}
