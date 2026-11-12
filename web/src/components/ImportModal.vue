<script setup lang="ts">
// Revisión de una importación: qué trae el archivo, cómo encaja con lo que ya hay y qué hacer con cada elemento.
// Nada se crea hasta pulsar «Importar», y entonces entra todo o nada.
import type { ImportAction, ImportDecision, ImportItem, ImportItemKind, ImportPlan, ImportResult } from '@shared/types';
import { CircleAlert, LoaderCircle, TriangleAlert, Upload } from 'lucide-vue-next';
import { computed, onMounted, reactive, ref } from 'vue';
import { t } from '@/i18n';
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

const KIND_ORDER: ImportItemKind[] = ['agent', 'workflow', 'tool', 'provider'];
const groups = computed(() =>
  KIND_ORDER.map((kind) => ({ kind, label: t(`importModal.kind.${kind}`), items: (plan.value?.items ?? []).filter((i) => i.kind === kind) })).filter((g) => g.items.length),
);

function actionLabel(item: ImportItem, action: ImportAction): string {
  const feminine = item.kind === 'tool';
  if (action === 'create') return item.match ? t('importModal.action.createCopy') : t('importModal.action.create');
  if (action === 'reuse') return item.kind === 'provider' ? t('importModal.action.reuseProvider') : feminine ? t('importModal.action.reuseFeminine') : t('importModal.action.reuseMasculine');
  if (action === 'replace') return feminine ? t('importModal.action.replaceFeminine') : t('importModal.action.replaceMasculine');
  return t('importModal.action.skip');
}
function status(item: ImportItem): { text: string; tone: string } {
  if (!item.match) return { text: item.kind === 'tool' ? t('importModal.status.newFeminine') : t('importModal.status.newMasculine'), tone: 'info' };
  return item.differs ? { text: t('importModal.status.differs'), tone: 'warning' } : { text: t('importModal.status.exists'), tone: '' };
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
  <AppModal :title="plan ? t('importModal.title', { name: plan.name }) : t('common.actions.import')" :width="680" @close="emit('close')">
    <div v-if="loading" class="col">
      <div class="skeleton" style="height: 34px" />
      <div class="skeleton" style="height: 120px" />
    </div>
    <div v-else-if="loadError" class="callout danger" role="alert">
      <CircleAlert /><span><strong>{{ t('importModal.cannotImport', { fileName }) }}</strong> {{ loadError }}</span>
    </div>

    <div v-else-if="plan" class="col" style="gap: 16px">
      <i18n-t v-if="plan.kind === 'workflow' && plan.items.length" keypath="importModal.introWithItems" tag="p" class="muted small" style="margin: 0" scope="global">
        <template #workflow><Term id="workflow">{{ t('importModal.introWorkflow') }}</Term></template>
        <template #name><strong>{{ plan.name }}</strong></template>
      </i18n-t>
      <i18n-t v-else-if="plan.kind === 'workflow'" keypath="importModal.introAlone" tag="p" class="muted small" style="margin: 0" scope="global">
        <template #workflow><Term id="workflow">{{ t('importModal.introWorkflow') }}</Term></template>
        <template #name><strong>{{ plan.name }}</strong></template>
      </i18n-t>
      <p v-else class="muted small" style="margin: 0">{{ t('importModal.introFile') }}</p>

      <div v-for="(warning, i) in plan.warnings" :key="i" class="callout warning small"><TriangleAlert /><span>{{ warning }}</span></div>

      <section v-for="g in groups" :key="g.kind" class="col" style="gap: 8px">
        <h3 class="eyebrow" style="margin: 0">{{ g.label }}</h3>
        <ul class="items" :aria-label="g.label">
          <li v-for="item in g.items" :key="item.key" class="item">
            <div class="row wrap head">
              <strong class="name">{{ item.name }}</strong>
              <span class="badge" :class="status(item).tone">{{ status(item).text }}</span>
              <span class="grow" />
              <select v-if="item.actions.length > 1" v-model="decisions[item.key].action" class="select" style="width: auto" :aria-label="t('importModal.itemAria', { name: item.name })" @change="onAction(item)">
                <option v-for="action in item.actions" :key="action" :value="action">{{ actionLabel(item, action) }}</option>
              </select>
              <span v-else class="small muted">{{ actionLabel(item, item.actions[0]) }}</span>
              <select
                v-if="item.kind === 'provider' && decisions[item.key].action === 'reuse' && item.targets?.length"
                v-model="decisions[item.key].targetId"
                class="select"
                style="width: auto"
                :aria-label="t('importModal.providerAria', { name: item.name })"
              >
                <option v-for="target in item.targets" :key="target.id" :value="target.id">{{ target.name }}</option>
              </select>
            </div>
            <p v-for="(note, n) in item.notes" :key="n" class="small muted note">{{ note }}</p>
          </li>
        </ul>
      </section>

      <div v-if="applyError" class="callout danger" role="alert"><CircleAlert /><span>{{ applyError }}</span></div>
    </div>

    <template #footer>
      <button class="btn" type="button" @click="emit('close')">{{ t('common.actions.cancel') }}</button>
      <button class="btn btn-primary" type="button" :disabled="loading || !plan || busy" @click="apply">
        <LoaderCircle v-if="busy" class="spin" /><Upload v-else /> {{ t('common.actions.import') }}
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
