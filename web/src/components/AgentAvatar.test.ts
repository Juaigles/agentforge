// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setSkin, skin } from '@/lib/skin';
import { speciesFor } from '@/lib/yokai/species';
import { freshPinia } from '@/test/harness';
import AgentAvatar from './AgentAvatar.vue';
import YokaiSprite from './YokaiSprite.vue';

let previous: typeof skin.value;
beforeEach(() => {
  freshPinia();
  previous = skin.value;
});
afterEach(() => setSkin(previous));

/** Un id cuya especie es la pedida (la especie depende del hash del id). */
function idOf(species: 'kitsune' | 'ojo'): string {
  for (let i = 0; ; i++) if (speciesFor(`agt_${i}`) === species) return `agt_${i}`;
}

describe('AgentAvatar con la piel normal', () => {
  it('es el orbe de siempre: iniciales, color y animación según la actividad', () => {
    setSkin('default');
    const w = mount(AgentAvatar, { props: { name: 'Ana Pérez', color: '#0ea5e9', size: 40, activity: 'thinking' } });
    expect(w.classes()).toEqual(['orb', 'is-thinking']);
    expect(w.attributes('aria-hidden')).toBe('true');
    expect(w.get('.initials').text()).toBe('AP');
    expect((w.element as HTMLElement).style.getPropertyValue('--c')).toBe('#0ea5e9');
    expect(w.find('.portrait').exists()).toBe(false);
    expect(w.findComponent(YokaiSprite).exists()).toBe(false);
  });

  it('sin actividad se queda quieto', () => {
    setSkin('default');
    expect(mount(AgentAvatar, { props: { name: 'Ana' } }).classes()).toContain('is-still');
  });
});

describe('AgentAvatar con el Modo Yōkai', () => {
  it('muestra el retrato del yōkai con marco del color del agente, sin orbe', () => {
    setSkin('yokai');
    const w = mount(AgentAvatar, { props: { name: 'Ana', color: '#0ea5e9', size: 40 } });
    expect(w.classes()).toContain('portrait');
    expect(w.attributes('aria-hidden')).toBe('true');
    expect(w.find('.initials').exists()).toBe(false);
    const root = w.element as HTMLElement;
    expect(root.style.width).toBe('40px');
    expect(root.style.getPropertyValue('--frame')).toBe('#0ea5e9');
    const sprite = w.getComponent(YokaiSprite);
    expect(sprite.props('facing')).toBe('down');
    expect(sprite.props('walking')).toBe(false);
    // Sin actividad: ni burbuja ni puntito.
    expect(w.find('.bubble').exists()).toBe(false);
    expect(w.find('.dot').exists()).toBe(false);
  });

  it('agentId decide la especie; sin él, el nombre', () => {
    setSkin('yokai');
    for (const species of ['kitsune', 'ojo'] as const) {
      const w = mount(AgentAvatar, { props: { name: 'Mismo nombre', agentId: idOf(species) } });
      expect(w.getComponent(YokaiSprite).props('species')).toBe(species);
      expect(w.classes()).toContain(`is-${species}`);
    }
    const byName = mount(AgentAvatar, { props: { name: 'Investigador' } });
    expect(byName.getComponent(YokaiSprite).props('species')).toBe(speciesFor('Investigador'));
  });

  it('burbuja con el glifo desde 28 px; por debajo, un puntito del estado', () => {
    setSkin('yokai');
    const big = mount(AgentAvatar, { props: { name: 'Ana', size: 28, activity: 'waiting' } });
    expect(big.get('.bubble').text()).toBe('印');
    expect(big.find('.dot').exists()).toBe(false);

    const small = mount(AgentAvatar, { props: { name: 'Ana', size: 22, activity: 'done' } });
    expect(small.find('.bubble').exists()).toBe(false);
    expect(small.find('.dot').exists()).toBe(true);
    expect(small.classes()).toContain('is-done');
  });

  it('camina mientras trabaja y se queda quieto en el resto de estados', () => {
    setSkin('yokai');
    const walking = (activity?: 'thinking' | 'tool' | 'writing' | 'waiting' | 'done' | 'error' | 'idle') =>
      mount(AgentAvatar, { props: { name: 'Ana', size: 32, activity } })
        .getComponent(YokaiSprite)
        .props('walking');
    expect(['thinking', 'tool', 'writing'].map((a) => walking(a as 'thinking'))).toEqual([true, true, true]);
    expect([walking('idle'), walking('waiting'), walking('done'), walking('error'), walking()]).toEqual([false, false, false, false, false]);
  });

  it('vuelve al orbe al cambiar de piel', async () => {
    setSkin('yokai');
    const w = mount(AgentAvatar, { props: { name: 'Ana' } });
    expect(w.classes()).toContain('portrait');
    setSkin('default');
    await w.vm.$nextTick();
    expect(w.classes()).toContain('orb');
  });
});
