<script setup lang="ts">
import { computed } from 'vue';
import { renderMarkdown } from '@/lib/markdown';

const props = defineProps<{ source: string }>();
const html = computed(() => renderMarkdown(props.source));
</script>

<template>
  <!-- El HTML se sanea con DOMPurify en renderMarkdown antes de insertarse. -->
  <div class="md" v-html="html" />
</template>
