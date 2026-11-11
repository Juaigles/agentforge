<script setup lang="ts">
import type { RunStatus, StepStatus } from '@shared/types';
import { Ban, Check, CircleDashed, Clock, Hourglass, LoaderCircle, SkipForward, X } from 'lucide-vue-next';
import { computed } from 'vue';
import { STATUS_LABEL, STATUS_TONE } from '@/lib/format';

const props = defineProps<{ status: RunStatus | StepStatus; iconOnly?: boolean }>();
const ICONS = { queued: Clock, pending: CircleDashed, running: LoaderCircle, waiting: Hourglass, completed: Check, failed: X, cancelled: Ban, skipped: SkipForward };
const icon = computed(() => ICONS[props.status]);
</script>

<template>
  <span class="badge" :class="[STATUS_TONE[status], { 'icon-only': iconOnly }]" :title="iconOnly ? STATUS_LABEL[status] : undefined">
    <component :is="icon" :class="{ spin: status === 'running' }" aria-hidden="true" />
    <span :class="{ 'sr-only': iconOnly }">{{ STATUS_LABEL[status] }}</span>
  </span>
</template>

<style scoped>
.icon-only {
  width: 22px;
  padding: 0;
  justify-content: center;
}
</style>
