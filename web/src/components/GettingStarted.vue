<script setup lang="ts">
// Guía de primera sesión: tres pasos que se marcan solos (conectar un modelo, probar un agente, ejecutar un
// workflow). Se muestra en el Panel hasta completarla u ocultarla.
import { Check, CircleAlert, Copy, Play, RefreshCw, X } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Term from '@/components/Term.vue';
import { api } from '@/lib/api';
import { useCatalog } from '@/stores/catalog';
import { useRuns } from '@/stores/runs';
import { useUi } from '@/stores/ui';

const HIDDEN_KEY = 'agentforge.guide.hidden';

const catalog = useCatalog();
const runs = useRuns();
const ui = useUi();

const hidden = ref(localStorage.getItem(HIDDEN_KEY) === '1');
/** null mientras no se sabe (no se pinta la guía a medias para luego quitarla). */
const agentTried = ref<boolean | null>(null);
const workflowDone = ref<boolean | null>(null);
const testing = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

async function refresh(): Promise<void> {
  try {
    const [agentRuns, workflowRuns] = await Promise.all([api.runs.list({ kind: 'agent', limit: 1 }), api.runs.list({ kind: 'workflow', status: 'completed', limit: 1 })]);
    agentTried.value = agentRuns.total > 0;
    workflowDone.value = workflowRuns.total > 0;
  } catch {
    /* sin conexión: el aviso general ya lo dice */
  }
}
onMounted(refresh);
watch(
  () => runs.version,
  () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, 500);
  },
);
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});

const checking = computed(() => catalog.providers.length > 0 && !catalog.health.length);
const modelReady = computed(() => catalog.health.some((h) => h.ok));
const failing = computed(() => catalog.health.filter((h) => !h.ok));
/** Modelo que hay que descargar si el proveedor que falla es Ollama. */
const ollama = computed(() => {
  const provider = catalog.providers.find((p) => p.kind === 'ollama' && failing.value.some((h) => h.providerId === p.id));
  return provider ? { name: provider.name, command: `ollama pull ${provider.defaultModel || 'llama3.2'}` } : null;
});
const firstAgent = computed(() => catalog.agents[0] ?? null);
const firstWorkflow = computed(() => catalog.workflows[0] ?? null);

const known = computed(() => catalog.loaded && agentTried.value !== null && workflowDone.value !== null);
const doneCount = computed(() => [modelReady.value, agentTried.value, workflowDone.value].filter(Boolean).length);
const visible = computed(() => !hidden.value && known.value && doneCount.value < 3);

async function testConnection(): Promise<void> {
  testing.value = true;
  try {
    await catalog.refreshHealth(true);
    if (modelReady.value) ui.success('Conexión con el modelo comprobada.');
    else ui.info('El proveedor sigue sin responder.');
  } finally {
    testing.value = false;
  }
}

async function copyCommand(): Promise<void> {
  if (!ollama.value) return;
  try {
    await navigator.clipboard.writeText(ollama.value.command);
    ui.success('Comando copiado.');
  } catch {
    ui.info('No se pudo copiar: selecciona el comando y cópialo a mano.');
  }
}

function hide(): void {
  hidden.value = true;
  localStorage.setItem(HIDDEN_KEY, '1');
}
</script>

<template>
  <section v-if="visible" class="card guide" aria-labelledby="guide-title" data-testid="guide">
    <div class="card-head">
      <div>
        <h2 id="guide-title">Primeros pasos</h2>
        <p class="small muted" style="margin: 2px 0 0">{{ doneCount }} de 3 completados. Cada paso se marca solo cuando lo haces.</p>
      </div>
      <button class="btn btn-ghost btn-sm" type="button" @click="hide"><X /> Ocultar guía</button>
    </div>
    <ol class="steps">
      <li :class="{ done: modelReady }">
        <span class="mark" aria-hidden="true"><Check v-if="modelReady" /><template v-else>1</template></span>
        <div class="body">
          <h3>Conecta un modelo <span class="sr-only">({{ modelReady ? 'hecho' : 'pendiente' }})</span></h3>
          <p v-if="modelReady" class="small muted">Hay al menos un <Term id="proveedor">proveedor</Term> de <Term id="modelo">modelos</Term> que responde.</p>
          <p v-else-if="checking" class="small muted">Comprobando la conexión con el proveedor…</p>
          <template v-else>
            <p v-if="!catalog.providers.length" class="small">
              No hay ningún <Term id="proveedor">proveedor</Term> configurado. <RouterLink to="/settings">Añade uno en Ajustes</RouterLink>.
            </p>
            <p v-for="h in failing" :key="h.providerId" class="small problem"><CircleAlert aria-hidden="true" /> <span>«{{ h.name }}» no responde{{ h.error ? `: ${h.error}` : '.' }}</span></p>
            <template v-if="ollama">
              <p class="small">
                <Term id="ollama">Ollama</Term> ejecuta modelos en tu propio equipo, gratis y sin enviar datos fuera.
                <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer">Descárgalo e instálalo</a>, déjalo abierto y descarga el modelo con este comando en una terminal:
              </p>
              <div class="command">
                <code>{{ ollama.command }}</code>
                <button class="btn btn-sm" type="button" @click="copyCommand"><Copy /> Copiar</button>
              </div>
            </template>
            <p class="small">
              ¿Prefieres un servicio remoto? <RouterLink to="/settings">Añade en Ajustes un proveedor</RouterLink> con una API
              <Term id="openai-compatible">compatible con OpenAI</Term>.
            </p>
            <button class="btn btn-sm" type="button" :disabled="testing" @click="testConnection"><RefreshCw :class="{ spin: testing }" /> {{ testing ? 'Probando…' : 'Probar conexión' }}</button>
          </template>
        </div>
      </li>
      <li :class="{ done: agentTried }">
        <span class="mark" aria-hidden="true"><Check v-if="agentTried" /><template v-else>2</template></span>
        <div class="body">
          <h3>Prueba un agente <span class="sr-only">({{ agentTried ? 'hecho' : 'pendiente' }})</span></h3>
          <p class="small muted">Abre un <Term id="agente">agente</Term>, escríbele una tarea en su banco de pruebas y mira cómo responde.</p>
          <RouterLink v-if="!agentTried && firstAgent" class="btn btn-sm" :to="`/agents/${firstAgent.id}`">Abrir «{{ firstAgent.name }}»</RouterLink>
          <RouterLink v-else-if="!agentTried" class="btn btn-sm" to="/agents/new">Crear un agente</RouterLink>
        </div>
      </li>
      <li :class="{ done: workflowDone }">
        <span class="mark" aria-hidden="true"><Check v-if="workflowDone" /><template v-else>3</template></span>
        <div class="body">
          <h3>Ejecuta un workflow <span class="sr-only">({{ workflowDone ? 'hecho' : 'pendiente' }})</span></h3>
          <p class="small muted">Un <Term id="workflow">workflow</Term> encadena varios agentes. Ábrelo, pulsa «Ejecutar» y síguelo en vivo.</p>
          <RouterLink v-if="!workflowDone && firstWorkflow" class="btn btn-sm" :to="`/workflows/${firstWorkflow.id}`"><Play /> Abrir «{{ firstWorkflow.name }}»</RouterLink>
          <RouterLink v-else-if="!workflowDone" class="btn btn-sm" to="/workflows/new">Crear un workflow</RouterLink>
        </div>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.guide {
  margin-bottom: 16px;
}
.steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}
.steps li {
  display: flex;
  gap: 12px;
  min-width: 0;
  padding: 16px 18px;
  border-left: 1px solid var(--border);
}
.steps li:first-child {
  border-left: 0;
}
.mark {
  display: grid;
  place-items: center;
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 1.5px solid var(--control-border);
  color: var(--text-2);
  font-size: 12.5px;
  font-weight: 600;
}
.mark svg {
  width: 15px;
  height: 15px;
}
.done .mark {
  border-color: var(--success);
  background: var(--success);
  color: var(--surface);
}
.body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}
.body h3 {
  margin: 2px 0 0;
  font-size: 14px;
}
.body p {
  margin: 0;
  overflow-wrap: anywhere;
}
.problem {
  display: flex;
  gap: 6px;
  color: var(--danger);
}
.problem svg {
  width: 15px;
  height: 15px;
  flex: none;
  margin-top: 2px;
}
.command {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  max-width: 100%;
}
.command code {
  padding: 5px 9px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  border: 1px solid var(--border);
  overflow-wrap: anywhere;
}
@media (max-width: 980px) {
  .steps {
    grid-template-columns: minmax(0, 1fr);
  }
  .steps li {
    border-left: 0;
    border-top: 1px solid var(--border);
  }
  .steps li:first-child {
    border-top: 0;
  }
}
</style>
