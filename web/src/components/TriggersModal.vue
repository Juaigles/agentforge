<script setup lang="ts">
// Disparadores de un workflow: lo que lo lanza sin que nadie pulse «Ejecutar». Puede haber varios:
// cada cierto tiempo, ciertos días a una hora, con una expresión cron o al recibir un webhook.
import type { Trigger, TriggerInput, TriggerKind, TriggerPreview } from '@shared/types';
import { CalendarClock, CircleAlert, Copy, KeyRound, LoaderCircle, Pencil, Play, Plus, Trash2, Webhook } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api, ApiError, errorText } from '@/lib/api';
import { t } from '@/i18n';
import { formatDateTime, relativeTime } from '@/lib/format';
import { describeTrigger, splitInterval, toMinutes, weekdays, type IntervalUnit } from '@/lib/transfer';
import { useUi } from '@/stores/ui';
import AppModal from './AppModal.vue';
import Term from './Term.vue';

const props = defineProps<{ workflowId: string; workflowName: string; defaultInput?: string }>();
const emit = defineEmits<{ close: []; changed: [triggers: Trigger[]] }>();
const ui = useUi();
const router = useRouter();

const loading = ref(true);
const loadError = ref<string | null>(null);
const triggers = ref<Trigger[]>([]);
const busy = ref<string | null>(null);
const listError = ref<string | null>(null);
/** Secreto recién creado o regenerado: solo se puede ver ahora. */
const revealed = ref<{ id: string; secret: string } | null>(null);

async function load(): Promise<void> {
  try {
    triggers.value = await api.triggers.forWorkflow(props.workflowId);
    emit('changed', triggers.value);
  } catch (err) {
    loadError.value = errorText(err);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const hookUrl = (id: string): string => `${window.location.origin}/api/hooks/${id}`;
const curlExample = (id: string, secret: string): string =>
  `curl -X POST "${hookUrl(id)}" -H "Authorization: Bearer ${secret}" -H "Content-Type: text/plain" --data "${t('triggers.curlSample')}"`;

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    ui.success(t('triggers.toast.copied', { what }));
  } catch {
    ui.error(t('triggers.toast.copyFailed'));
  }
}

// ---------- Acciones sobre la lista ----------
async function act(key: string, fn: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = key;
  listError.value = null;
  try {
    await fn();
  } catch (err) {
    listError.value = errorText(err);
  } finally {
    busy.value = null;
  }
}

const toInput = (trigger: Trigger, patch: Partial<TriggerInput> = {}): TriggerInput => ({
  kind: trigger.kind,
  name: trigger.name,
  intervalMinutes: trigger.intervalMinutes,
  time: trigger.time,
  weekdays: trigger.weekdays,
  cron: trigger.cron,
  timezone: trigger.timezone,
  input: trigger.input,
  enabled: trigger.enabled,
  ...patch,
});

const toggle = (trigger: Trigger) =>
  act(`toggle:${trigger.id}`, async () => {
    await api.triggers.update(trigger.id, toInput(trigger, { enabled: !trigger.enabled }));
    await load();
  });

const remove = (trigger: Trigger) =>
  act(`remove:${trigger.id}`, async () => {
    const ok = await ui.confirm({
      title: t('triggers.confirm.deleteTitle'),
      message: trigger.kind === 'webhook' ? t('triggers.confirm.deleteWebhook') : t('triggers.confirm.deleteSchedule', { when: describeTrigger(trigger) }),
      confirmLabel: t('triggers.confirm.deleteTitle'),
      danger: true,
    });
    if (!ok) return;
    await api.triggers.remove(trigger.id);
    if (revealed.value?.id === trigger.id) revealed.value = null;
    await load();
    ui.success(t('triggers.toast.deleted'));
  });

const runNow = (trigger: Trigger) =>
  act(`run:${trigger.id}`, async () => {
    const run = await api.triggers.runNow(trigger.id);
    emit('close');
    await router.push(`/runs/${run.id}`);
  });

const renewSecret = (trigger: Trigger) =>
  act(`secret:${trigger.id}`, async () => {
    const ok = await ui.confirm({
      title: t('triggers.confirm.renewTitle'),
      message: t('triggers.confirm.renewMessage'),
      confirmLabel: t('triggers.confirm.renewConfirm'),
      danger: true,
    });
    if (!ok) return;
    const renewed = await api.triggers.renewSecret(trigger.id);
    if (renewed.secret) revealed.value = { id: trigger.id, secret: renewed.secret };
    await load();
  });

// ---------- Formulario ----------
const KINDS: Array<{ kind: TriggerKind; labelKey: string }> = [
  { kind: 'interval', labelKey: 'triggers.kind.interval' },
  { kind: 'daily', labelKey: 'triggers.kind.daily' },
  { kind: 'cron', labelKey: 'triggers.kind.cron' },
  { kind: 'webhook', labelKey: 'triggers.kind.webhook' },
];
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const zones: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return [browserZone];
  }
})();

/** null = lista; 'new' = alta; un id = edición. */
const editing = ref<string | null>(null);
const saving = ref(false);
const fieldErrors = ref<Record<string, string>>({});
const formError = ref<string | null>(null);
const form = reactive({
  kind: 'interval' as TriggerKind,
  name: '',
  every: 60,
  unit: 'minutes' as IntervalUnit,
  time: '09:00',
  weekdays: [] as number[],
  cron: '0 9 * * 1-5',
  timezone: '',
  input: '',
  enabled: true,
});

function openForm(trigger: Trigger | null): void {
  fieldErrors.value = {};
  formError.value = null;
  preview.value = null;
  Object.assign(form, {
    kind: 'interval',
    name: '',
    every: 60,
    unit: 'minutes',
    time: '09:00',
    weekdays: [],
    cron: '0 9 * * 1-5',
    timezone: '',
    input: props.defaultInput ?? '',
    enabled: true,
  });
  if (trigger) {
    Object.assign(form, {
      kind: trigger.kind,
      name: trigger.name,
      weekdays: [...trigger.weekdays],
      timezone: trigger.timezone ?? '',
      input: trigger.input,
      enabled: trigger.enabled,
    });
    if (trigger.intervalMinutes)
      Object.assign(form, { every: splitInterval(trigger.intervalMinutes).value, unit: splitInterval(trigger.intervalMinutes).unit });
    if (trigger.time) form.time = trigger.time;
    if (trigger.cron) form.cron = trigger.cron;
  }
  editing.value = trigger?.id ?? 'new';
}

const isNew = computed(() => editing.value === 'new');
const minutes = computed(() => toMinutes(Number(form.every), form.unit));
const intervalError = computed(() => {
  if (form.kind !== 'interval') return '';
  if (!Number.isFinite(minutes.value) || !Number.isInteger(Number(form.every)) || minutes.value < 1) return t('triggers.error.interval');
  return minutes.value > 43_200 ? t('triggers.error.intervalMax') : '';
});
const timeError = computed(() => (form.kind === 'daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(form.time) ? t('triggers.error.time') : ''));
const cronError = computed(() => (form.kind === 'cron' && !form.cron.trim() ? t('triggers.error.cron') : ''));
const invalid = computed(() => Boolean(intervalError.value || timeError.value || cronError.value));

function payload(): TriggerInput {
  const timed = form.kind === 'daily' || form.kind === 'cron';
  return {
    kind: form.kind,
    name: form.name.trim(),
    intervalMinutes: form.kind === 'interval' ? minutes.value : null,
    time: form.kind === 'daily' ? form.time : null,
    weekdays: form.kind === 'daily' ? [...form.weekdays].sort((a, b) => a - b) : [],
    cron: form.kind === 'cron' ? form.cron.trim() : null,
    timezone: timed && form.timezone.trim() ? form.timezone.trim() : null,
    input: form.input,
    enabled: form.enabled,
  };
}

// El error que devolvió el servidor para un campo deja de valer en cuanto se edita ese campo.
function clearFieldError(path: string): void {
  if (fieldErrors.value[path]) fieldErrors.value = Object.fromEntries(Object.entries(fieldErrors.value).filter(([key]) => key !== path));
}
watch(
  () => [form.every, form.unit],
  () => clearFieldError('intervalMinutes'),
);
watch(
  () => form.time,
  () => clearFieldError('time'),
);
watch(
  () => form.cron,
  () => clearFieldError('cron'),
);
watch(
  () => form.timezone,
  () => clearFieldError('timezone'),
);

function toggleDay(day: number): void {
  form.weekdays = form.weekdays.includes(day) ? form.weekdays.filter((d) => d !== day) : [...form.weekdays, day];
}

// Vista previa: las próximas ocasiones las calcula el servidor, que es quien las va a lanzar.
const preview = ref<TriggerPreview | null>(null);
const previewError = ref('');
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let previewSeq = 0;
watch(
  () => (editing.value && form.kind !== 'webhook' ? JSON.stringify([form.kind, minutes.value, form.time, form.weekdays, form.cron, form.timezone]) : ''),
  (key) => {
    clearTimeout(previewTimer);
    previewError.value = '';
    if (!key || invalid.value) return void (preview.value = null);
    const seq = ++previewSeq;
    previewTimer = setTimeout(async () => {
      try {
        const result = await api.triggers.preview(payload());
        if (seq === previewSeq) preview.value = result;
      } catch (err) {
        if (seq !== previewSeq) return;
        preview.value = null;
        previewError.value = err instanceof ApiError && err.issues.length ? err.issues[0].message : errorText(err);
      }
    }, 250);
  },
);
onBeforeUnmount(() => clearTimeout(previewTimer));

async function save(): Promise<void> {
  if (invalid.value || saving.value || !editing.value) return;
  saving.value = true;
  formError.value = null;
  fieldErrors.value = {};
  try {
    if (isNew.value) {
      const created = await api.triggers.create(props.workflowId, payload());
      if (created.secret) revealed.value = { id: created.id, secret: created.secret };
      ui.success(
        created.kind === 'webhook'
          ? t('triggers.toast.webhookCreated')
          : t('triggers.toast.scheduled', { name: props.workflowName, when: describeTrigger(created) }),
      );
    } else {
      const saved = await api.triggers.update(editing.value, payload());
      ui.success(saved.enabled ? t('triggers.toast.saved') : t('triggers.toast.savedOff'));
    }
    editing.value = null;
    await load();
  } catch (err) {
    if (err instanceof ApiError && err.issues.length) fieldErrors.value = Object.fromEntries(err.issues.map((i) => [i.path, i.message]));
    else formError.value = errorText(err);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <AppModal
    :title="editing ? (isNew ? t('triggers.title.new', { name: workflowName }) : t('triggers.title.edit')) : t('triggers.title.list', { name: workflowName })"
    :width="640"
    @close="emit('close')"
  >
    <div v-if="loading" class="col">
      <div class="skeleton" style="height: 34px" />
      <div class="skeleton" style="height: 84px" />
    </div>
    <div v-else-if="loadError" class="callout danger" role="alert">
      <CircleAlert /><span>{{ loadError }}</span>
    </div>

    <!-- Lista -->
    <div v-else-if="!editing" class="col" style="gap: 14px">
      <i18n-t keypath="triggers.intro" tag="p" class="muted small" scope="global">
        <template #trigger
          ><Term id="disparador">{{ t('triggers.introTrigger') }}</Term></template
        >
        <template #workflow
          ><Term id="workflow">{{ t('triggers.introWorkflow') }}</Term></template
        >
        <template #webhook
          ><Term id="webhook">{{ t('triggers.introWebhook') }}</Term></template
        >
      </i18n-t>

      <div v-if="revealed" class="callout secret" role="status">
        <KeyRound />
        <div class="col" style="gap: 8px; min-width: 0">
          <strong>{{ t('triggers.secret.title') }}</strong>
          <code class="mono wrap-any" data-testid="webhook-secret">{{ revealed.secret }}</code>
          <div class="row wrap" style="gap: 6px">
            <button class="btn btn-sm" type="button" @click="copy(revealed.secret, t('triggers.secret.copiedSecret'))">
              <Copy /> {{ t('triggers.secret.copySecret') }}
            </button>
            <button class="btn btn-sm" type="button" @click="copy(curlExample(revealed.id, revealed.secret), t('triggers.secret.copiedExample'))">
              <Copy /> {{ t('triggers.secret.copyExample') }}
            </button>
            <button class="btn btn-ghost btn-sm" type="button" @click="revealed = null">{{ t('triggers.secret.saved') }}</button>
          </div>
        </div>
      </div>

      <ul v-if="triggers.length" class="list" :aria-label="t('triggers.listAria')">
        <li v-for="trg in triggers" :key="trg.id" class="item" :class="{ off: !trg.enabled }">
          <div class="head">
            <component :is="trg.kind === 'webhook' ? Webhook : CalendarClock" class="kind-icon" aria-hidden="true" />
            <div class="grow" style="min-width: 0">
              <strong class="wrap-any">{{ trg.name || (trg.kind === 'webhook' ? t('triggers.kind.webhook') : describeTrigger(trg)) }}</strong>
              <div v-if="trg.name" class="small muted wrap-any">{{ describeTrigger(trg) }}</div>
            </div>
            <label class="check" :title="trg.enabled ? t('triggers.turnOff') : t('triggers.turnOn')">
              <input
                type="checkbox"
                class="switch"
                :checked="trg.enabled"
                :disabled="!!busy"
                :aria-label="t('triggers.activeAria', { name: trg.name || describeTrigger(trg) })"
                @change="toggle(trg)"
              />
            </label>
          </div>

          <div v-if="trg.kind === 'webhook'" class="hook small">
            <code class="mono wrap-any">POST {{ hookUrl(trg.id) }}</code>
            <button
              class="btn btn-ghost btn-icon btn-sm"
              type="button"
              :aria-label="t('triggers.copyAddressAria')"
              :title="t('triggers.copyAddress')"
              @click="copy(hookUrl(trg.id), t('triggers.copiedAddress'))"
            >
              <Copy />
            </button>
          </div>
          <div class="state small">
            <span v-if="trg.kind !== 'webhook'">
              <span class="eyebrow">{{ t('triggers.next') }}</span>
              <span v-if="trg.enabled && trg.nextRunAt" :title="relativeTime(trg.nextRunAt)">{{ formatDateTime(trg.nextRunAt) }}</span>
              <span v-else class="muted">{{ trg.enabled ? t('triggers.noDate') : t('triggers.paused') }}</span>
            </span>
            <span>
              <span class="eyebrow">{{ t('triggers.last') }}</span>
              <RouterLink v-if="trg.lastRunId && trg.lastRunAt" :to="`/runs/${trg.lastRunId}`" @click="emit('close')">{{
                formatDateTime(trg.lastRunAt)
              }}</RouterLink>
              <span v-else class="muted">{{ t('triggers.never') }}</span>
            </span>
          </div>
          <p v-if="trg.lastError" class="last-error small"><CircleAlert /> {{ trg.lastError }}</p>

          <div class="row wrap actions">
            <button class="btn btn-sm" type="button" :disabled="!!busy" :title="t('triggers.runNowTitle')" @click="runNow(trg)">
              <LoaderCircle v-if="busy === `run:${trg.id}`" class="spin" /><Play v-else /> {{ t('triggers.runNow') }}
            </button>
            <button class="btn btn-sm" type="button" :disabled="!!busy" @click="openForm(trg)"><Pencil /> {{ t('common.actions.edit') }}</button>
            <button v-if="trg.kind === 'webhook'" class="btn btn-sm" type="button" :disabled="!!busy" @click="renewSecret(trg)">
              <KeyRound /> {{ t('triggers.newSecret') }}
            </button>
            <span class="grow" />
            <button
              class="btn btn-ghost btn-icon btn-sm btn-danger"
              type="button"
              :disabled="!!busy"
              :aria-label="t('triggers.deleteAria', { name: trg.name || describeTrigger(trg) })"
              :title="t('common.actions.delete')"
              @click="remove(trg)"
            >
              <Trash2 />
            </button>
          </div>
        </li>
      </ul>
      <p v-else class="empty-note">{{ t('triggers.emptyNote') }}</p>
      <div v-if="listError" class="callout danger" role="alert">
        <CircleAlert /><span>{{ listError }}</span>
      </div>
    </div>

    <!-- Formulario -->
    <form v-else id="trigger-form" class="col" style="gap: 16px" novalidate @submit.prevent="save">
      <div v-if="isNew" class="field">
        <span class="label">{{ t('triggers.whatTriggers') }}</span>
        <div class="segmented" role="radiogroup" :aria-label="t('triggers.kindAria')">
          <button
            v-for="k in KINDS"
            :key="k.kind"
            type="button"
            role="radio"
            :aria-checked="form.kind === k.kind"
            :class="{ active: form.kind === k.kind }"
            @click="form.kind = k.kind"
          >
            {{ t(k.labelKey) }}
          </button>
        </div>
      </div>

      <div v-if="form.kind === 'interval'" class="field">
        <label for="trg-every">{{ t('triggers.repeatEvery') }}</label>
        <div class="row">
          <input
            id="trg-every"
            v-model.number="form.every"
            class="input num"
            type="number"
            min="1"
            step="1"
            style="width: 110px"
            :aria-invalid="!!(intervalError || fieldErrors.intervalMinutes)"
          />
          <select v-model="form.unit" class="select" style="width: auto" :aria-label="t('triggers.unitAria')">
            <option value="minutes">{{ t('triggers.unit.minutes') }}</option>
            <option value="hours">{{ t('triggers.unit.hours') }}</option>
            <option value="days">{{ t('triggers.unit.days') }}</option>
          </select>
        </div>
        <span v-if="intervalError || fieldErrors.intervalMinutes" class="error" role="alert">{{ intervalError || fieldErrors.intervalMinutes }}</span>
        <span v-else class="hint">{{ t('triggers.intervalHint') }}</span>
      </div>

      <template v-else-if="form.kind === 'daily'">
        <div class="field">
          <label for="trg-time">{{ t('triggers.time') }}</label>
          <input id="trg-time" v-model="form.time" class="input num" type="time" style="width: 140px" :aria-invalid="!!(timeError || fieldErrors.time)" />
          <span v-if="timeError || fieldErrors.time" class="error" role="alert">{{ timeError || fieldErrors.time }}</span>
        </div>
        <div class="field">
          <span class="label">{{ t('triggers.days') }}</span>
          <div class="days" role="group" :aria-label="t('triggers.daysAria')">
            <button
              v-for="d in weekdays()"
              :key="d.value"
              type="button"
              class="day"
              :class="{ active: form.weekdays.includes(d.value) }"
              :aria-pressed="form.weekdays.includes(d.value)"
              :aria-label="d.long"
              @click="toggleDay(d.value)"
            >
              {{ d.short }}
            </button>
          </div>
          <span class="hint">{{ form.weekdays.length ? t('triggers.daysSelected') : t('triggers.daysNone') }}</span>
        </div>
      </template>

      <div v-else-if="form.kind === 'cron'" class="field">
        <i18n-t keypath="triggers.cronLabel" tag="label" for="trg-cron" scope="global">
          <template #cron
            ><Term id="cron">{{ t('triggers.cronTerm') }}</Term></template
          >
        </i18n-t>
        <input
          id="trg-cron"
          v-model="form.cron"
          class="input mono"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder="0 9 * * 1-5"
          :aria-invalid="!!(cronError || fieldErrors.cron || previewError)"
        />
        <span v-if="cronError || fieldErrors.cron || previewError" class="error" role="alert">{{ cronError || fieldErrors.cron || previewError }}</span>
        <span v-else class="hint">{{ t('triggers.cronHint') }}</span>
      </div>

      <p v-else class="callout small">
        <Webhook />
        <i18n-t keypath="triggers.webhookNote" tag="span" scope="global">
          <template #post><code>POST</code></template>
        </i18n-t>
      </p>

      <div v-if="form.kind === 'daily' || form.kind === 'cron'" class="field">
        <label for="trg-zone"
          ><Term id="zona-horaria">{{ t('triggers.zone') }}</Term></label
        >
        <input
          id="trg-zone"
          v-model="form.timezone"
          class="input"
          type="text"
          list="trg-zones"
          spellcheck="false"
          autocomplete="off"
          :placeholder="t('triggers.zonePlaceholder', { zone: browserZone })"
          :aria-invalid="!!fieldErrors.timezone"
        />
        <datalist id="trg-zones"><option v-for="z in zones" :key="z" :value="z" /></datalist>
        <span v-if="fieldErrors.timezone" class="error" role="alert">{{ fieldErrors.timezone }}</span>
        <span v-else class="hint">{{ t('triggers.zoneHint') }}</span>
      </div>

      <div v-if="preview && preview.next.length" class="preview small" aria-live="polite">
        <span class="eyebrow">{{ t('triggers.upcoming', { zone: preview.timezone }) }}</span>
        <ol>
          <li v-for="at in preview.next" :key="at">{{ formatDateTime(at) }}</li>
        </ol>
      </div>

      <div class="field">
        <label for="trg-name"
          >{{ t('triggers.name') }} <span class="muted">{{ t('triggers.optional') }}</span></label
        >
        <input id="trg-name" v-model="form.name" class="input" type="text" maxlength="80" :placeholder="t('triggers.namePlaceholder')" />
      </div>

      <div class="field">
        <label for="trg-input">{{ form.kind === 'webhook' ? t('triggers.inputTemplate') : t('triggers.inputEach') }}</label>
        <textarea
          id="trg-input"
          v-model="form.input"
          class="textarea"
          rows="3"
          :placeholder="form.kind === 'webhook' ? t('triggers.inputPlaceholderWebhook') : t('triggers.inputPlaceholder')"
        />
        <i18n-t v-if="form.kind === 'webhook'" keypath="triggers.inputHint" tag="span" class="hint" scope="global">
          <template #body
            ><code v-pre>{{ body }}</code></template
          >
          <template #json><Term id="json">JSON</Term></template>
          <template #input><code>input</code></template>
        </i18n-t>
      </div>

      <label class="check">
        <input v-model="form.enabled" type="checkbox" class="switch" />
        <span>
          <strong>{{ t('triggers.active') }}</strong>
          <span class="muted small" style="display: block">{{ t('triggers.activeHint') }}</span>
        </span>
      </label>

      <div v-if="formError" class="callout danger" role="alert">
        <CircleAlert /><span>{{ formError }}</span>
      </div>
    </form>

    <template #footer>
      <template v-if="!editing">
        <button class="btn" type="button" style="margin-right: auto" :disabled="loading || !!loadError" @click="openForm(null)">
          <Plus /> {{ t('triggers.add') }}
        </button>
        <button class="btn btn-primary" type="button" @click="emit('close')">{{ t('triggers.done') }}</button>
      </template>
      <template v-else>
        <button class="btn" type="button" @click="editing = null">{{ t('common.actions.back') }}</button>
        <button class="btn btn-primary" type="submit" form="trigger-form" :disabled="saving || invalid">
          <LoaderCircle v-if="saving" class="spin" /> {{ isNew ? t('triggers.create') : t('triggers.saveTrigger') }}
        </button>
      </template>
    </template>
  </AppModal>
</template>

<style scoped>
.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
}
.item.off .head strong {
  color: var(--text-2);
}
.head {
  display: flex;
  gap: 10px;
  align-items: center;
}
.kind-icon {
  width: 18px;
  height: 18px;
  flex: none;
  color: var(--text-2);
}
.hook {
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
}
.state {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 20px;
}
.state > span {
  display: inline-flex;
  gap: 6px;
  align-items: baseline;
}
.actions {
  gap: 6px;
}
.wrap-any {
  overflow-wrap: anywhere;
}
.last-error {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin: 0;
  color: var(--danger);
}
.last-error svg {
  width: 14px;
  height: 14px;
  flex: none;
  margin-top: 2px;
}
.empty-note {
  margin: 0;
  padding: 18px 14px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  color: var(--text-2);
  text-align: center;
}
.secret {
  align-items: flex-start;
}
.days {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.day {
  min-width: 40px;
  height: 34px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
.day.active {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-text);
}
.preview {
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
}
.preview ol {
  margin: 4px 0 0;
  padding-left: 20px;
}
</style>
