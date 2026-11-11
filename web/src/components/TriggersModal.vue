<script setup lang="ts">
// Disparadores de un workflow: lo que lo lanza sin que nadie pulse «Ejecutar». Puede haber varios:
// cada cierto tiempo, ciertos días a una hora, con una expresión cron o al recibir un webhook.
import type { Trigger, TriggerInput, TriggerKind, TriggerPreview } from '@shared/types';
import { CalendarClock, CircleAlert, Copy, KeyRound, LoaderCircle, Pencil, Play, Plus, Trash2, Webhook } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api, ApiError, errorText } from '@/lib/api';
import { formatDateTime, relativeTime } from '@/lib/format';
import { describeTrigger, splitInterval, toMinutes, WEEKDAYS, type IntervalUnit } from '@/lib/transfer';
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
const curlExample = (id: string, secret: string): string => `curl -X POST "${hookUrl(id)}" -H "Authorization: Bearer ${secret}" -H "Content-Type: text/plain" --data "texto de entrada"`;

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    ui.success(`${what} en el portapapeles.`);
  } catch {
    ui.error('No se pudo copiar. Selecciona el texto y cópialo a mano.');
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

const toInput = (t: Trigger, patch: Partial<TriggerInput> = {}): TriggerInput => ({
  kind: t.kind,
  name: t.name,
  intervalMinutes: t.intervalMinutes,
  time: t.time,
  weekdays: t.weekdays,
  cron: t.cron,
  timezone: t.timezone,
  input: t.input,
  enabled: t.enabled,
  ...patch,
});

const toggle = (t: Trigger) =>
  act(`toggle:${t.id}`, async () => {
    await api.triggers.update(t.id, toInput(t, { enabled: !t.enabled }));
    await load();
  });

const remove = (t: Trigger) =>
  act(`remove:${t.id}`, async () => {
    const ok = await ui.confirm({
      title: 'Eliminar disparador',
      message: t.kind === 'webhook' ? 'Los programas que llamen a esta dirección dejarán de lanzar el workflow.' : `El workflow dejará de ejecutarse ${describeTrigger(t)}.`,
      confirmLabel: 'Eliminar disparador',
      danger: true,
    });
    if (!ok) return;
    await api.triggers.remove(t.id);
    if (revealed.value?.id === t.id) revealed.value = null;
    await load();
    ui.success('Disparador eliminado.');
  });

const runNow = (t: Trigger) =>
  act(`run:${t.id}`, async () => {
    const run = await api.triggers.runNow(t.id);
    emit('close');
    await router.push(`/runs/${run.id}`);
  });

const renewSecret = (t: Trigger) =>
  act(`secret:${t.id}`, async () => {
    const ok = await ui.confirm({
      title: 'Generar un secreto nuevo',
      message: 'El secreto actual dejará de valer en el acto: tendrás que cambiarlo en los programas que llaman a este webhook.',
      confirmLabel: 'Generar secreto',
      danger: true,
    });
    if (!ok) return;
    const renewed = await api.triggers.renewSecret(t.id);
    if (renewed.secret) revealed.value = { id: t.id, secret: renewed.secret };
    await load();
  });

// ---------- Formulario ----------
const KINDS: Array<{ kind: TriggerKind; label: string }> = [
  { kind: 'interval', label: 'Cada cierto tiempo' },
  { kind: 'daily', label: 'Días y hora' },
  { kind: 'cron', label: 'Cron' },
  { kind: 'webhook', label: 'Webhook' },
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

function openForm(t: Trigger | null): void {
  fieldErrors.value = {};
  formError.value = null;
  preview.value = null;
  Object.assign(form, { kind: 'interval', name: '', every: 60, unit: 'minutes', time: '09:00', weekdays: [], cron: '0 9 * * 1-5', timezone: '', input: props.defaultInput ?? '', enabled: true });
  if (t) {
    Object.assign(form, { kind: t.kind, name: t.name, weekdays: [...t.weekdays], timezone: t.timezone ?? '', input: t.input, enabled: t.enabled });
    if (t.intervalMinutes) Object.assign(form, { every: splitInterval(t.intervalMinutes).value, unit: splitInterval(t.intervalMinutes).unit });
    if (t.time) form.time = t.time;
    if (t.cron) form.cron = t.cron;
  }
  editing.value = t?.id ?? 'new';
}

const isNew = computed(() => editing.value === 'new');
const minutes = computed(() => toMinutes(Number(form.every), form.unit));
const intervalError = computed(() => {
  if (form.kind !== 'interval') return '';
  if (!Number.isFinite(minutes.value) || !Number.isInteger(Number(form.every)) || minutes.value < 1) return 'Indica un número entero de al menos 1 minuto.';
  return minutes.value > 43_200 ? 'El intervalo máximo son 30 días.' : '';
});
const timeError = computed(() => (form.kind === 'daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(form.time) ? 'Indica una hora válida (HH:MM).' : ''));
const cronError = computed(() => (form.kind === 'cron' && !form.cron.trim() ? 'Escribe la expresión cron.' : ''));
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
      ui.success(created.kind === 'webhook' ? 'Webhook creado. Copia ahora su secreto: no se volverá a mostrar.' : `«${props.workflowName}» se ejecutará ${describeTrigger(created)}.`);
    } else {
      const saved = await api.triggers.update(editing.value, payload());
      ui.success(saved.enabled ? 'Disparador guardado.' : 'Disparador guardado, pero desactivado.');
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
  <AppModal :title="editing ? (isNew ? `Nuevo disparador de «${workflowName}»` : 'Editar disparador') : `Disparadores de «${workflowName}»`" :width="640" @close="emit('close')">
    <div v-if="loading" class="col">
      <div class="skeleton" style="height: 34px" />
      <div class="skeleton" style="height: 84px" />
    </div>
    <div v-else-if="loadError" class="callout danger" role="alert"><CircleAlert /><span>{{ loadError }}</span></div>

    <!-- Lista -->
    <div v-else-if="!editing" class="col" style="gap: 14px">
      <p class="muted small">
        Un <Term id="disparador">disparador</Term> lanza el <Term id="workflow">workflow</Term> sin que nadie pulse «Ejecutar»: a ciertas horas o cuando otro programa llama a
        un <Term id="webhook">webhook</Term>. Los que tienen horario solo funcionan mientras AgentForge esté en marcha.
      </p>

      <div v-if="revealed" class="callout secret" role="status">
        <KeyRound />
        <div class="col" style="gap: 8px; min-width: 0">
          <strong>Secreto del webhook: cópialo ahora, no se volverá a mostrar.</strong>
          <code class="mono wrap-any" data-testid="webhook-secret">{{ revealed.secret }}</code>
          <div class="row wrap" style="gap: 6px">
            <button class="btn btn-sm" type="button" @click="copy(revealed.secret, 'Secreto copiado')"><Copy /> Copiar secreto</button>
            <button class="btn btn-sm" type="button" @click="copy(curlExample(revealed.id, revealed.secret), 'Ejemplo copiado')"><Copy /> Copiar ejemplo con curl</button>
            <button class="btn btn-ghost btn-sm" type="button" @click="revealed = null">Ya lo he guardado</button>
          </div>
        </div>
      </div>

      <ul v-if="triggers.length" class="list" aria-label="Disparadores del workflow">
        <li v-for="t in triggers" :key="t.id" class="item" :class="{ off: !t.enabled }">
          <div class="head">
            <component :is="t.kind === 'webhook' ? Webhook : CalendarClock" class="kind-icon" aria-hidden="true" />
            <div class="grow" style="min-width: 0">
              <strong class="wrap-any">{{ t.name || (t.kind === 'webhook' ? 'Webhook' : describeTrigger(t)) }}</strong>
              <div v-if="t.name" class="small muted wrap-any">{{ describeTrigger(t) }}</div>
            </div>
            <label class="check" :title="t.enabled ? 'Desactivar' : 'Activar'">
              <input type="checkbox" class="switch" :checked="t.enabled" :disabled="!!busy" :aria-label="`Disparador activo: ${t.name || describeTrigger(t)}`" @change="toggle(t)" />
            </label>
          </div>

          <div v-if="t.kind === 'webhook'" class="hook small">
            <code class="mono wrap-any">POST {{ hookUrl(t.id) }}</code>
            <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label="Copiar la dirección del webhook" title="Copiar la dirección" @click="copy(hookUrl(t.id), 'Dirección copiada')"><Copy /></button>
          </div>
          <div class="state small">
            <span v-if="t.kind !== 'webhook'">
              <span class="eyebrow">Próxima</span>
              <span v-if="t.enabled && t.nextRunAt" :title="relativeTime(t.nextRunAt)">{{ formatDateTime(t.nextRunAt) }}</span>
              <span v-else class="muted">{{ t.enabled ? 'Sin fecha' : 'En pausa' }}</span>
            </span>
            <span>
              <span class="eyebrow">Última</span>
              <RouterLink v-if="t.lastRunId && t.lastRunAt" :to="`/runs/${t.lastRunId}`" @click="emit('close')">{{ formatDateTime(t.lastRunAt) }}</RouterLink>
              <span v-else class="muted">Todavía ninguna</span>
            </span>
          </div>
          <p v-if="t.lastError" class="last-error small"><CircleAlert /> {{ t.lastError }}</p>

          <div class="row wrap actions">
            <button class="btn btn-sm" type="button" :disabled="!!busy" title="Lanza ahora una ejecución con la entrada guardada" @click="runNow(t)">
              <LoaderCircle v-if="busy === `run:${t.id}`" class="spin" /><Play v-else /> Ejecutar ahora
            </button>
            <button class="btn btn-sm" type="button" :disabled="!!busy" @click="openForm(t)"><Pencil /> Editar</button>
            <button v-if="t.kind === 'webhook'" class="btn btn-sm" type="button" :disabled="!!busy" @click="renewSecret(t)"><KeyRound /> Nuevo secreto</button>
            <span class="grow" />
            <button class="btn btn-ghost btn-icon btn-sm btn-danger" type="button" :disabled="!!busy" :aria-label="`Eliminar el disparador ${t.name || describeTrigger(t)}`" title="Eliminar" @click="remove(t)">
              <Trash2 />
            </button>
          </div>
        </li>
      </ul>
      <p v-else class="empty-note">Este workflow todavía no tiene disparadores: solo se ejecuta cuando lo lanzas tú.</p>
      <div v-if="listError" class="callout danger" role="alert"><CircleAlert /><span>{{ listError }}</span></div>
    </div>

    <!-- Formulario -->
    <form v-else id="trigger-form" class="col" style="gap: 16px" novalidate @submit.prevent="save">
      <div v-if="isNew" class="field">
        <span class="label">Qué lo dispara</span>
        <div class="segmented" role="radiogroup" aria-label="Tipo de disparador">
          <button v-for="k in KINDS" :key="k.kind" type="button" role="radio" :aria-checked="form.kind === k.kind" :class="{ active: form.kind === k.kind }" @click="form.kind = k.kind">
            {{ k.label }}
          </button>
        </div>
      </div>

      <div v-if="form.kind === 'interval'" class="field">
        <label for="trg-every">Repetir cada</label>
        <div class="row">
          <input id="trg-every" v-model.number="form.every" class="input num" type="number" min="1" step="1" style="width: 110px" :aria-invalid="!!(intervalError || fieldErrors.intervalMinutes)" />
          <select v-model="form.unit" class="select" style="width: auto" aria-label="Unidad del intervalo">
            <option value="minutes">minutos</option>
            <option value="hours">horas</option>
            <option value="days">días</option>
          </select>
        </div>
        <span v-if="intervalError || fieldErrors.intervalMinutes" class="error" role="alert">{{ intervalError || fieldErrors.intervalMinutes }}</span>
        <span v-else class="hint">El intervalo se cuenta desde que guardas.</span>
      </div>

      <template v-else-if="form.kind === 'daily'">
        <div class="field">
          <label for="trg-time">Hora</label>
          <input id="trg-time" v-model="form.time" class="input num" type="time" style="width: 140px" :aria-invalid="!!(timeError || fieldErrors.time)" />
          <span v-if="timeError || fieldErrors.time" class="error" role="alert">{{ timeError || fieldErrors.time }}</span>
        </div>
        <div class="field">
          <span class="label">Días</span>
          <div class="days" role="group" aria-label="Días de la semana">
            <button v-for="d in WEEKDAYS" :key="d.value" type="button" class="day" :class="{ active: form.weekdays.includes(d.value) }" :aria-pressed="form.weekdays.includes(d.value)" :aria-label="d.long" @click="toggleDay(d.value)">
              {{ d.short }}
            </button>
          </div>
          <span class="hint">{{ form.weekdays.length ? 'Solo los días marcados.' : 'Sin marcar ninguno, se ejecuta todos los días.' }}</span>
        </div>
      </template>

      <div v-else-if="form.kind === 'cron'" class="field">
        <label for="trg-cron">Expresión <Term id="cron">cron</Term></label>
        <input id="trg-cron" v-model="form.cron" class="input mono" type="text" spellcheck="false" autocomplete="off" placeholder="0 9 * * 1-5" :aria-invalid="!!(cronError || fieldErrors.cron || previewError)" />
        <span v-if="cronError || fieldErrors.cron || previewError" class="error" role="alert">{{ cronError || fieldErrors.cron || previewError }}</span>
        <span v-else class="hint">Cinco campos: minuto, hora, día del mes, mes y día de la semana. «0 9 * * 1-5» = de lunes a viernes a las 9:00.</span>
      </div>

      <p v-else class="callout small">
        <Webhook />
        <span>
          Al guardar se crea una dirección y un secreto. Cualquier programa que envíe un <code>POST</code> a esa dirección con el secreto lanza el workflow, y el
          cuerpo de la petición es su texto de entrada.
        </span>
      </p>

      <div v-if="form.kind === 'daily' || form.kind === 'cron'" class="field">
        <label for="trg-zone"><Term id="zona-horaria">Zona horaria</Term></label>
        <input id="trg-zone" v-model="form.timezone" class="input" type="text" list="trg-zones" spellcheck="false" autocomplete="off" :placeholder="`La del servidor (este navegador: ${browserZone})`" :aria-invalid="!!fieldErrors.timezone" />
        <datalist id="trg-zones"><option v-for="z in zones" :key="z" :value="z" /></datalist>
        <span v-if="fieldErrors.timezone" class="error" role="alert">{{ fieldErrors.timezone }}</span>
        <span v-else class="hint">Déjala vacía para usar la del equipo donde corre AgentForge. Con una zona, el cambio de hora de verano se aplica solo.</span>
      </div>

      <div v-if="preview && preview.next.length" class="preview small" aria-live="polite">
        <span class="eyebrow">Próximas ejecuciones ({{ preview.timezone }})</span>
        <ol>
          <li v-for="at in preview.next" :key="at">{{ formatDateTime(at) }}</li>
        </ol>
      </div>

      <div class="field">
        <label for="trg-name">Nombre <span class="muted">(opcional)</span></label>
        <input id="trg-name" v-model="form.name" class="input" type="text" maxlength="80" placeholder="Para distinguirlo si hay varios" />
      </div>

      <div class="field">
        <label for="trg-input">{{ form.kind === 'webhook' ? 'Entrada (plantilla)' : 'Entrada de cada ejecución' }}</label>
        <textarea id="trg-input" v-model="form.input" class="textarea" rows="3" :placeholder="form.kind === 'webhook' ? 'Vacía: el cuerpo de la petición tal cual' : 'Texto con el que arranca el workflow cada vez'" />
        <span v-if="form.kind === 'webhook'" class="hint">
          Escribe <code v-pre>{{body}}</code> donde deba ir el cuerpo de la petición. Si el cuerpo es <Term id="json">JSON</Term> con un campo <code>input</code>, se usa ese campo.
        </span>
      </div>

      <label class="check">
        <input v-model="form.enabled" type="checkbox" class="switch" />
        <span>
          <strong>Disparador activo</strong>
          <span class="muted small" style="display: block">Desactívalo para pausarlo sin perder la configuración.</span>
        </span>
      </label>

      <div v-if="formError" class="callout danger" role="alert"><CircleAlert /><span>{{ formError }}</span></div>
    </form>

    <template #footer>
      <template v-if="!editing">
        <button class="btn" type="button" style="margin-right: auto" :disabled="loading || !!loadError" @click="openForm(null)"><Plus /> Añadir disparador</button>
        <button class="btn btn-primary" type="button" @click="emit('close')">Hecho</button>
      </template>
      <template v-else>
        <button class="btn" type="button" @click="editing = null">Volver</button>
        <button class="btn btn-primary" type="submit" form="trigger-form" :disabled="saving || invalid">
          <LoaderCircle v-if="saving" class="spin" /> {{ isNew ? 'Crear disparador' : 'Guardar disparador' }}
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
