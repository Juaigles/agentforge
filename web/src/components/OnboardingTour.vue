<script setup lang="ts">
// Recorrido guiado: capa NO modal con una tarjeta flotante anclada al elemento que se explica (un halo lo rodea).
// La aplicación sigue operable debajo, porque el usuario tiene que pulsar cosas reales (Ejecutar, Aprobar…).
// La tarjeta se coloca a mano (getBoundingClientRect) y se recoloca con el scroll, el tamaño de la ventana y un
// sondeo ligero para lo que se mueve sin avisar (el lienzo al desplazarse, vistas que cargan tarde). Sin ancla, o si
// no cabe, va centrada abajo; en pantallas estrechas es una hoja inferior.
// Con la piel yōkai, la tarjeta es una caja de diálogo de RPG con Kitsune de narradora y texto que se escribe solo.
import { ArrowLeft, ArrowRight, BookOpen, Bot, Check, Copy, LoaderCircle, Sparkles, X } from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { t } from '@/i18n';
import { canAdvance, copyFor, hasFact, pagePath, placeCard, type Placement, type Rect, type TourFact, type TourStep } from '@/lib/onboarding';
import { setSkin, skin, yokaiOn } from '@/lib/skin';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { useOnboarding } from '@/stores/onboarding';
import OnboardingSkinPicker from './OnboardingSkinPicker.vue';
import YokaiSprite from './YokaiSprite.vue';

const ob = useOnboarding();
const route = useRoute();
const router = useRouter();
const reduced = useReducedMotion();

const uid = useId();
const titleId = `tour-title-${uid}`;
const bodyId = `tour-body-${uid}`;

const card = ref<HTMLElement | null>(null);
const heading = ref<HTMLElement | null>(null);
const anchorEl = shallowRef<HTMLElement | null>(null);
const anchorRect = ref<Rect | null>(null);
const position = ref<{ placement: Placement; top: number; left: number }>({ placement: 'center', top: 0, left: 0 });
/** Hay un diálogo modal abierto (la aplicación está `inert`): la tarjeta se aparta y deja de recibir el puntero. */
const modalOpen = ref(false);
const announcement = ref('');

const step = computed<TourStep | undefined>(() => ob.step);
const copy = computed(() => (step.value ? copyFor(step.value, skin.value) : null));
const number = computed(() => ob.index + 1);
const total = computed(() => ob.steps.length);
const isLast = computed(() => number.value === total.value);
const facts = computed(() => ob.facts);

/** Ruta en la que se ve el paso (null: cualquiera, o falta el dato para construirla). */
const stepPath = computed(() => (step.value ? pagePath(step.value.page, ob.progress) : null));
/** El usuario está en la pantalla del paso. */
const onPage = computed(() => !step.value?.page || (stepPath.value !== null && route.path === stepPath.value));

const WAITING: Partial<Record<TourFact, string>> = {
  runStarted: 'onboarding.waiting.launch',
  approvalWaiting: 'onboarding.waiting.approval',
  runFinished: 'onboarding.waiting.finish',
};
/** Texto de espera mientras el hecho que el paso necesita no ha ocurrido. */
const waitingKey = computed(() => {
  const s = step.value;
  if (!s) return null;
  if (s.waitFor && !hasFact(facts.value, s.waitFor)) return WAITING[s.waitFor] ?? null;
  if (s.advance !== 'next' && !hasFact(facts.value, s.advance)) return WAITING[s.advance] ?? null;
  return null;
});
const nextEnabled = computed(() => !!step.value && canAdvance(step.value, facts.value));
/** Desde el paso de lanzar hasta el final de la ejecución, sin ningún modelo que responda: se dice y se ofrece salida. */
const noModel = computed(() => {
  const s = step.value;
  if (!s || !ob.modelKnown || ob.modelReady || facts.value.runStarted) return false;
  return s.advance === 'runStarted' || s.page === 'run';
});

// ---------- Texto con efecto máquina de escribir (solo yōkai y sin «reducir movimiento») ----------
const body = computed(() => (copy.value ? t(copy.value.bodyKey) : ''));
const typed = ref('');
const typing = ref(false);
let typeTimer: ReturnType<typeof setInterval> | null = null;
const typewriterOn = computed(() => yokaiOn.value && ob.progress.typewriter && !reduced.value);

function stopTyping(): void {
  if (typeTimer) clearInterval(typeTimer);
  typeTimer = null;
  typing.value = false;
  typed.value = body.value;
}
function startTyping(): void {
  stopTyping();
  if (!typewriterOn.value || !ob.open) return;
  const full = body.value;
  typed.value = '';
  typing.value = true;
  let i = 0;
  typeTimer = setInterval(() => {
    i = Math.min(full.length, i + 2);
    typed.value = full.slice(0, i);
    if (i >= full.length) stopTyping();
    else schedule();
  }, 22);
}
watch([body, typewriterOn, () => ob.open], startTyping, { immediate: true });

// ---------- Ancla y colocación ----------
function resolveAnchor(): HTMLElement | null {
  if (!copy.value || !onPage.value) return null;
  const shown = (el: Element | null): el is HTMLElement => !!el && el instanceof HTMLElement && el.getClientRects().length > 0;
  for (const name of copy.value.anchors) {
    const el = document.querySelector(`[data-tour="${name}"]`);
    if (shown(el)) return el;
  }
  if (copy.value.selector) {
    const el = document.querySelector(copy.value.selector);
    if (shown(el)) return el;
  }
  return null;
}

let observer: ResizeObserver | null = null;
let frame = 0;
const raf = (cb: () => void): number => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : (setTimeout(cb, 16) as unknown as number));

function update(): void {
  frame = 0;
  if (!ob.open) return;
  const app = typeof document !== 'undefined' ? document.getElementById('app') : null;
  modalOpen.value = !!app?.inert;
  const el = resolveAnchor();
  if (el !== anchorEl.value) {
    observer?.disconnect();
    anchorEl.value = el;
    if (observer) {
      if (el) observer.observe(el);
      if (card.value) observer.observe(card.value);
    }
  }
  const r = el?.getBoundingClientRect();
  anchorRect.value = r && r.width > 0 && r.height > 0 ? { top: r.top, left: r.left, width: r.width, height: r.height } : null;
  // Con un diálogo abierto, la tarjeta se coloca junto al diálogo (no encima), aunque el halo siga en el ancla.
  const modal = modalOpen.value ? document.querySelector('.modal')?.getBoundingClientRect() : undefined;
  const around = modal && modal.width > 0 ? { top: modal.top, left: modal.left, width: modal.width, height: modal.height } : anchorRect.value;
  const box = card.value?.getBoundingClientRect();
  position.value = placeCard(around, { width: box?.width || 360, height: box?.height || 200 }, { width: window.innerWidth, height: window.innerHeight });
  // Un nodo que este workflow no tiene (p. ej. «para cada»): con el lienzo ya pintado, el paso se salta solo.
  if (step.value?.skipIfMissing && !el && onPage.value && isMissing(step.value)) ob.next(isMissing);
}
function schedule(): void {
  if (!frame) frame = raf(update);
}

/** El ancla del paso no está aunque la pantalla ya está pintada (para los pasos que se saltan solos). */
function isMissing(s: TourStep): boolean {
  if (s.page === 'builder' && !document.querySelector('.vue-flow__node')) return false;
  const c = copyFor(s, skin.value);
  const found = c.anchors.some((a) => document.querySelector(`[data-tour="${a}"]`)) || (!!c.selector && !!document.querySelector(c.selector));
  return !found;
}

const haloStyle = computed(() => {
  const r = anchorRect.value;
  if (!r) return null;
  const pad = 6;
  return { top: `${r.top - pad}px`, left: `${r.left - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` };
});
const cardStyle = computed(() =>
  position.value.placement === 'sheet' ? {} : { top: `${Math.round(position.value.top)}px`, left: `${Math.round(position.value.left)}px` },
);

let poll: ReturnType<typeof setInterval> | null = null;
function listen(on: boolean): void {
  if (on) {
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    if (typeof ResizeObserver !== 'undefined' && !observer) observer = new ResizeObserver(schedule);
    poll ??= setInterval(schedule, 400);
  } else {
    window.removeEventListener('scroll', schedule, { capture: true });
    window.removeEventListener('resize', schedule);
    observer?.disconnect();
    observer = null;
    anchorEl.value = null;
    if (poll) clearInterval(poll);
    poll = null;
  }
}

/** Trae el ancla a la vista (salvo dentro del lienzo, que se desplaza con transformaciones, no con scroll). */
function reveal(): void {
  const el = resolveAnchor();
  if (!el || el.closest('.vue-flow')) return;
  const r = el.getBoundingClientRect();
  if (r.top >= 0 && r.bottom <= window.innerHeight) return;
  el.scrollIntoView?.({ block: 'center', behavior: reduced.value ? 'auto' : 'smooth' });
}

// ---------- Foco y anuncios ----------
let returnFocus: HTMLElement | null = null;
function focusHeading(): void {
  void nextTick(() => heading.value?.focus({ preventScroll: true }));
}
function announceStep(): void {
  if (!copy.value) return;
  announcement.value = t('onboarding.announce', { n: number.value, total: total.value, title: t(copy.value.titleKey) });
}

watch(
  () => ob.open,
  (open, was) => {
    listen(open);
    if (!open) return;
    returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    announceStep();
    void ob.syncRun();
    void nextTick(() => {
      update();
      reveal();
    });
    // Solo al abrirlo el usuario: un recorrido que sigue abierto tras recargar la página no roba el foco.
    if (was === false) focusHeading();
  },
  { immediate: true },
);
// Cambio de paso (también los que provoca un evento real): se anuncia, sin robar el foco si no venía de la tarjeta.
watch(
  () => step.value?.id,
  () => {
    if (!ob.open) return;
    announceStep();
    void nextTick(() => {
      update();
      reveal();
    });
  },
);
// La espera terminó (llegó la aprobación, terminó la ejecución): se lee el texto del paso.
watch(waitingKey, (key, before) => {
  if (ob.open && before && !key) announcement.value = body.value;
});
watch(
  () => route.path,
  () => void nextTick(schedule),
);

// ---------- Acciones ----------
async function goToPage(): Promise<void> {
  const s = step.value;
  if (!s?.page) return;
  if (s.page === 'builder' && !ob.progress.workflowId && !(await ob.ensureWorkflow())) return;
  const path = pagePath(s.page, ob.progress);
  if (path && route.path !== path) await router.push(path).catch(() => undefined);
}

async function go(delta: 1 | -1): Promise<void> {
  stopTyping();
  if (delta === 1 && isLast.value) return finish();
  if (delta === 1) ob.next(isMissing);
  else ob.back(isMissing);
  await goToPage();
  focusHeading();
}

function restoreFocus(): void {
  const target = returnFocus?.isConnected ? returnFocus : document.getElementById('contenido');
  target?.focus({ preventScroll: true });
}
function close(): void {
  ob.close();
  restoreFocus();
}
function skip(): void {
  ob.dismiss();
  restoreFocus();
}
function finish(): void {
  ob.finish();
  restoreFocus();
}
async function retryPrepare(): Promise<void> {
  if (await ob.ensureWorkflow()) await goToPage();
}
function jumpToEnd(): void {
  ob.goTo('finish');
  focusHeading();
}

function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  event.preventDefault();
  close();
}
// Esc también cierra cuando el foco no está en ningún control (en <body> o en el contenedor de la página).
function onDocumentKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented || !ob.open || modalOpen.value) return;
  const active = document.activeElement;
  if (active === document.body || active?.id === 'contenido') close();
}
onMounted(() => document.addEventListener('keydown', onDocumentKey));
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onDocumentKey);
  listen(false);
  if (typeTimer) clearInterval(typeTimer);
});

const narratorActivity = computed(() => (typing.value ? 'writing' : waitingKey.value ? 'waiting' : 'idle'));
</script>

<template>
  <Teleport to="body">
    <!-- La región de anuncios existe siempre, para que el lector de pantalla lea el primer cambio. -->
    <div class="sr-only" role="status" aria-live="polite" data-testid="onboarding-live">{{ ob.open ? announcement : '' }}</div>
    <div v-if="ob.open && step && copy" class="onboarding" :class="{ 'is-yokai': yokaiOn, 'behind-modal': modalOpen }" data-testid="onboarding">
      <div v-if="haloStyle" class="halo" :class="{ still: reduced }" :style="haloStyle" aria-hidden="true" data-testid="onboarding-halo" />
      <section
        ref="card"
        class="tour-card"
        :class="`at-${position.placement}`"
        :style="cardStyle"
        role="dialog"
        aria-modal="false"
        :aria-labelledby="titleId"
        :aria-describedby="bodyId"
        :inert="modalOpen || undefined"
        :data-placement="position.placement"
        :data-step="step.id"
        @keydown="onKey"
      >
        <div v-if="yokaiOn" class="narrator" aria-hidden="true">
          <YokaiSprite species="kitsune" :size="48" :activity="narratorActivity" />
        </div>
        <div class="content">
          <div class="top">
            <span class="count">{{ t('onboarding.progress', { n: number, total }) }}</span>
            <span v-if="yokaiOn" class="speaker">{{ t('onboarding.narrator') }}</span>
            <button class="icon-btn" type="button" :aria-label="t('onboarding.actions.close')" :title="t('onboarding.actions.close')" @click="close">
              <X aria-hidden="true" />
            </button>
          </div>
          <h2 :id="titleId" ref="heading" class="title" tabindex="-1">{{ t(copy.titleKey) }}</h2>
          <p :id="bodyId" class="body" @click="typing && stopTyping()">
            <template v-if="typing"
              ><span aria-hidden="true">{{ typed }}<span class="caret" /></span><span class="sr-only">{{ body }}</span></template
            >
            <template v-else>{{ body }}</template>
          </p>

          <OnboardingSkinPicker v-if="step.id === 'welcome'" />

          <div v-if="noModel" class="note danger" data-testid="onboarding-no-model">
            <strong>{{ t('onboarding.noModel.title') }}</strong>
            <span>{{ t('onboarding.noModel.body') }}</span>
            <span class="links">
              <RouterLink to="/">{{ t('onboarding.noModel.guide') }}</RouterLink>
              <RouterLink to="/settings">{{ t('onboarding.noModel.settings') }}</RouterLink>
              <button class="link-btn" type="button" @click="jumpToEnd">{{ t('onboarding.actions.skipToEnd') }}</button>
            </span>
          </div>
          <p v-else-if="waitingKey && onPage" class="note waiting"><LoaderCircle class="spin" aria-hidden="true" /> {{ t(waitingKey) }}</p>

          <p v-if="ob.preparing" class="note"><LoaderCircle class="spin" aria-hidden="true" /> {{ t('onboarding.preparing') }}</p>
          <div v-else-if="ob.prepareFailed && step.page === 'builder'" class="note danger">
            <span>{{ t('onboarding.prepareFailed') }}</span>
            <button class="link-btn" type="button" @click="retryPrepare">{{ t('onboarding.actions.retry') }}</button>
          </div>
          <div v-else-if="!onPage && step.page" class="note">
            <span>{{ t('onboarding.elsewhere') }}</span>
            <button class="link-btn" type="button" data-testid="onboarding-go" @click="goToPage">
              {{ step.page === 'builder' && !ob.progress.workflowId ? t('onboarding.actions.openWorkflow') : t('onboarding.actions.goThere') }}
            </button>
          </div>

          <nav v-if="step.id === 'finish'" class="next-links" :aria-label="t('onboarding.links.title')">
            <RouterLink to="/agents/new"><Bot aria-hidden="true" /> {{ t('onboarding.links.createAgent') }}</RouterLink>
            <RouterLink to="/workflows"><Copy aria-hidden="true" /> {{ t('onboarding.links.duplicate') }}</RouterLink>
            <RouterLink to="/glosario"><BookOpen aria-hidden="true" /> {{ t('onboarding.links.glossary') }}</RouterLink>
            <button class="link-btn" type="button" @click="setSkin(yokaiOn ? 'default' : 'yokai')">
              <Sparkles aria-hidden="true" /> {{ yokaiOn ? t('onboarding.links.toNormal') : t('onboarding.links.toYokai') }}
            </button>
          </nav>

          <div class="bar" aria-hidden="true"><span :style="{ width: `${(number / total) * 100}%` }" /></div>

          <div class="actions">
            <button v-if="!isLast" class="link-btn skip" type="button" data-testid="onboarding-skip" @click="skip">{{ t('onboarding.actions.skip') }}</button>
            <label v-if="yokaiOn && !reduced" class="typewriter">
              <input type="checkbox" :checked="ob.progress.typewriter" @change="ob.setTypewriter(($event.target as HTMLInputElement).checked)" />
              {{ t('onboarding.typewriter') }}
            </label>
            <span class="grow" />
            <button v-if="number > 1" class="btn btn-sm" type="button" data-testid="onboarding-back" @click="go(-1)">
              <ArrowLeft aria-hidden="true" /> {{ t('onboarding.actions.back') }}
            </button>
            <button v-if="isLast" class="btn btn-sm btn-primary" type="button" data-testid="onboarding-next" @click="finish">
              <Check aria-hidden="true" /> {{ t('onboarding.actions.finish') }}
            </button>
            <button v-else-if="nextEnabled" class="btn btn-sm btn-primary" type="button" data-testid="onboarding-next" @click="go(1)">
              {{ t('onboarding.actions.next') }} <ArrowRight aria-hidden="true" />
            </button>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.onboarding {
  /* Por encima de los diálogos (200) para seguir leyéndose junto a ellos; por debajo de los avisos (400). */
  position: fixed;
  inset: 0;
  z-index: 210;
  pointer-events: none;
}
.halo {
  position: fixed;
  border-radius: calc(var(--radius) + 4px);
  box-shadow:
    0 0 0 3px var(--accent),
    0 0 0 8px color-mix(in srgb, var(--accent) 25%, transparent);
  pointer-events: none;
  transition:
    top 0.18s ease,
    left 0.18s ease,
    width 0.18s ease,
    height 0.18s ease;
  animation: halo-pulse 1.8s ease-in-out infinite;
}
.halo.still {
  animation: none;
  transition: none;
}
@keyframes halo-pulse {
  50% {
    box-shadow:
      0 0 0 3px var(--accent),
      0 0 0 12px color-mix(in srgb, var(--accent) 12%, transparent);
  }
}
.tour-card {
  position: fixed;
  display: flex;
  gap: 12px;
  width: min(380px, calc(100vw - 24px));
  max-height: calc(100vh - 24px);
  overflow-y: auto;
  padding: 14px 16px 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--surface);
  color: var(--text);
  box-shadow: var(--shadow-lg);
  pointer-events: auto;
}
.behind-modal .tour-card {
  pointer-events: none;
}
.tour-card.at-sheet {
  inset: auto 0 0 0;
  width: auto;
  max-height: 60vh;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  border-bottom: 0;
  padding-bottom: max(12px, env(safe-area-inset-bottom));
}
.content {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.count {
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-2);
}
.speaker {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--accent);
}
.icon-btn {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  margin-left: auto;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-2);
  cursor: pointer;
}
.icon-btn:hover {
  background: var(--surface-2);
  color: var(--text);
}
.icon-btn svg {
  width: 16px;
  height: 16px;
}
.title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 16px;
  line-height: 1.3;
}
.title:focus {
  outline: none;
}
.title:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.body {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--text);
  overflow-wrap: anywhere;
}
.caret {
  display: inline-block;
  width: 0.5em;
  height: 1em;
  margin-left: 1px;
  vertical-align: -0.12em;
  background: currentColor;
  animation: caret-blink 0.8s steps(1) infinite;
}
@keyframes caret-blink {
  50% {
    opacity: 0;
  }
}
.note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  font-size: 12.5px;
  color: var(--text-2);
}
.note svg {
  width: 15px;
  height: 15px;
  flex: none;
}
.note.danger {
  flex-direction: column;
  align-items: flex-start;
  background: var(--danger-soft);
  color: var(--text);
}
.note.danger strong {
  color: var(--danger);
}
.note .links {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}
.next-links {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.next-links a,
.next-links .link-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.next-links svg {
  width: 15px;
  height: 15px;
  flex: none;
}
.link-btn {
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font: inherit;
  font-size: 12.5px;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.link-btn.skip {
  color: var(--text-2);
}
.bar {
  height: 3px;
  border-radius: 3px;
  background: var(--surface-2);
  overflow: hidden;
}
.bar span {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.2s ease;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.grow {
  flex: 1;
}
.typewriter {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  cursor: pointer;
}

/* ---------- Piel yōkai: caja de diálogo de RPG sobre el panel de madera, con la narradora a la izquierda ---------- */
.is-yokai .tour-card {
  border: 3px solid var(--yk-panel-border, #3d2614);
  border-radius: 0;
  background: var(--yk-panel, #5a3920);
  color: var(--yk-panel-text, #f7ecd4);
  box-shadow:
    inset 0 0 0 2px var(--yk-panel-control, #c9a978),
    var(--shadow-lg);
}
.is-yokai .tour-card.at-sheet {
  border-bottom: 0;
}
.is-yokai .narrator {
  flex: none;
  align-self: flex-start;
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  border: 2px solid var(--yk-panel-control, #c9a978);
  background: var(--yk-panel-2, #6b4628);
}
.is-yokai .count,
.is-yokai .typewriter,
.is-yokai .link-btn.skip {
  color: var(--yk-panel-text-2, #e6d4b0);
}
.is-yokai .speaker {
  color: var(--yk-gold, #e8b64c);
}
.is-yokai .icon-btn {
  color: var(--yk-panel-text-2, #e6d4b0);
}
.is-yokai .icon-btn:hover {
  background: var(--yk-panel-2, #6b4628);
  color: var(--yk-panel-text, #f7ecd4);
}
.is-yokai .body {
  color: var(--yk-panel-text, #f7ecd4);
  font-family: var(--font-mono);
  font-size: 13px;
}
.is-yokai .title {
  color: var(--yk-panel-text, #f7ecd4);
}
.is-yokai .link-btn,
.is-yokai .next-links a {
  color: var(--yk-gold, #e8b64c);
}
.is-yokai .note {
  background: var(--yk-panel-2, #6b4628);
  color: var(--yk-panel-text, #f7ecd4);
}
.is-yokai .note.danger {
  background: var(--yk-panel-2, #6b4628);
  outline: 2px solid var(--yk-panel-mark, #a8301f);
}
.is-yokai .note.danger strong {
  color: var(--yk-gold, #e8b64c);
}
.is-yokai .bar {
  border-radius: 0;
  background: var(--yk-panel-border, #3d2614);
}
.is-yokai .bar span {
  background: var(--yk-gold, #e8b64c);
}
.is-yokai .halo {
  border-radius: 0;
  box-shadow:
    0 0 0 3px var(--yk-gold, #e8b64c),
    0 0 0 6px var(--yk-ink, #1a2142);
}
.is-yokai .title:focus-visible {
  outline-color: var(--yk-gold, #e8b64c);
}

@media (max-width: 560px) {
  .is-yokai .narrator {
    width: 48px;
    height: 48px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .halo,
  .caret {
    animation: none;
  }
  .halo,
  .bar span {
    transition: none;
  }
}
</style>
