// @vitest-environment jsdom
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '@/i18n';
import { setSkin, skin } from '@/lib/skin';
import { freshPinia } from '@/test/harness';
import SkinToggle from './SkinToggle.vue';

let wrapper: VueWrapper;

beforeEach(() => {
  freshPinia();
  localStorage.clear();
  setSkin('default');
});
afterEach(() => {
  wrapper?.unmount();
  setSkin('default');
  setLocale('es', false);
});

describe('SkinToggle', () => {
  it('es un interruptor con nombre «Modo Yōkai» y la pista como descripción', () => {
    wrapper = mount(SkinToggle, { attachTo: document.body });
    const input = wrapper.get('input');
    expect(input.attributes('type')).toBe('checkbox');
    expect(input.attributes('role')).toBe('switch');
    expect(input.classes()).toContain('switch');
    const name = document.getElementById(input.attributes('aria-labelledby')!);
    const hint = document.getElementById(input.attributes('aria-describedby')!);
    expect(name?.textContent).toBe('Modo Yōkai');
    expect(hint?.textContent).toBe('Convierte la app en una oficina de yōkai en pixel art');
    expect((input.element as HTMLInputElement).checked).toBe(false);
  });

  it('activarlo y desactivarlo cambia la piel, la guarda y la refleja en <html>', async () => {
    wrapper = mount(SkinToggle);
    const input = wrapper.get('input');
    await input.setValue(true);
    expect(skin.value).toBe('yokai');
    expect(localStorage.getItem('af-skin')).toBe('yokai');
    expect(document.documentElement.dataset.skin).toBe('yokai');
    await input.setValue(false);
    expect(skin.value).toBe('default');
    expect(localStorage.getItem('af-skin')).toBeNull();
    expect(document.documentElement.hasAttribute('data-skin')).toBe(false);
  });

  it('sigue a la piel cuando cambia desde otro sitio', async () => {
    wrapper = mount(SkinToggle);
    setSkin('yokai');
    await wrapper.vm.$nextTick();
    expect((wrapper.get('input').element as HTMLInputElement).checked).toBe(true);
  });

  it('cambia de idioma con la interfaz', async () => {
    wrapper = mount(SkinToggle);
    setLocale('en', false);
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('Yōkai Mode');
  });
});
