// Inglés además de español (hito 5, fase 7): selector de idioma, idioma del navegador, formatos y errores.
import type { Page } from '@playwright/test';
import { expect, test, toast, unique } from './support/fixtures';

/** Una clave de traducción sin resolver se pintaría tal cual («runs.filters.all»). */
const RAW_KEY =
  /\b(app|common|runs|runDetail|runActivity|runGraph|runState|playground|interrupted|approvals|settings|providerModal|accessGate|tools|builtinTools|toolEditor|toolTest|mcp|builder|flowNode|flow|dashboard|guide|agents|agentEditor|usage|workflows|triggers|importModal|transfer|glossaryView|notFound|term)\.[a-z][A-Za-z]*(\.[A-Za-z]+)*\b/;

async function expectNoRawKeys(page: Page): Promise<void> {
  const text = await page.locator('body').innerText();
  const attributes = await page.evaluate(() =>
    [...document.querySelectorAll('[aria-label], [title], [placeholder]')]
      .flatMap((el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('placeholder')])
      .filter(Boolean)
      .join('\n'),
  );
  // Las rutas de archivo y los nombres de modelo tienen puntos, pero no empiezan por el nombre de un ámbito.
  expect(`${text}\n${attributes}`.match(RAW_KEY)?.[0] ?? null, `Clave sin traducir en ${page.url()}`).toBeNull();
}

/**
 * Texto de interfaz en español dentro de una pantalla en inglés. Criterio (pensado para no ser frágil): el español
 * se delata por las letras que el inglés no usa (vocales con tilde, «ñ», «¿», «¡»). Se mira el texto PROPIO de cada
 * elemento (menú, cabeceras, botones, etiquetas, avisos…) y los atributos `aria-label`, `title` y `placeholder`,
 * salvo lo que no es interfaz fija: el selector de idioma («Español»), las filas de datos (`tbody`), el código y los
 * campos y opciones que llevan datos del usuario. Antes de comprobar, se quitan del texto los datos que alguien
 * escribió en español (nombres y descripciones de agentes, workflows y herramientas personalizadas): no son interfaz.
 * Los textos del servidor (herramientas integradas, errores, motivos de fallo) sí cuentan: deben salir traducidos.
 */
const SPANISH_LETTERS = /[áéíóúüñÁÉÍÓÚÜÑ¿¡]/;

async function expectNoSpanishUi(page: Page, serverTexts: string[]): Promise<void> {
  const texts = await page.evaluate(() => {
    const NOT_UI = '.langs, tbody, pre, code, textarea, input, select, option, script, style, [data-testid="announcer"]';
    const found: string[] = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest(NOT_UI)) continue;
      for (const attribute of ['aria-label', 'title', 'placeholder']) {
        const value = el.getAttribute(attribute);
        if (value) found.push(value);
      }
      for (const child of el.childNodes) if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) found.push(child.textContent.trim());
    }
    return found;
  });
  const spanish = texts.map((text) => serverTexts.reduce((rest, data) => rest.split(data).join(' '), text)).filter((text) => SPANISH_LETTERS.test(text));
  expect(spanish, `Texto de interfaz en español en ${page.url()}`).toEqual([]);
}

/** Todo lo que revisa la prueba de inglés en cada pantalla. */
async function expectEnglishScreen(page: Page, serverTexts: string[]): Promise<void> {
  await expectNoRawKeys(page);
  await expectNoSpanishUi(page, serverTexts);
}

const switchTo = (page: Page, label: 'English' | 'Español') => page.locator('.langs').getByRole('button', { name: label }).click();

test.describe('Idiomas', () => {
  test('el selector cambia toda la interfaz a inglés sin recargar, se recuerda y se puede volver al español', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Panel', level: 1 })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    const nav = page.locator('.sidebar nav');
    await expect(nav.getByRole('link', { name: 'Ejecuciones' })).toBeVisible();

    await switchTo(page, 'English');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(page).toHaveTitle('Dashboard · AgentForge');
    await expect(nav.getByRole('link', { name: 'Runs' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeAttached();
    await expect(page.locator('.langs').getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');

    // Se recuerda al recargar y al navegar.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await nav.getByRole('link', { name: 'Agents' }).click();
    await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();
    await expect(page).toHaveTitle('Agents · AgentForge');
    await expect(page.getByTestId('announcer')).toHaveText('Page: Agents');

    await switchTo(page, 'Español');
    await expect(page.getByRole('heading', { name: 'Agentes', level: 1 })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(page).toHaveTitle('Agentes · AgentForge');
  });

  test('todas las pantallas están en inglés: sin claves sin traducir ni texto de interfaz en español, y un workflow nuevo nace con «Input» y «Output»', async ({
    page,
    app,
  }) => {
    const agent = await app.createAgent({ name: unique('English'), systemPrompt: '[[decir:done]]' });
    const run = await app.runToEnd('agents', agent.id, 'hello');
    // Los datos del usuario no son interfaz: las herramientas que no son integradas (las ha escrito alguien, en este
    // mismo servidor, en español) y los nombres, roles y descripciones de agentes y workflows (los de ejemplo y los
    // de otros tests). Las herramientas integradas ya no están en esta lista: la interfaz las traduce por su nombre.
    const tools = (
      await app.api<
        Array<{ source: string; title: string; description: string; category: string; parameters?: { properties?: Record<string, { description?: string }> } }>
      >('GET', '/api/tools')
    ).filter((tool) => tool.source !== 'builtin');
    const named = [
      ...(await app.api<Array<{ name: string; role?: string; description?: string }>>('GET', '/api/agents')),
      ...(await app.api<Array<{ name: string; description?: string }>>('GET', '/api/workflows')),
    ];
    const serverTexts: string[] = [
      ...tools.flatMap((tool) => [
        tool.title,
        tool.description,
        tool.category,
        ...Object.values(tool.parameters?.properties ?? {}).map((p) => p.description ?? ''),
      ]),
      ...named.flatMap((item): string[] => [item.name, (item as { role?: string }).role ?? '', item.description ?? '']),
    ]
      .filter((text) => text.length > 2)
      .sort((x, y) => y.length - x.length);
    await page.goto('/');
    await switchTo(page, 'English');

    const screens: Array<[path: string, heading: string]> = [
      ['/', 'Dashboard'],
      ['/agents', 'Agents'],
      ['/workflows', 'Workflows'],
      ['/runs', 'Runs'],
      ['/tools', 'Tools'],
      ['/settings', 'Settings'],
      ['/glosario', 'Glossary'],
    ];
    for (const [path, heading] of screens) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      await expectEnglishScreen(page, serverTexts);
    }

    // La pantalla de Herramientas: las integradas se rotulan en inglés por su nombre (título, categoría, descripción y parámetros).
    await page.goto('/tools');
    const calculator = page.locator('article.tool').filter({ has: page.locator('code', { hasText: /^calculator$/ }) });
    await expect(calculator.getByRole('heading', { name: 'Calculator' })).toBeVisible();
    await expect(calculator).toContainText('Evaluates a mathematical expression precisely');
    await expect(calculator).toContainText('Mathematical expression to evaluate.');
    for (const category of ['Utilities', 'Network', 'Files', 'Coordination', 'Code']) {
      await expect(page.getByRole('heading', { name: category, level: 2, exact: true })).toBeVisible();
    }
    await expect(page.locator('main')).not.toContainText('Calculadora');
    await expect(page.locator('main')).not.toContainText('Utilidades');

    // Ficha de un agente, monitor de una ejecución y constructor.
    await page.goto(`/agents/${agent.id}`);
    await expect(page.locator('.tool-group').first()).toBeVisible();
    await expect(page.locator('.tool-group label').filter({ hasText: 'calculator' })).toContainText('Calculator');
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
    await expectEnglishScreen(page, serverTexts);

    await page.goto(`/runs/${run.id}`);
    await expect(page.locator('.badge').filter({ hasText: 'Completed' }).first()).toBeVisible();
    await expectEnglishScreen(page, serverTexts);

    await page.goto('/workflows/new');
    await expect(page.locator('.vue-flow__node')).toHaveCount(2);
    // Los nodos con los que nace un workflow nuevo se rotulan en el idioma activo (los ids siguen siendo los mismos).
    await expect(page.locator('.vue-flow__node[data-id="entrada"]')).toContainText('Input');
    await expect(page.locator('.vue-flow__node[data-id="salida"]')).toContainText('Output');
    await expect(page.locator('.vue-flow__node[data-id="entrada"]')).not.toContainText('Entrada');
    await expect(page.locator('.vue-flow__node[data-id="salida"]')).not.toContainText('Salida');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
    await expectEnglishScreen(page, serverTexts);
    // La validación del workflow (que calcula el código compartido con el servidor) también sale en inglés.
    await page.locator('.check-badge').click();
    await expect(page.getByLabel('Properties').locator('.validation').first()).toContainText('needs an incoming connection');

    // El glosario: definiciones en inglés en la página y en el tooltip.
    await page.goto('/glosario');
    await expect(page.locator('main')).toContainText('A language model with a role');
    await expectEnglishScreen(page, serverTexts);
  });

  test('los textos que escribe el servidor salen en inglés: validación, error de la API y motivo de fallo de una ejecución', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('Ocupado'), systemPrompt: '[[decir:ok]]' });
    const wfName = unique('Divide');
    const wf = await app.createWorkflow(
      wfName,
      [
        { id: 'entrada', type: 'input', label: 'Input' },
        { id: 'paso', type: 'agent', label: 'Step', config: { agentId: agent.id, prompt: '{{entrada}}' } },
        { id: 'calc', type: 'tool', label: 'Compute', config: { tool: 'calculator', args: { expression: '1 / 0' } } },
      ],
      ['entrada>paso', 'paso>calc'],
    );
    const run = await app.runToEnd('workflows', wf.id, 'go');
    expect(run.status).toBe('failed');
    // El servidor guarda el motivo en español, con su código al lado.
    expect(run.error).toBe('El nodo "Compute" falló: División entre cero.');
    expect(run.errorI18n).toMatchObject({ code: 'runNodeFailed', params: { name: 'Compute', cause: { code: 'calcDivisionByZero' } } });

    await page.goto('/');
    await switchTo(page, 'English');

    // 1) Motivo de fallo de la ejecución y del paso, en el monitor y en el historial.
    await page.goto(`/runs/${run.id}`);
    await expect(page.locator('.badge').filter({ hasText: 'Failed' }).first()).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Compute' })).toHaveText('Node "Compute" failed: Division by zero.');
    await page.locator('nav.steps button.step').filter({ hasText: 'Compute' }).click();
    await expect(page.locator('#run-panel').getByRole('alert')).toHaveText('Division by zero.');
    await page.locator('#run-tab-activity').click();
    await expect(page.locator('#run-panel')).toContainText('Step failed Division by zero.');
    await expect(page.locator('main')).not.toContainText('División entre cero');
    await expectEnglishScreen(page, [wfName, agent.name]);
    await page.goto('/runs');
    await expect(page.locator('tbody tr').filter({ hasText: wfName }).first()).toContainText('Node "Compute" failed: Division by zero.');

    // 2) Un error de validación del servidor, junto a su campo: una expresión cron con una hora imposible.
    await page.goto(`/workflows/${wf.id}`);
    await page.getByRole('button', { name: 'Triggers', exact: true }).click();
    const modal = page.getByRole('dialog').filter({ hasText: 'trigger' });
    await modal.getByRole('button', { name: 'Add trigger' }).click();
    await modal.getByRole('radio', { name: 'Cron' }).click();
    await modal.getByLabel('Cron expression').fill('0 25 * * *');
    await expect(modal.getByRole('alert')).toHaveText('"25" is not a valid value for the hour field (0-23).');
    await modal.getByLabel('Cron expression').fill('0 9 * *');
    await expect(modal.getByRole('alert')).toContainText('The expression must have five fields');
    await modal.getByLabel('Cron expression').fill('0 9 * * 1-5');
    await modal.getByLabel('Time zone').fill('Mars/Olympus');
    await modal.getByRole('button', { name: 'Create trigger' }).click();
    await expect(modal.getByRole('alert')).toHaveText('"Mars/Olympus" is not a known time zone (example: Europe/Madrid)');
    // En el diálogo no queda texto en español (el lienzo de detrás lleva datos de ejemplo, que no son interfaz).
    expect(await modal.innerText()).not.toMatch(SPANISH_LETTERS);
    await page.keyboard.press('Escape');

    // 3) Un error de la API con sus parámetros: no se puede eliminar un agente que usa un workflow.
    await page.goto(`/agents/${agent.id}`);
    await page.getByRole('button', { name: 'Delete agent' }).click();
    await page.getByRole('dialog', { name: 'Delete agent' }).getByRole('button', { name: 'Delete' }).click();
    await expect(toast(page, `It cannot be deleted: it is used by the workflows «${wfName}».`)).toBeVisible();

    // De vuelta en español, los mismos datos se ven con el texto del servidor.
    await switchTo(page, 'Español');
    await page.goto(`/runs/${run.id}`);
    await expect(page.getByRole('alert').filter({ hasText: 'Compute' })).toHaveText('El nodo "Compute" falló: División entre cero.');
  });

  test('en español tampoco queda ninguna clave sin traducir', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('Claves') });
    for (const path of ['/', '/agents', `/agents/${agent.id}`, '/workflows', '/workflows/new', '/runs', '/tools', '/settings', '/glosario']) {
      await page.goto(path);
      await expect(page.locator('main h1, main .name').first()).toBeAttached();
      await expectNoRawKeys(page);
    }
  });

  test('números, fechas y errores del servidor siguen al idioma', async ({ page, app }) => {
    const agent = await app.createAgent({ name: unique('Formato'), systemPrompt: '[[decir:ok]]' });
    await app.runToEnd('agents', agent.id, 'uno');
    await page.goto('/runs');
    await expect(page.locator('tbody tr').first()).toContainText(/ahora mismo|hace \d+/);
    await switchTo(page, 'English');
    await expect(page.locator('tbody tr').first()).toContainText(/just now|\d+ (second|minute)s? ago/);
    await expect(page.getByRole('button', { name: 'Completed' })).toBeVisible();

    // Un error genérico del servidor (404) se muestra en el idioma de la interfaz.
    await page.goto('/runs/run_que_no_existe');
    await expect(page.getByRole('heading', { name: 'The run could not be loaded' })).toBeVisible();
    await expect(page.locator('main')).toContainText('was not found');
    await switchTo(page, 'Español');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'No se pudo cargar la ejecución' })).toBeVisible();
    await expect(page.locator('main')).toContainText('no encontrada');
  });

  test('un navegador en inglés arranca en inglés; uno en español, en español', async ({ browser, app }) => {
    const english = await browser.newContext({ locale: 'en-GB' });
    const spanish = await browser.newContext({ locale: 'es-MX' });
    try {
      const a = await english.newPage();
      await a.goto(`${app.url}/agents`);
      await expect(a.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();
      await expect(a.locator('html')).toHaveAttribute('lang', 'en');

      const b = await spanish.newPage();
      await b.goto(`${app.url}/agents`);
      await expect(b.getByRole('heading', { name: 'Agentes', level: 1 })).toBeVisible();
      await expect(b.locator('html')).toHaveAttribute('lang', 'es');
    } finally {
      await english.close();
      await spanish.close();
    }
  });
});
