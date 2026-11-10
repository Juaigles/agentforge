import { expect, expectNoHorizontalOverflow, test, unique } from './support/fixtures';

const background = (page: import('@playwright/test').Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test.describe('Tema', () => {
  test('el tema claro/oscuro se aplica al instante y se recuerda al recargar', async ({ page }) => {
    await page.goto('/');
    const light = await background(page);

    await page.getByRole('button', { name: 'Tema oscuro' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('button', { name: 'Tema oscuro' })).toHaveAttribute('aria-pressed', 'true');
    const dark = await background(page);
    expect(dark).not.toBe(light);

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await background(page)).toBe(dark);

    await page.getByRole('button', { name: 'Tema claro' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await background(page)).toBe(light);

    // «Sistema» deja de forzar el tema y sigue la preferencia del sistema operativo.
    await page.getByRole('button', { name: 'Tema del sistema' }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => background(page)).toBe(dark);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => background(page)).toBe(light);
  });

  test('el texto principal mantiene contraste suficiente en ambos temas', async ({ page }) => {
    await page.goto('/');
    for (const theme of ['Tema claro', 'Tema oscuro']) {
      await page.getByRole('button', { name: theme }).click();
      const ratio = await page.evaluate(() => {
        const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const lum = ([r, g, b]: number[]) => {
          const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const h1 = document.querySelector('h1')!;
        const fg = lum(parse(getComputedStyle(h1).color));
        const bg = lum(parse(getComputedStyle(document.body).backgroundColor));
        return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      });
      expect(ratio, `${theme}: contraste del título`).toBeGreaterThanOrEqual(7);
    }
  });
});

test.describe('Vista móvil (375 × 812)', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('ninguna pantalla se desborda en horizontal, en claro y en oscuro', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('Móvil'), tools: ['calculator'] });
    const wf = await app.createWorkflow(
      unique('Flujo móvil con un nombre bastante largo para forzar el ajuste'),
      [
        { id: 'entrada', type: 'input' },
        { id: 'paso', type: 'agent', config: { agentId: agent.id, prompt: '[[herramienta:calculator {"expression":"1+1"}]] {{input}}' } },
        { id: 'salida', type: 'output', config: { template: '{{paso}}' } },
      ],
      ['entrada>paso', 'paso>salida'],
    );
    const run = await app.runToEnd('workflows', wf.id, 'Una entrada larga sin espacios: ' + 'x'.repeat(120));
    const failing = await app.createAgent({ name: unique('Falla móvil'), systemPrompt: '[[fallo:movil]]' });
    app.fake.failing.add('movil');
    const failed = await app.runToEnd('agents', failing.id, 'falla');

    const routes = [
      '/',
      '/agents',
      '/agents/new',
      `/agents/${agent.id}`,
      '/workflows',
      '/workflows/new',
      `/workflows/${wf.id}`,
      '/runs',
      `/runs/${run.id}`,
      `/runs/${failed.id}`,
      '/tools',
      '/settings',
      '/glosario',
      '/ruta-que-no-existe',
    ];
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      for (const route of routes) {
        await page.goto(route);
        await expect(page.locator('main h1, main .name, main h3').first()).toBeVisible();
        await page.waitForLoadState('networkidle');
        await expectNoHorizontalOverflow(page);
      }
    }
  });

  test('la navegación principal funciona en móvil y el monitor de una ejecución es utilizable', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('Móvil nav') });
    const run = await app.runToEnd('agents', agent.id, '[[decir:respuesta en el móvil]]');

    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Principal' });
    await nav.getByRole('link', { name: 'Ejecuciones' }).click();
    await expect(page).toHaveURL(/\/runs$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Ejecuciones' })).toBeVisible();

    await page.goto(`/runs/${run.id}`);
    await expect(page.locator('.panel .output')).toContainText('respuesta en el móvil');
    await page.getByRole('tab', { name: /Actividad/ }).click();
    await expect(page.locator('.panel .activity li').first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('un término del glosario muestra su definición al tocarlo y lleva al glosario al segundo toque', async ({ page }) => {
    await page.goto('/runs');
    const term = page.locator('main a.term').first();
    await term.tap();
    const tip = page.getByRole('tooltip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('Toca otra vez para ir al glosario');
    // El tooltip no se sale de la pantalla.
    const box = (await tip.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    await expect(page).toHaveURL(/\/runs$/);
    await term.tap();
    await expect(page).toHaveURL(/\/glosario#g-/);
  });
});
