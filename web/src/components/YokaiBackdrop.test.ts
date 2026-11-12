// @vitest-environment jsdom
// Fondo de ambiente del Modo Yōkai y las pantallas que lo usan (404 y puerta de acceso): en la piel normal siguen
// exactamente igual; en la yōkai ponen la aldea detrás y una línea de ambiente dentro del panel.
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { setSkin } from '@/lib/skin';
import { YOKAI_ASSETS } from '@/lib/yokai/assets';
import { freshPinia, testRouter } from '@/test/harness';
import NotFoundView from '@/views/NotFoundView.vue';
import AccessGate from './AccessGate.vue';
import YokaiBackdrop from './YokaiBackdrop.vue';

let wrapper: VueWrapper | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  setSkin('default');
  localStorage.clear();
});

function mountWithApp(component: object): VueWrapper {
  return mount(component, { global: { plugins: [freshPinia(), testRouter()] } });
}

describe('YokaiBackdrop', () => {
  it('pinta la aldea pixelada, decorativa y sin recibir el ratón', () => {
    wrapper = mount(YokaiBackdrop);
    const root = wrapper.find('[data-testid="yokai-backdrop"]');
    expect(root.attributes('aria-hidden')).toBe('true');
    const img = root.find('img');
    expect(img.attributes('src')).toBe(YOKAI_ASSETS.aldea);
    expect(img.attributes('alt')).toBe('');
    expect(root.findAll('.wisp').length).toBeGreaterThanOrEqual(5);
    expect(root.findAll('.fog')).toHaveLength(2);
  });

  it('oscurece con `dim` (0,35 por defecto) y lo limita entre 0 y 1', async () => {
    wrapper = mount(YokaiBackdrop);
    const shade = () => (wrapper!.find('.shade').element as HTMLElement).style.opacity;
    expect(shade()).toBe('0.35');
    await wrapper.setProps({ dim: 0.7 });
    expect(shade()).toBe('0.7');
    await wrapper.setProps({ dim: 3 });
    expect(shade()).toBe('1');
    await wrapper.setProps({ dim: -1 });
    expect(shade()).toBe('0');
  });
});

describe('pantallas de ambiente', () => {
  it('la 404 en la piel normal no cambia', () => {
    wrapper = mountWithApp(NotFoundView);
    expect(wrapper.find('[data-testid="yokai-backdrop"]').exists()).toBe(false);
    expect(wrapper.find('.yokai-line').exists()).toBe(false);
    expect(wrapper.find('.yokai-sprite').exists()).toBe(false);
    expect(wrapper.find('.page').classes()).toEqual(['page']);
    expect(wrapper.find('.card').classes()).toEqual(['card', 'empty']);
    expect(wrapper.find('h1').text()).toBe('Esta página no existe');
    expect(wrapper.find('a.btn-primary').text()).toBe('Volver al panel');
  });

  it('la 404 en la piel yōkai pone la aldea, el fantasma del ojo y la línea de ambiente', () => {
    setSkin('yokai');
    wrapper = mountWithApp(NotFoundView);
    expect(wrapper.find('[data-testid="yokai-backdrop"]').exists()).toBe(true);
    expect(wrapper.find('.yokai-sprite').classes()).toContain('is-ojo');
    expect(wrapper.find('.yokai-dialog .yokai-line').text()).toBe('Esta sala no existe en la mansión.');
    expect(wrapper.find('h1').text()).toBe('Esta página no existe');
  });

  it('la puerta de acceso en la piel normal no cambia', () => {
    wrapper = mountWithApp(AccessGate);
    expect(wrapper.find('[data-testid="yokai-backdrop"]').exists()).toBe(false);
    expect(wrapper.find('.yokai-line').exists()).toBe(false);
    expect(wrapper.find('main').classes()).toEqual(['gate']);
    expect(wrapper.find('form').classes()).toEqual(['card', 'gate-card']);
    expect(wrapper.find('#gate-token').exists()).toBe(true);
    expect(wrapper.findAll('form > p')).toHaveLength(1);
  });

  it('la puerta de acceso en la piel yōkai pone la aldea, la kitsune guardiana y la línea de ambiente', () => {
    setSkin('yokai');
    wrapper = mountWithApp(AccessGate);
    expect(wrapper.find('[data-testid="yokai-backdrop"]').exists()).toBe(true);
    expect(wrapper.find('.yokai-sprite').classes()).toContain('is-kitsune');
    expect(wrapper.find('form.yokai-dialog .yokai-line').text()).toBe('Solo el personal autorizado cruza el torii.');
    expect(wrapper.find('#gate-token').exists()).toBe(true);
  });
});
