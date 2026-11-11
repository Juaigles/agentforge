<script setup lang="ts">
// Pantalla que pide la clave de acceso cuando el servidor la exige (AGENTFORGE_TOKEN). Sustituye a toda la
// aplicación: sin sesión no hay nada que mostrar.
import { KeyRound, LoaderCircle } from 'lucide-vue-next';
import { nextTick, onMounted, ref } from 'vue';
import Term from '@/components/Term.vue';
import { api, errorText } from '@/lib/api';

const token = ref('');
const error = ref<string | null>(null);
const sending = ref(false);
const input = ref<HTMLInputElement | null>(null);

onMounted(() => input.value?.focus());

async function submit(): Promise<void> {
  if (!token.value.trim()) {
    error.value = 'Escribe la clave de acceso.';
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
  <main class="gate">
    <form class="card gate-card" novalidate @submit.prevent="submit">
      <div class="gate-icon" aria-hidden="true"><KeyRound /></div>
      <h1>AgentForge</h1>
      <p class="muted">
        Este servidor exige una <Term id="clave-acceso">clave de acceso</Term>. Es la que se definió al arrancarlo, en la variable
        <code>AGENTFORGE_TOKEN</code>.
      </p>
      <div class="field">
        <label for="gate-token">Clave de acceso</label>
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
        {{ sending ? 'Comprobando…' : 'Entrar' }}
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
</style>
