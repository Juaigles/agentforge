// @vitest-environment jsdom
// Franja «Plantilla de hoy» del Modo Yōkai: solo existe con esa piel y enlaza cada yōkai a la ficha de su agente.
import type { Agent } from '@shared/types';
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { setSkin } from '@/lib/skin';
import { freshPinia, testRouter } from '@/test/harness';
import YokaiRoster from './YokaiRoster.vue';

let wrapper: VueWrapper | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  setSkin('default');
  localStorage.clear();
});

const agent = (n: number): Agent => ({
  id: `agent-${n}`,
  name: `Agente ${n}`,
  role: '',
  description: '',
  color: '#7c3aed',
  providerId: 'p',
  model: 'm',
  systemPrompt: '',
  temperature: 0.7,
  maxTokens: null,
  maxIterations: 4,
  tools: [],
  thinking: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

function open(agents: Agent[], activeIds?: string[]): VueWrapper {
  return mount(YokaiRoster, { props: { agents, activeIds }, global: { plugins: [freshPinia(), testRouter()] } });
}
const roster = () => wrapper!.find('[data-testid="yokai-roster"]');

describe('YokaiRoster', () => {
  it('en la piel normal no pinta nada', () => {
    wrapper = open([agent(1), agent(2)]);
    expect(roster().exists()).toBe(false);
    expect(wrapper.findAll('a')).toHaveLength(0);
  });

  it('sin agentes no pinta nada, ni con la piel yōkai', () => {
    setSkin('yokai');
    wrapper = open([]);
    expect(roster().exists()).toBe(false);
  });

  it('con la piel yōkai pinta un enlace por agente, con su nombre, a su ficha', () => {
    setSkin('yokai');
    wrapper = open([agent(1), agent(2), agent(3)]);
    expect(roster().find('h2').text()).toBe('Plantilla de hoy');
    const links = roster().findAll('a');
    // El nombre es texto real del enlace; la burbuja va dentro del sprite, oculto al lector de pantalla.
    expect(links.map((a) => a.find('.name').text())).toEqual(['Agente 1', 'Agente 2', 'Agente 3']);
    expect(links.every((a) => a.find('.sprite').attributes('aria-hidden') === 'true')).toBe(true);
    expect(links.map((a) => a.attributes('href'))).toEqual(['/agents/agent-1', '/agents/agent-2', '/agents/agent-3']);
    expect(roster().findAll('.yokai-sprite')).toHaveLength(3);
  });

  it('enseña como mucho 8 agentes', () => {
    setSkin('yokai');
    wrapper = open(Array.from({ length: 11 }, (_, i) => agent(i + 1)));
    expect(roster().findAll('a')).toHaveLength(8);
  });

  it('los activos caminan, piensan y lo dicen al lector de pantalla; el resto reposa', () => {
    setSkin('yokai');
    wrapper = open([agent(1), agent(2)], ['agent-2']);
    const [idle, busy] = roster().findAll('a');
    expect(idle.find('.yokai-sprite').classes()).not.toContain('is-walking');
    expect(idle.find('.bubble').classes()).toContain('is-idle');
    expect(idle.find('.sr-only').exists()).toBe(false);
    expect(busy.find('.yokai-sprite').classes()).toContain('is-walking');
    expect(busy.find('.bubble').classes()).toContain('is-thinking');
    expect(busy.find('.sr-only').text()).toBe('(trabajando)');
  });

  it('desaparece al volver a la piel normal', async () => {
    setSkin('yokai');
    wrapper = open([agent(1)]);
    expect(roster().exists()).toBe(true);
    setSkin('default');
    await wrapper.vm.$nextTick();
    expect(roster().exists()).toBe(false);
  });
});
