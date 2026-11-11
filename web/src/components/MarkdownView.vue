<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { renderMarkdown } from '@/lib/markdown';

const props = defineProps<{ source: string }>();

// Mientras un modelo escribe, el texto cambia decenas de veces por segundo. Convertir y sanear TODO el Markdown
// en cada cambio cuesta cada vez más (el coste total crece con el cuadrado del tamaño) y deja la página sin
// responder en respuestas largas. Se pinta de inmediato el primer cambio y, mientras sigan llegando, como mucho
// uno cada RENDER_INTERVAL_MS; el último estado siempre se pinta.
const RENDER_INTERVAL_MS = 120;
const html = ref(renderMarkdown(props.source));
let lastRender = Date.now();
let timer: ReturnType<typeof setTimeout> | null = null;

function render(): void {
  timer = null;
  lastRender = Date.now();
  html.value = renderMarkdown(props.source);
}

watch(
  () => props.source,
  () => {
    if (timer) return;
    const wait = RENDER_INTERVAL_MS - (Date.now() - lastRender);
    if (wait <= 0) render();
    else timer = setTimeout(render, wait);
  },
);
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <!-- El HTML se sanea con DOMPurify en renderMarkdown antes de insertarse. -->
  <div class="md" v-html="html" />
</template>
