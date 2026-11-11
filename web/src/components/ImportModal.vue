<script setup lang="ts">
// Revisión de una importación: qué trae el archivo, cómo encaja con lo que ya hay y qué hacer con cada elemento.
// Nada se crea hasta pulsar «Importar», y entonces entra todo o nada.
import type { ImportAction, ImportDecision, ImportItem, ImportItemKind, ImportPlan, ImportResult } from '@shared/types';
import { CircleAlert, LoaderCircle, TriangleAlert, Upload } from 'lucide-vue-next';
import { computed, onMounted, reactive, ref } from 'vue';
import { api, errorText } from '@/lib/api';
import AppModal from './AppModal.vue';
import Term from './Term.vue';

const props = defineProps<{ bundle: unknown; fileName: string }>();
const emit = defineEmits<{ close: []; done: [result: ImportResult] }>();

const loading = ref(true);
const loadError = ref<string | null>(null);
const plan = ref<ImportPlan | null>(null);
const decisions = reactive<Record<string, ImportDecision>>({});
const busy = ref(false);
const applyError = ref<string | null>(null);

onMounted(async () => {
  try {
    plan.value = await api.transfer.plan(props.bundle);
    for (const item of plan.value.items) decisions[item.key] = { action: item.recommended, targetId: item.recommendedTargetId };
  } catch (err) {
    loadError.value = errorText(err);
  } finally {
    loading.value = false;
  }
});

const KIND_LABEL: Record<ImportItemKind, string> = { provider: 'Proveedores', tool: 'Herramientas HTTP', agent: 'Agentes', workflow: 'Subworkflows' };
const KIND_ORDER: ImportItemKind[] = ['agent', 'workflow', 'tool', 'provider'];
const groups = computed(() =>
  KIND_ORDER.map((kind) => ({ kind, label: KIND_LABEL[kind], items: (plan.value?.items ?? []).filter((i) => i.kind === kind) })).filter((g) => g.items.length),
);

function actionLabel(item: ImportItem, action: ImportAction): string {
  const feminine = item.kind === 'tool';
  if (action === 'create') return item.match ? 'Crear una copia' : 'Crear';
  if (action === 'reuse') return item.kind === 'provider' ? 'Usar uno de aquí' : feminine ? 'Usar la de aquí' : 'Usar el de aquí';
  if (action === 'replace') return feminine ? 'Sustituir la de aquí' : 'Sustituir el de aquí';
  return 'No importar';
}
function status(item: ImportItem): { text: string; tone: string } {
  if (!item.match) return { text: item.kind === 'tool' ? 'Nueva' : 'Nuevo', tone: 'info' };
  return item.differs ? { text: 'Existe, pero es distinto', tone: 'warning' } : { text: 'Ya existe', tone: '' };
}
/** Al elegir «usar uno de aquí» en un proveedor sin coincidencia hace falta decir cuál. */
function onAction(item: ImportItem): void {
  const decision = decisions[item.key];
  if (item.kind === 'provider' && decision.action === 'reuse' && !decision.targetId) decision.targetId = item.match?.id ?? item.targets?.[0]?.id;
}

async function apply(): Promise<void> {
  if (busy.value || !plan.value) return;
  busy.value = true;
  applyError.value = null;
  try {
    emit('done', await api.transfer.apply(props.bundle, decisions));
  } catch (err) {
    applyError.value = errorText(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppModal :title="plan ? `Importar «${plan.name}»` : 'Importar'" :width="680" @close="emit('close')">
    <div v-if="loading" class="col">
      <div class="skeleton" style="height: 34px" />
      <div class="skeleton" style="height: 120px" />
    </div>
    <div v-else-if="loadError" class="callout danger" role="alert">
      <CircleAlert /><span><strong>No se puede importar «{{ fileName }}».</strong> {{ loadError }}</span>
    </div>

    <div v-else-if="plan" class="col" style="gap: 16px">
      <p class="muted small" style="margin: 0">
        <template v-if="plan.kind === 'workflow'">
          Se creará el <Term id="workflow">workflow</Term> <strong>{{ plan.name }}</strong
          ><template v-if="plan.items.length"> junto con lo que necesita. Revisa qué hacer con cada elemento: nada se crea hasta que pulses «Importar».</template
          ><template v-else>. No depende de nada más.</template>
        </template>
        <template v-else>Revisa qué hacer con cada elemento del archivo: nada se crea hasta que pulses «Importar».</template>
      </p>

      <div v-for="(warning, i) in plan.warnings" :key="i" class="callout warning small"><TriangleAlert /><span>{{ warning }}</span></div>

      <section v-for="g in groups" :key="g.kind" class="col" style="gap: 8px">
        <h3 class="eyebrow" style="margin: 0">{{ g.label }}</h3>
        <ul class="items" :aria-label="g.label">
          <li v-for="item in g.items" :key="item.key" class="item">
            <div class="row wrap head">
              <strong class="name">{{ item.name }}</strong>
              <span class="badge" :class="status(item).tone">{{ status(item).text }}</span>
              <span class="grow" />
              <select v-if="item.actions.length > 1" v-model="decisions[item.key].action" class="select" style="width: auto" :aria-label="`Qué hacer con ${item.name}`" @change="onAction(item)">
                <option v-for="action in item.actions" :key="action" :value="action">{{ actionLabel(item, action) }}</option>
              </select>
              <span v-else class="small muted">{{ actionLabel(item, item.actions[0]) }}</span>
              <select
                v-if="item.kind === 'provider' && decisions[item.key].action === 'reuse' && item.targets?.length"
                v-model="decisions[item.key].targetId"
                class="select"
                style="width: auto"
                :aria-label="`Proveedor de aquí para ${item.name}`"
              >
                <option v-for="t in item.targets" :key="t.id" :value="t.id">{{ t.name }}</option>
              </select>
            </div>
            <p v-for="(note, n) in item.notes" :key="n" class="small muted note">{{ note }}</p>
          </li>
        </ul>
      </section>

      <div v-if="applyError" class="callout danger" role="alert"><CircleAlert /><span>{{ applyError }}</span></div>
    </div>

    <template #footer>
      <button class="btn" type="button" @click="emit('close')">Cancelar</button>
      <button class="btn btn-primary" type="button" :disabled="loading || !plan || busy" @click="apply">
        <LoaderCircle v-if="busy" class="spin" /><Upload v-else /> Importar
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.items {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.item {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
}
.head {
  gap: 8px;
  align-items: center;
}
.name {
  overflow-wrap: anywhere;
}
.note {
  margin: 6px 0 0;
}
</style>
