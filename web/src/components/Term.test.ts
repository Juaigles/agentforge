// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { GLOSSARY } from '@/lib/glossary';
import { setTouchDevice, testRouter } from '@/test/harness';
import AppModal from './AppModal.vue';
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

  it('se cierra al pulsar fuera; al desplazar acompaña al término y se cierra solo si el término sale de la vista', async () => {
    await mountTerm();
    await wrapper.get('a.term').trigger('mouseenter');
    await flushPromises();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flushPromises();
    expect(tip()).toBeNull();

    const link = wrapper.get('a.term').element as HTMLElement;
    const at = (top: number) =>
      vi
        .spyOn(link, 'getBoundingClientRect')
        .mockReturnValue({ top, bottom: top + 18, left: 40, right: 100, width: 60, height: 18, x: 40, y: top, toJSON: () => ({}) } as DOMRect);
    at(300);
    await wrapper.get('a.term').trigger('mouseenter');
    await flushPromises();
    // El navegador desplaza un poco para enfocar el término: la definición sigue abierta.
    at(260);
    window.dispatchEvent(new Event('scroll'));
    await flushPromises();
    expect(tip()).not.toBeNull();
    // El término sale por arriba: se cierra.
    at(-40);
    window.dispatchEvent(new Event('scroll'));
    await flushPromises();
    expect(tip()).toBeNull();
    vi.restoreAllMocks();
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

  it('un toque con el dedo cuenta como táctil aunque la pantalla diga que tiene ratón (portátil táctil); el ratón no', async () => {
    setTouchDevice(false);
    const router = await mountTerm();
    const link = wrapper.get('a.term');
    const press = async (pointerType: string) => {
      link.element.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { pointerType }));
      await link.trigger('click', { button: 0 });
      await flushPromises();
    };

    await press('touch');
    expect(router.currentRoute.value.fullPath).toBe('/');
    expect(tip()?.textContent).toContain('Toca otra vez para ir al glosario');
    await press('touch');
    expect(router.currentRoute.value.fullPath).toBe('/glosario#g-agente');

    await router.push('/');
    await press('mouse');
    expect(router.currentRoute.value.fullPath).toBe('/glosario#g-agente');
  });

  it('no deja listeners ni tooltips huérfanos al desmontarse abierto', async () => {
    await mountTerm();
    await wrapper.get('a.term').trigger('mouseenter');
    await flushPromises();
    wrapper.unmount();
    expect(tip()).toBeNull();
  });
});

describe('Term dentro de un diálogo o de un formulario', () => {
  const Host = (closed: { count: number }) =>
    defineComponent({
      render: () =>
        h(AppModal, { title: 'Proveedor', onClose: () => closed.count++ }, () => [
          h('form', [h('label', [h(Term, { id: 'agente' })]), h('input', { id: 'campo' })]),
        ]),
    });
  async function mountInDialog(closed = { count: 0 }) {
    const router = testRouter();
    await router.push('/');
    wrapper = mount(Host(closed), { global: { plugins: [router] }, attachTo: document.body });
    await flushPromises();
    return { router, closed };
  }
  const link = () => document.body.querySelector<HTMLAnchorElement>('a.term')!;

  it('el clic enseña la definición y no navega, ni con ratón ni en táctil; el glosario se ofrece en una pestaña nueva', async () => {
    for (const touch of [false, true]) {
      setTouchDevice(touch);
      const { router } = await mountInDialog();
      (document.body.querySelector('#campo') as HTMLInputElement).value = 'lo escrito';
      link().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      link().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      await flushPromises();
      expect(router.currentRoute.value.fullPath).toBe('/');
      expect(tip()?.textContent).toContain(GLOSSARY.agente.definition);
      expect(tip()?.textContent).not.toContain('Toca otra vez');
      const open = tip()!.querySelector<HTMLAnchorElement>('a')!;
      expect(open.getAttribute('href')).toBe('/glosario#g-agente');
      expect(open.target).toBe('_blank');
      expect((document.body.querySelector('#campo') as HTMLInputElement).value).toBe('lo escrito');
      wrapper.unmount();
      document.body.innerHTML = '';
    }
  });

  it('Esc cierra solo la definición: el diálogo que la contiene sigue abierto; un segundo Esc sí lo cierra', async () => {
    const { closed } = await mountInDialog();
    link().dispatchEvent(new MouseEvent('mouseenter'));
    await flushPromises();
    expect(tip()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(tip()).toBeNull();
    expect(closed.count).toBe(0);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(closed.count).toBe(1);
  });

  it('el puntero puede pasar del término a la definición sin que desaparezca, y al salir de ella se cierra', async () => {
    await mountInDialog();
    link().dispatchEvent(new MouseEvent('mouseenter'));
    await flushPromises();
    const bubble = tip()!;
    link().dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: bubble }));
    link().dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: bubble }));
    await flushPromises();
    expect(tip()).not.toBeNull();
    bubble.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: document.body }));
    await flushPromises();
    expect(tip()).toBeNull();
  });
});
