// @vitest-environment jsdom
// Diálogo modal: cierre con Esc y «×», con confirmación opcional si hay algo escrito.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { freshPinia } from '@/test/harness';
import AppModal from './AppModal.vue';
import UiHost from './UiHost.vue';

let wrapper: VueWrapper;
let host: VueWrapper;
const closed = { count: 0 };

function open(confirmClose: boolean): void {
  closed.count = 0;
  const pinia = freshPinia();
  host = mount(UiHost, { global: { plugins: [pinia] }, attachTo: document.body });
  wrapper = mount(
    defineComponent({
      render: () => h(AppModal, { title: 'Formulario', confirmClose, onClose: () => closed.count++ }, () => h('input', { id: 'campo' })),
    }),
    { global: { plugins: [pinia] }, attachTo: document.body },
  );
}
const type = async () => {
  const input = document.body.querySelector<HTMLInputElement>('#campo')!;
  input.value = 'algo';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
};
const esc = async () => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flushPromises();
};
const confirmDialog = () => document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="Descartar cambios"]');
const pressInConfirm = async (label: string) => {
  [...confirmDialog()!.querySelectorAll('button')].find((b) => b.textContent?.includes(label))!.click();
  await flushPromises();
};

afterEach(() => {
  wrapper?.unmount();
  host?.unmount();
  document.body.innerHTML = '';
});

describe('AppModal: cerrar con algo escrito', () => {
  it('con confirmClose, Esc y «×» piden descartar; «Cancelar» conserva el diálogo y «Descartar» lo cierra', async () => {
    open(true);
    await type();
    await esc();
    expect(confirmDialog()).not.toBeNull();
    expect(closed.count).toBe(0);
    await pressInConfirm('Cancelar');
    expect(confirmDialog()).toBeNull();
    expect(closed.count).toBe(0);

    document.body.querySelector<HTMLButtonElement>('button[aria-label="Cerrar"]')!.click();
    await flushPromises();
    expect(confirmDialog()).not.toBeNull();
    // El propio diálogo de confirmación no pregunta: Esc lo cierra a secas.
    await esc();
    expect(confirmDialog()).toBeNull();
    expect(closed.count).toBe(0);

    await esc();
    await pressInConfirm('Descartar');
    expect(closed.count).toBe(1);
  });

  it('sin haber escrito nada, Esc y «×» cierran directamente', async () => {
    open(true);
    await esc();
    expect(confirmDialog()).toBeNull();
    expect(closed.count).toBe(1);
    document.body.querySelector<HTMLButtonElement>('button[aria-label="Cerrar"]')!.click();
    await flushPromises();
    expect(closed.count).toBe(2);
  });

  it('sin confirmClose (diálogos de consulta) cierra directamente aunque se haya escrito', async () => {
    open(false);
    await type();
    await esc();
    expect(confirmDialog()).toBeNull();
    expect(closed.count).toBe(1);
  });
});
