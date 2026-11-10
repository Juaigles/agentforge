// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GLOSSARY } from '@/lib/glossary';
import { setTouchDevice, testRouter } from '@/test/harness';
import Term from './Term.vue';

let wrapper: VueWrapper;
const tip = () => document.body.querySelector<HTMLElement>('[role="tooltip"]');

async function mountTerm(slot?: string) {
  const router = testRouter();
  await router.push('/');
  wrapper = mount(Term, {
    props: { id: 'agente' },
    slots: slot ? { default: slot } : undefined,
    global: { plugins: [router] },
    attachTo: document.body,
  });
  return router;
}

beforeEach(() => setTouchDevice(false));
afterEach(() => {
  wrapper?.unmount();
  document.body.innerHTML = '';
});

describe('Term', () => {
  it('muestra el término del glosario, o el texto del slot, como enlace a su entrada', async () => {
    await mountTerm();
    const link = wrapper.get('a.term');
    expect(link.text()).toBe(GLOSSARY.agente.term);
    expect(link.attributes('href')).toBe('/glosario#g-agente');
    wrapper.unmount();

    await mountTerm('agentes');
    expect(wrapper.get('a.term').text()).toBe('agentes');
  });

  it('enseña la definición al pasar el ratón y al enfocar, y la oculta al salir, al perder el foco y con Esc', async () => {
    await mountTerm();
    const link = wrapper.get('a.term');
    expect(tip()).toBeNull();
    expect(link.attributes('aria-describedby')).toBeUndefined();

    await link.trigger('mouseenter');
    await flushPromises();
    expect(tip()?.textContent).toContain(GLOSSARY.agente.definition);
    // El enlace queda descrito por el tooltip para los lectores de pantalla.
    expect(link.attributes('aria-describedby')).toBe(tip()!.id);
    await link.trigger('mouseleave');
    expect(tip()).toBeNull();

    await link.trigger('focus');
    await flushPromises();
    expect(tip()).not.toBeNull();
    await link.trigger('keydown', { key: 'Escape' });
    expect(tip()).toBeNull();

    await link.trigger('focus');
    await flushPromises();
    await link.trigger('blur');
    expect(tip()).toBeNull();
  });

  it('se cierra al pulsar fuera o al desplazar la página', async () => {
    await mountTerm();
    await wrapper.get('a.term').trigger('mouseenter');
    await flushPromises();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flushPromises();
    expect(tip()).toBeNull();

    await wrapper.get('a.term').trigger('mouseenter');
    await flushPromises();
    window.dispatchEvent(new Event('scroll'));
    await flushPromises();
    expect(tip()).toBeNull();
  });

  it('con ratón, el clic navega a la entrada del glosario', async () => {
    const router = await mountTerm();
    await wrapper.get('a.term').trigger('click', { button: 0 });
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/glosario#g-agente');
  });

  it('en pantallas táctiles el primer toque muestra la definición y el segundo navega', async () => {
    setTouchDevice(true);
    const router = await mountTerm();
    const link = wrapper.get('a.term');

    await link.trigger('click', { button: 0 });
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/');
    expect(tip()?.textContent).toContain('Toca otra vez para ir al glosario');

    await link.trigger('click', { button: 0 });
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/glosario#g-agente');
    expect(tip()).toBeNull();
  });

  it('no deja listeners ni tooltips huérfanos al desmontarse abierto', async () => {
    await mountTerm();
    await wrapper.get('a.term').trigger('mouseenter');
    await flushPromises();
    wrapper.unmount();
    expect(tip()).toBeNull();
  });
});
