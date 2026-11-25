/** Marker substituted for anything that looks like a credential. */
export const REDACTED = '[REDACTED]';

const SECRET_KEYS =
  'api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret|password|passwd|pwd|token|auth|authorization|session[_-]?id|session|cookie|set-cookie|signature|sig';

// Ordered: structured headers first, then URL userinfo, then key=value pairs,
// then a trailing Bearer scheme. Global regexes are reset by String.replace.
const PATTERNS: Array<[RegExp, string]> = [
  [
    /(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)(\s*["']?\s*:\s*["']?)[^\r\n,;"']+/gi,
    `$1$2${REDACTED}`,
  ],
  [/(:\/\/[^/\s:@]+:)[^@\s/]+@/g, `$1${REDACTED}@`],
  [
    new RegExp(`([?&\\s"'{,]|^)(${SECRET_KEYS})(\\s*["']?\\s*[=:]\\s*["']?)(?!\\[REDACTED\\])([^&\\s"'<>;,)\\]]+)`, 'gi'),
    `$1$2$3${REDACTED}`,
  ],
  [/(bearer\s+)(?!\[REDACTED\])[^\s,;"'<>]+/gi, `$1${REDACTED}`],
];

/**
 * Scrub credential-shaped substrings from a string before it is written to a
 * client body or a log line. This is deliberately pattern-based: upstream
 * errors are free-form text and may embed a URL, a header or a raw `key=value`.
 */
export function redactSecrets(value: unknown): string {
  let out = typeof value === 'string' ? value : value == null ? '' : String(value);
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
