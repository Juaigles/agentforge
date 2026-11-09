<script setup lang="ts">
import { initials } from '@/lib/format';

withDefaults(defineProps<{ name: string; color?: string; size?: number }>(), { color: '#6b7280', size: 32 });
</script>

<template>
  <span
    class="avatar"
    :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.38)}px`, background: `${color}22`, color, borderColor: `${color}55` }"
    aria-hidden="true"
    >{{ initials(name) }}</span
  >
</template>

<style scoped>
.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  border-radius: 9px;
  border: 1px solid;
  font-weight: 700;
  letter-spacing: 0.02em;
}
</style>
