<script setup lang="ts">
import { Compass } from 'lucide-vue-next';
import { t } from '@/i18n';
</script>

<template>
  <div class="page">
    <div class="card empty">
      <Compass />
      <h1 class="empty-title">{{ t('notFound.title') }}</h1>
      <p>{{ t('notFound.text') }}</p>
      <RouterLink class="btn btn-primary" to="/">{{ t('notFound.back') }}</RouterLink>
    </div>
  </div>
</template>

<style scoped>
.empty-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
</style>
