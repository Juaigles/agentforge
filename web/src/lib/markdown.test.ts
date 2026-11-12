// @vitest-environment jsdom
// Saneado de Markdown con marked + DOMPurify reales en jsdom (sin dobles): la salida de los modelos no es de fiar.
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

/** Árbol DOM del resultado, para inspeccionar etiquetas y atributos reales (no cadenas de texto). */
function dom(source: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = renderMarkdown(source);
  return root;
}

/** Lo que nunca puede haber en el resultado, sea cual sea la entrada. */
const FORBIDDEN_TAGS = ['script', 'iframe', 'form', 'input', 'button', 'style', 'img', 'base', 'meta', 'object', 'embed', 'link', 'textarea', 'select'];
function assertHarmless(source: string): HTMLElement {
  const root = dom(source);
  for (const tag of FORBIDDEN_TAGS) expect(root.querySelector(tag), `<${tag}> en la salida de: ${source}`).toBeNull();
  for (const el of root.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      expect(attr.name.startsWith('on'), `atributo ${attr.name} en la salida de: ${source}`).toBe(false);
      expect(attr.name, `style en la salida de: ${source}`).not.toBe('style');
      if (['href', 'src', 'action', 'formaction', 'xlink:href'].includes(attr.name)) {
        expect(attr.value.trim().toLowerCase(), `URL peligrosa en la salida de: ${source}`).not.toMatch(/^(javascript|vbscript|data):/);
      }
    }
  }
  const html = renderMarkdown(source).toLowerCase();
  expect(html).not.toContain('<script');
  return root;
}

describe('renderMarkdown: Markdown legítimo', () => {
  it('pinta títulos, negrita, cursiva y párrafos', () => {
    const root = dom('# Título\n\n## Sub\n\nTexto con **negrita** y *cursiva*.');
    expect(root.querySelector('h1')?.textContent).toBe('Título');
    expect(root.querySelector('h2')?.textContent).toBe('Sub');
    expect(root.querySelector('p strong')?.textContent).toBe('negrita');
    expect(root.querySelector('p em')?.textContent).toBe('cursiva');
  });

  it('pinta listas con y sin orden, con sus elementos', () => {
    const root = dom('- uno\n- dos\n\n1. a\n2. b\n3. c');
    expect([...root.querySelectorAll('ul > li')].map((li) => li.textContent)).toEqual(['uno', 'dos']);
    expect([...root.querySelectorAll('ol > li')].map((li) => li.textContent)).toEqual(['a', 'b', 'c']);
  });

  it('pinta tablas (GFM) con cabecera y celdas', () => {
    const root = dom('| Nombre | Total |\n| --- | --- |\n| Ana | 10 |\n| Luis | 20 |');
    expect([...root.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['Nombre', 'Total']);
    expect([...root.querySelectorAll('tbody tr')].map((tr) => tr.textContent?.replace(/\s+/g, ''))).toEqual(['Ana10', 'Luis20']);
  });

  it('pinta código en línea y bloques de código con su lenguaje', () => {
    const root = dom('Usa `npm test`.\n\n```ts\nconst a = 1;\n```');
    expect(root.querySelector('p code')?.textContent).toBe('npm test');
    const block = root.querySelector('pre code');
    expect(block?.textContent).toBe('const a = 1;\n');
    expect(block?.className).toBe('language-ts');
  });

  it('respeta los saltos de línea simples (breaks) y las citas', () => {
    const root = dom('línea 1\nlínea 2\n\n> cita');
    expect(root.querySelector('p br')).not.toBeNull();
    expect(root.querySelector('blockquote')?.textContent?.trim()).toBe('cita');
  });

  it('conserva los enlaces http y https y los abre en otra pestaña sin dar acceso a la ventana de origen', () => {
    const root = dom('[web](https://example.com/a?b=1) y [otra](http://example.org)');
    const links = [...root.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/a?b=1', 'http://example.org']);
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      const rel = a.getAttribute('rel')!.split(' ');
      expect(rel).toEqual(expect.arrayContaining(['noopener', 'noreferrer', 'nofollow']));
    }
  });

  it('también añade target y rel a un enlace escrito como HTML y no deja pasar el target que traiga', () => {
    const root = dom('<a href="https://example.com" target="_self" rel="opener">x</a>');
    const a = root.querySelector('a')!;
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });

  it('la cadena vacía da una cadena vacía', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('no mantiene estado entre llamadas: el mismo texto da el mismo resultado', () => {
    const text = '# a\n\n[x](https://example.com)\n\n<script>alert(1)</script>';
    expect(renderMarkdown(text)).toBe(renderMarkdown(text));
  });

  it('un documento largo se pinta entero sin recortarlo (no hay límite de tamaño)', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `- elemento ${i}`);
    const root = dom(lines.join('\n'));
    expect(root.querySelectorAll('li')).toHaveLength(5000);
    expect(root.querySelectorAll('li')[4999].textContent).toBe('elemento 4999');
  });
});

describe('renderMarkdown: entradas hostiles', () => {
  it('elimina <script> y su contenido', () => {
    const root = assertHarmless('antes<script>alert(1)</script>después');
    expect(root.textContent).toContain('antes');
    expect(root.textContent).toContain('después');
    expect(root.textContent).not.toContain('alert(1)');
  });

  it('quita el manejador onerror de una imagen (y la imagen)', () => {
    assertHarmless('<img src=x onerror=alert(1)>');
    assertHarmless('<IMG SRC=x ONERROR="alert(1)">');
  });

  it('no deja imágenes: ni HTML ni sintaxis Markdown (evita peticiones a terceros desde la salida del modelo)', () => {
    const root = assertHarmless('![logo](https://tracker.example/pixel.png)\n\n<img src="https://tracker.example/p.gif">');
    expect(root.querySelector('img')).toBeNull();
  });

  it('neutraliza un enlace Markdown javascript: (sin href peligroso)', () => {
    const root = assertHarmless('[pulsa](javascript:alert(1))');
    expect(root.querySelector('a[href^="javascript"]')).toBeNull();
    // El texto del enlace se conserva como texto visible.
    expect(root.textContent).toContain('pulsa');
  });

  it('neutraliza variantes ofuscadas de javascript: (mayúsculas, espacios, entidades, saltos de línea)', () => {
    assertHarmless('[a](JaVaScRiPt:alert(1))');
    assertHarmless('[a](&#106;avascript:alert(1))');
    assertHarmless('<a href="&#x6A;avascript:alert(1)">a</a>');
    assertHarmless('<a href="java\nscript:alert(1)">a</a>');
    assertHarmless('<a href="  javascript:alert(1)">a</a>');
    assertHarmless('<a href="jav&#x09;ascript:alert(1)">a</a>');
  });

  it('quita onclick y otros manejadores de un enlace HTML pero conserva el enlace seguro', () => {
    const root = assertHarmless('<a href="https://example.com" onclick="alert(1)" onmouseover="alert(2)">x</a>');
    const a = root.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com');
    expect(a.hasAttribute('onclick')).toBe(false);
    expect(a.hasAttribute('onmouseover')).toBe(false);
  });

  it('elimina <iframe>, <object> y <embed>', () => {
    assertHarmless('<iframe src="https://evil.example"></iframe>');
    assertHarmless('<iframe srcdoc="<script>alert(1)</script>"></iframe>');
    assertHarmless('<object data="https://evil.example/x.swf"></object><embed src="https://evil.example/x.swf">');
  });

  it('elimina formularios y campos (no se puede pedir una contraseña desde la salida del modelo)', () => {
    const root = assertHarmless('<form action="https://evil.example"><input name="pwd" type="password"><button>Entrar</button></form>');
    expect(root.querySelector('[action]')).toBeNull();
  });

  it('elimina el atributo style: nada de posicionar un panel encima de la interfaz', () => {
    const root = assertHarmless('<p style="position:fixed;top:0;left:0;width:100vw;height:100vh">cubre todo</p>');
    expect(root.querySelector('p')?.textContent).toBe('cubre todo');
    expect(root.querySelector('p')?.hasAttribute('style')).toBe(false);
  });

  it('elimina <svg> con onload y SVG con scripts dentro', () => {
    assertHarmless('<svg onload=alert(1)></svg>');
    assertHarmless('<svg><script>alert(1)</script></svg>');
    assertHarmless('<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>');
    assertHarmless('<svg><animate onbegin=alert(1) attributeName=x dur=1s></svg>');
  });

  it('elimina <math>, <style>, <base> y <meta http-equiv>', () => {
    assertHarmless('<math><mi xlink:href="javascript:alert(1)">x</mi></math>');
    assertHarmless('<style>body{display:none}</style>texto');
    assertHarmless('<base href="https://evil.example/">[a](/relativo)');
    assertHarmless('<meta http-equiv="refresh" content="0;url=https://evil.example">');
    assertHarmless('<link rel="stylesheet" href="https://evil.example/x.css">');
  });

  it('neutraliza enlaces data: y vbscript:', () => {
    const root = assertHarmless(
      '[a](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)\n\n[b](vbscript:msgbox(1))\n\n<a href="data:text/html,<script>alert(1)</script>">c</a>',
    );
    expect(root.querySelector('a[href^="data:"]')).toBeNull();
    expect(root.querySelector('a[href^="vbscript:"]')).toBeNull();
  });

  it('el HTML dentro de bloques y de código en línea se muestra como texto, no se ejecuta ni se interpreta', () => {
    const root = assertHarmless('```html\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n```\n\nY en línea: `<img src=x onerror=alert(1)>`');
    const block = root.querySelector('pre code')!;
    expect(block.textContent).toContain('<script>alert(1)</script>');
    expect(block.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(block.children).toHaveLength(0);
    const inline = root.querySelector('p code')!;
    expect(inline.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(inline.children).toHaveLength(0);
  });

  it('las entidades HTML escapadas siguen siendo texto: &lt;script&gt; no se convierte en una etiqueta', () => {
    const root = assertHarmless('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(root.textContent?.trim()).toBe('<script>alert(1)</script>');
    expect(root.querySelector('script')).toBeNull();
  });

  it('el Markdown anidado no logra cerrar una etiqueta segura para colar otra', () => {
    assertHarmless('**negrita</strong><script>alert(1)</script>**');
    assertHarmless('[x](https://example.com "t\\" onclick=\\"alert(1)")');
    assertHarmless('[x](https://example.com" onclick="alert(1))');
    assertHarmless('`</code><script>alert(1)</script>`');
    assertHarmless('> cita\n> <img src=x onerror=alert(1)>');
    assertHarmless('| a | b |\n| - | - |\n| <img src=x onerror=alert(1)> | <script>alert(1)</script> |');
    assertHarmless('<details open ontoggle=alert(1)><summary>x</summary></details>');
    assertHarmless('<div><p><b><i>x</b></i></p></div><noscript><p title="</noscript><img src=x onerror=alert(1)>">');
  });

  it('el texto de un enlace con HTML dentro no escapa de la etiqueta <a>', () => {
    const root = assertHarmless('[<img src=x onerror=alert(1)>](https://example.com)');
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
  });

  it('un enlace relativo o de ancla se conserva y sigue llevando rel y target seguros', () => {
    const root = assertHarmless('[ancla](#seccion) y [ruta](/otra)');
    for (const a of root.querySelectorAll('a')) expect(a.getAttribute('rel')).toContain('noopener');
  });

  it('todas las entradas hostiles juntas dan una salida inocua', () => {
    assertHarmless(
      [
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(1)>',
        '[x](javascript:alert(1))',
        '<a href="https://example.com" onclick=alert(1)>x</a>',
        '<iframe src="https://evil.example"></iframe>',
        '<form><input></form>',
        '<p style="position:fixed">x</p>',
        '<svg onload=alert(1)>',
        '<math><style>x</style></math>',
        '<base href="//evil.example">',
        '<meta http-equiv="refresh" content="0;url=//evil.example">',
      ].join('\n\n'),
    );
  });
});
