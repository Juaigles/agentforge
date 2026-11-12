<script setup lang="ts">
// Pantalla que pide la clave de acceso cuando el servidor la exige (AGENTFORGE_TOKEN). Sustituye a toda la
// aplicación: sin sesión no hay nada que mostrar. Con el Modo Yōkai el formulario es una caja de diálogo delante de la
// aldea, con la kitsune guardiana al lado; los campos y los textos son los mismos.
import { KeyRound, LoaderCircle } from 'lucide-vue-next';
import { nextTick, onMounted, ref } from 'vue';
import Term from '@/components/Term.vue';
import YokaiBackdrop from '@/components/YokaiBackdrop.vue';
import YokaiSprite from '@/components/YokaiSprite.vue';
import { t } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { yokaiOn } from '@/lib/skin';

const token = ref('');
const error = ref<string | null>(null);
const sending = ref(false);
const input = ref<HTMLInputElement | null>(null);

onMounted(() => input.value?.focus());

async function submit(): Promise<void> {
  if (!token.value.trim()) {
    error.value = t('accessGate.empty');
    return;
  }
  sending.value = true;
  error.value = null;
  try {
    await api.auth.login(token.value.trim());
    // Con la sesión iniciada se recarga: así se reabren los flujos en vivo y se cargan los datos desde cero.
    window.location.reload();
  } catch (err) {
    error.value = errorText(err);
    sending.value = false;
    await nextTick();
    input.value?.focus();
    input.value?.select();
  }
}
</script>

<template>
  <main class="gate" :class="{ 'yokai-scene': yokaiOn }">
    <YokaiBackdrop v-if="yokaiOn" :dim="0.3" />
    <div v-if="yokaiOn" class="yokai-guide" aria-hidden="true">
      <YokaiSprite species="kitsune" facing="right" :size="96" activity="idle" />
    </div>
    <form class="card gate-card" :class="{ 'yokai-dialog': yokaiOn }" novalidate @submit.prevent="submit">
      <div class="gate-icon" aria-hidden="true"><KeyRound /></div>
      <h1>AgentForge</h1>
      <i18n-t keypath="accessGate.intro" tag="p" class="muted" scope="global">
        <template #key
          ><Term id="clave-acceso">{{ t('accessGate.introKey') }}</Term></template
        >
        <template #variable><code>AGENTFORGE_TOKEN</code></template>
      </i18n-t>
      <p v-if="yokaiOn" class="yokai-line">{{ t('yokaiViews.gate.line') }}</p>
      <div class="field">
        <label for="gate-token">{{ t('accessGate.label') }}</label>
        <input
          id="gate-token"
          ref="input"
          v-model="token"
          class="input"
          type="password"
          autocomplete="current-password"
          :aria-invalid="error ? 'true' : undefined"
          :aria-describedby="error ? 'gate-error' : undefined"
        />
        <span v-if="error" id="gate-error" class="error" role="alert">{{ error }}</span>
      </div>
      <button class="btn btn-primary" type="submit" :disabled="sending">
        <LoaderCircle v-if="sending" class="spin" />
        {{ sending ? t('accessGate.checking') : t('accessGate.enter') }}
      </button>
    </form>
  </main>
</template>

<style scoped>
.gate {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px 16px;
  background: var(--bg);
}
.gate-card {
  width: min(400px, 100%);
  padding: 28px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.gate-icon {
  width: 40px;
  height: 40px;
  border-radius: var(--radius);
  display: grid;
  place-items: center;
  background: var(--accent-soft);
  color: var(--accent);
}
.gate-icon svg {
  width: 20px;
  height: 20px;
}
h1 {
  font-size: 19px;
  margin: 0;
}
p {
  margin: 0;
}

/* ---------- Modo Yōkai ---------- */
.yokai-scene {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px 16px;
}
.yokai-scene > .yokai-backdrop {
  z-index: -1;
}
.yokai-guide {
  flex: none;
  line-height: 0;
}
/* Caja de diálogo de RPG: fondo opaco del sistema, borde de 2 px, esquinas rectas y sombra dura. */
.yokai-dialog {
  border: 2px solid var(--text);
  border-radius: 0;
  box-shadow: 6px 6px 0 rgb(0 0 0 / 0.55);
}
.yokai-line {
  color: var(--text);
  font-style: italic;
}
</style>
