// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import YokaiSprite from './YokaiSprite.vue';

const sheet = (w: ReturnType<typeof mount>) => w.get('.sheet').element as HTMLElement;

describe('YokaiSprite', () => {
  it('es decorativo y dibuja el cuadro 0 de la fila de abajo, a 128 px, con la hoja de su especie', () => {
    const w = mount(YokaiSprite, { props: { species: 'kitsune' } });
    const root = w.element as HTMLElement;
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.classList).toContain('is-kitsune');
    expect(root.classList).toContain('facing-down');
    expect(root.classList).not.toContain('is-walking');
    expect(root.style.width).toBe('128px');
    expect(root.style.height).toBe('128px');
    expect(sheet(w).style.backgroundImage).toContain('yokai/kitsune.png');
    expect(sheet(w).style.backgroundSize).toBe('512px 512px');
    expect(sheet(w).style.backgroundPosition).toBe('0px 0px');
    expect(w.find('.bubble').exists()).toBe(false);
  });

  it('la dirección elige la fila y el tamaño escala la hoja con background-size', () => {
    const w = mount(YokaiSprite, { props: { species: 'ojo', facing: 'up', size: 32 } });
    expect(w.classes()).toContain('facing-up');
    expect(sheet(w).style.backgroundImage).toContain('yokai/ojo.png');
    expect(sheet(w).style.backgroundSize).toBe('128px 128px');
    expect(sheet(w).style.backgroundPosition).toBe('0px -96px');
    expect(sheet(w).style.getPropertyValue('--sheet')).toBe('128px');
    expect((w.element as HTMLElement).style.width).toBe('32px');
  });

  it('al caminar se marca para la animación del ciclo', () => {
    const w = mount(YokaiSprite, { props: { species: 'ojo', walking: true } });
    expect(w.classes()).toContain('is-walking');
  });

  it('con `frame` el fotograma lo marca quien lo usa: sin animación CSS del ciclo', () => {
    const w = mount(YokaiSprite, { props: { species: 'kappa', facing: 'left', walking: true, frame: 2, size: 32 } });
    expect(w.classes()).not.toContain('is-walking');
    expect(sheet(w).style.backgroundPosition).toBe('-64px -32px');
  });

  it('con actividad muestra la burbuja con su glifo y el color de acento', () => {
    const w = mount(YokaiSprite, { props: { species: 'kitsune', activity: 'thinking', tint: '#0ea5e9', size: 24 } });
    const bubble = w.get('.bubble');
    expect(bubble.text()).toBe('考');
    expect(bubble.classes()).toContain('is-thinking');
    const style = (bubble.element as HTMLElement).style;
    expect(style.getPropertyValue('--tint')).toBe('#0ea5e9');
    // En un cuadro pequeño la burbuja no baja de 12 px.
    expect(style.width).toBe('12px');
  });
});
