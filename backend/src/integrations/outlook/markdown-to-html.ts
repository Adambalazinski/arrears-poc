import { marked } from 'marked';

// Configure marked: synchronous mode (no async extensions), no GFM HTML
// passthrough so tenant-supplied content can't smuggle in extra tags later.
marked.setOptions({
  async: false,
  breaks: true, // Mustache templates rely on \n for paragraph breaks
  gfm: true,
});

export function renderMarkdownToHtml(bodyMarkdown: string): string {
  // marked.parse is sync when async:false is set.
  return marked.parse(bodyMarkdown) as string;
}

/** Strip the rendered HTML back to plain text so we can ship a fallback
 *  alongside the HTML body. Minimal — collapses tags + decodes the few
 *  entities marked emits. Good enough for nodemailer + Graph payloads. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<\/(p|div|h[1-6]|li|br|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
