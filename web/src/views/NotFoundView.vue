<script setup lang="ts">
import { Compass } from 'lucide-vue-next';
</script>

<template>
  <div class="page">
    <div class="card empty">
      <Compass />
      <h1 class="empty-title">Esta página no existe</h1>
      <p>Puede que el enlace sea antiguo o que el elemento se haya eliminado.</p>
      <RouterLink class="btn btn-primary" to="/">Volver al panel</RouterLink>
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
