// Renderizado seguro de Markdown: la salida de los modelos no es de confianza, así que se sanea siempre.
import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});

export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false }) as string;
  return DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'img'], FORBID_ATTR: ['style'] });
}
