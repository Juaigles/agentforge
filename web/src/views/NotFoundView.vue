<script setup lang="ts">
import { Compass } from 'lucide-vue-next';
</script>

<template>
  <div class="page">
    <div class="card empty">
      <Compass />
      <h3>Esta página no existe</h3>
      <p>Puede que el enlace sea antiguo o que el elemento se haya eliminado.</p>
      <RouterLink class="btn btn-primary" to="/">Volver al panel</RouterLink>
    </div>
  </div>
</template>
