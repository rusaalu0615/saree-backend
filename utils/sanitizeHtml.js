// Allowlist sanitizer for blog descriptions at the trust boundary (Node, no DOM).
// Keeps tiptap formatting; drops scripts, handlers, javascript: URLs, unsafe embeds.
const ALLOWED = new Set(["p", "h1", "h2", "h3", "h4", "strong", "b", "em", "i", "u", "s", "ul", "ol", "li", "blockquote", "br", "a"]);
const DANGEROUS = new Set(["script", "style", "iframe", "object", "embed", "form", "button", "input", "svg", "math", "link", "meta", "base"]);
const HREF_OK = /^(https?:\/\/|mailto:|#|\/)/i;

export function sanitizeBlogHtml(html) {
  if (!html || typeof html !== "string") return "";
  // Tokenize tags; unwrap unknown, drop dangerous with content.
  return html
    .replace(/<\s*(script|style|iframe|object|embed|form)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*\/?\s*([a-z0-9-]+)\b[^>]*>/gi, (match, rawTag) => {
      const isClosing = match.startsWith("</");
      const tag = String(rawTag).toLowerCase();
      if (DANGEROUS.has(tag)) return "";
      if (!ALLOWED.has(tag)) {
        // Unwrap: keep inner text (already outside tags), drop tag itself.
        return "";
      }
      if (isClosing) return `</${tag}>`;
      if (tag === "br") return "<br>";
      if (tag === "a") {
        const hrefMatch = match.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
        const href = (hrefMatch?.[1] ?? hrefMatch?.[2] ?? "").trim();
        if (!HREF_OK.test(href)) return `<a target="_blank" rel="noopener noreferrer">`;
        const safe = href.replace(/"/g, "&quot;");
        return `<a href="${safe}" target="_blank" rel="noopener noreferrer">`;
      }
      return `<${tag}>`;
    })
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");
}

export default { sanitizeBlogHtml };
