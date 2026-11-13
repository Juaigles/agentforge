// @vitest-environment jsdom
// Tarjeta del recorrido guiado: los dos guiones según la piel, navegación con teclado, Esc, colocación con y sin
// ancla, avance por un evento real y textos completos en español e inglés.
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import type { Router } from 'vue-router';
import { setLocale } from '@/i18n';
import { stepsFor, TOUR_STEPS } from '@/lib/onboarding';
import { setSkin } from '@/lib/skin';
import { useOnboarding } from '@/stores/onboarding';
import { useRuns } from '@/stores/runs';
import { freshPinia, testRouter, until } from '@/test/harness';
import OnboardingTour from './OnboardingTour.vue';

let wrapper: VueWrapper | null = null;
let router: Router;

/** Preferencia «reducir movimiento» del sistema simulada (jsdom no implementa matchMedia). */
function setReducedMotion(reduce: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('reduce') ? reduce : false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

async function open(stepId = 'welcome', extra: Record<string, unknown> = {}) {
  const pinia = freshPinia();
  router = testRouter();
  await router.push('/');
  await router.isReady();
  const ob = useOnboarding();
  ob.startTour();
  ob.progress = { ...ob.progress, stepId, ...extra };
  wrapper = mount(OnboardingTour, { global: { plugins: [pinia, router] }, attachTo: document.body });
  await nextTick();
  await nextTick();
  return ob;
}
const tourCard = () => document.querySelector<HTMLElement>('.tour-card');
const text = () => tourCard()?.textContent ?? '';
const press = (testid: string) => document.querySelector<HTMLElement>(`[data-testid="${testid}"]`)!.click();

beforeEach(() => {
  localStorage.clear();
  setReducedMotion(true);
  setSkin('default');
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  setSkin('default');
  setLocale('es', false);
});

describe('OnboardingTour', () => {
  it('guion normal: diálogo no modal, sobrio, con progreso y la elección de presentación', async () => {
    await open();
    const card = tourCard()!;
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.getAttribute('aria-modal')).toBe('false');
    expect(text()).toContain('Bienvenido a AgentForge');
    expect(text()).toContain(`Paso 1 de ${stepsFor('default').length}`);
    expect(document.querySelector('.narrator')).toBeNull();
    expect(document.querySelector('[data-testid="onboarding-skins"]')).not.toBeNull();
    // Sin «Atrás» en el primer paso.
    expect(document.querySelector('[data-testid="onboarding-back"]')).toBeNull();
  });

  it('guion yōkai: caja de RPG con Kitsune de narradora y otra voz', async () => {
    setSkin('yokai');
    await open();
    expect(document.querySelector('.onboarding.is-yokai')).not.toBeNull();
    expect(document.querySelector('.narrator .yokai-sprite.is-kitsune')).not.toBeNull();
    expect(text()).toContain('¡Bienvenido a la oficina!');
    expect(text()).toContain(`Paso 1 de ${stepsFor('yokai').length}`);
  });

  it('elegir «Modo Yōkai» en la bienvenida cambia la piel al momento', async () => {
    await open();
    const yokai = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="onboarding-skins"] button')].find((b) =>
      b.textContent?.includes('Modo Yōkai'),
    )!;
    yokai.click();
    await nextTick();
    expect(document.documentElement.dataset.skin).toBe('yokai');
    expect(yokai.getAttribute('aria-pressed')).toBe('true');
    expect(text()).toContain('¡Bienvenido a la oficina!');
  });

  it('máquina de escribir en yōkai: el lector de pantalla recibe el texto entero y un clic lo completa', async () => {
    setReducedMotion(false);
    setSkin('yokai');
    await open();
    const body = document.querySelector<HTMLElement>('.tour-card .body')!;
    expect(body.querySelector('.sr-only')?.textContent).toContain('Soy Kitsune');
    expect(body.querySelector('[aria-hidden="true"]')).not.toBeNull();
    body.click();
    await nextTick();
    expect(body.querySelector('.sr-only')).toBeNull();
    expect(body.textContent).toContain('Soy Kitsune');
  });

  it('con «reducir movimiento» no hay efecto de escritura', async () => {
    setSkin('yokai');
    await open();
    expect(document.querySelector('.tour-card .body .caret')).toBeNull();
    expect(document.querySelector('.tour-card .typewriter')).toBeNull();
  });

  it('Siguiente y Atrás con teclado mueven el foco al título del paso; la app sigue navegando', async () => {
    const ob = await open();
    const next = document.querySelector<HTMLButtonElement>('[data-testid="onboarding-next"]')!;
    next.focus();
    next.click();
    await until(() => text().includes('El Panel'));
    await nextTick();
    expect(document.activeElement?.classList.contains('title')).toBe(true);
    expect(ob.progress.stepId).toBe('dashboard');

    press('onboarding-next');
    await until(() => router.currentRoute.value.path === '/agents');
    expect(text()).toContain('Agentes');

    press('onboarding-back');
    await until(() => ob.progress.stepId === 'dashboard');
    await until(() => router.currentRoute.value.path === '/');
  });

  it('Esc cierra la tarjeta sin abandonar el recorrido; «Saltar recorrido» lo descarta', async () => {
    const ob = await open('dashboard');
    tourCard()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await nextTick();
    expect(tourCard()).toBeNull();
    expect(ob.progress).toMatchObject({ status: 'active', open: false, stepId: 'dashboard' });

    ob.startTour();
    await nextTick();
    expect(text()).toContain('El Panel'); // se reanuda donde estaba
    press('onboarding-skip');
    await nextTick();
    expect(ob.progress.status).toBe('dismissed');
    expect(JSON.parse(localStorage.getItem('af-onboarding')!).status).toBe('dismissed');
  });

  it('sin ancla, la tarjeta va centrada abajo y sin halo', async () => {
    await open('dashboard');
    await until(() => tourCard()?.dataset.placement === 'center');
    expect(document.querySelector('[data-testid="onboarding-halo"]')).toBeNull();
  });

  it('con ancla, la tarjeta se coloca junto a ella y un halo la rodea', async () => {
    const anchor = document.createElement('section');
    anchor.dataset.tour = 'dashboard-kpis';
    anchor.getBoundingClientRect = () => ({ top: 80, left: 100, width: 400, height: 90, right: 500, bottom: 170, x: 100, y: 80, toJSON: () => ({}) });
    anchor.getClientRects = () => [anchor.getBoundingClientRect()] as unknown as DOMRectList;
    document.body.append(anchor);
    await open('dashboard');
    await until(() => tourCard()?.dataset.placement === 'bottom');
    const halo = document.querySelector<HTMLElement>('[data-testid="onboarding-halo"]')!;
    expect(halo.style.top).toBe('74px');
    expect(halo.style.width).toBe('412px');
  });

  it('el paso de lanzar espera a la ejecución real del workflow de bienvenida y avanza solo', async () => {
    const ob = await open('launch', { workflowId: 'wf-1' });
    expect(text()).toContain('Ejecútalo');
    expect(document.querySelector('[data-testid="onboarding-next"]')).toBeNull();
    // No está en el constructor: se ofrece ir allí.
    expect(document.querySelector('[data-testid="onboarding-go"]')).not.toBeNull();
    useRuns().apply(
      { id: 'r-1', workflowId: 'wf-1', status: 'running', kind: 'workflow', name: 'Bienvenida' } as unknown as Parameters<
        ReturnType<typeof useRuns>['apply']
      >[0],
      false,
    );
    await until(() => ob.progress.stepId === 'run-live');
    expect(ob.progress.runId).toBe('r-1');
    await nextTick();
    expect(text()).toContain('La ejecución en vivo');
  });

  it('todos los pasos tienen sus textos en español y en inglés, en las dos pieles', async () => {
    const ob = await open();
    for (const locale of ['es', 'en'] as const) {
      setLocale(locale, false);
      for (const skin of ['default', 'yokai'] as const) {
        setSkin(skin);
        for (const step of TOUR_STEPS.filter((s) => !s.skins || s.skins.includes(skin))) {
          ob.goTo(step.id);
          await nextTick();
          expect(text(), `${locale}/${skin}/${step.id}`).not.toMatch(/onboarding\.\w/);
          expect(document.querySelector('.tour-card .title')?.textContent?.trim()).not.toBe('');
        }
      }
    }
    setLocale('en', false);
    setSkin('default');
    ob.goTo('welcome');
    await nextTick();
    expect(text()).toContain('Welcome to AgentForge');
  });
});
