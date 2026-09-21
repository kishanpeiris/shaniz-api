import sanitizeHtml from 'sanitize-html'

// Formatted text from the admin editor is saved as small, safe HTML.
// This runs on the SERVER on every save — the browser can't be trusted,
// so even a hand-crafted request can't store a script.
const OPTIONS = {
  allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'span', 'mark', 'a', 'div'],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    // colour / highlight / alignment styles — nothing else is kept
    span: ['style'],
    p: ['style'],
    div: ['style'],
    li: ['style'],
    h2: ['style'],
    h3: ['style'],
    h4: ['style'],
    mark: ['style'],
    b: ['style'],
    strong: ['style'],
    i: ['style'],
    em: ['style'],
    u: ['style'],
    s: ['style'],
    strike: ['style'],
    blockquote: ['style'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedStyles: {
    '*': {
      color: [/^#[0-9a-fA-F]{3,8}$/, /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/, /^[a-zA-Z]{3,20}$/],
      'background-color': [/^#[0-9a-fA-F]{3,8}$/, /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/, /^[a-zA-Z]{3,20}$/],
      'text-align': [/^(left|center|right|justify)$/],
    },
  },
  transformTags: {
    a: (tag, attribs) => ({ tagName: 'a', attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } }),
  },
}

const looksLikeHtml = (t) => /<\/?(p|h[1-6]|ul|ol|li|strong|em|b|i|u|s|span|div|br|a|mark|blockquote)\b/i.test(t)

// Text that has HTML in it is cleaned; older plain / markdown-style text
// is left exactly as it was (the storefront converts it when displaying).
export function cleanRichText(text) {
  if (typeof text !== 'string' || !text) return text
  return looksLikeHtml(text) ? sanitizeHtml(text, OPTIONS) : text
}
