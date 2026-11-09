<script setup lang="ts">
import { nextTick, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { glossaryEntries } from '@/lib/glossary';

const entries = glossaryEntries();
const route = useRoute();

// El contenedor con scroll es <main>, así que el desplazamiento al término se hace a mano.
async function focusHash(): Promise<void> {
  if (!route.hash) return;
  await nextTick();
  document.getElementById(route.hash.slice(1))?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
onMounted(focusHash);
watch(() => route.hash, focusHash);
</script>

<template>
  <div class="page" style="max-width: 860px">
    <header class="page-header">
      <div>
        <h1>Glosario</h1>
        <p class="subtitle">
          En toda la aplicación, las palabras con subrayado de puntos muestran su definición al pasar el ratón, al enfocarlas o al tocarlas. Aquí
          están todas reunidas.
        </p>
      </div>
    </header>
    <section id="glosario" class="card card-pad">
      <dl class="glos">
        <div v-for="e in entries" :id="`g-${e.id}`" :key="e.id" :class="{ target: route.hash === `#g-${e.id}` }">
          <dt>{{ e.term }}</dt>
          <dd>{{ e.definition }}</dd>
        </div>
      </dl>
    </section>
  </div>
</template>

<style scoped>
.glos {
  margin: 0;
  display: flex;
  flex-direction: column;
}
.glos > div {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  gap: 4px 20px;
  padding: 11px 10px;
  border-bottom: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.glos > div:last-child {
  border-bottom: 0;
}
.glos > div.target {
  background: var(--accent-soft);
}
dt {
  font-weight: 650;
}
dd {
  margin: 0;
  color: var(--text-2);
}
@media (max-width: 600px) {
  .glos > div {
    grid-template-columns: 1fr;
  }
}
</style>
