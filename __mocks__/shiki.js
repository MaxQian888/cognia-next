/**
 * Jest mock for `shiki`.
 *
 * shiki ships ESM-only and Next.js's default Jest transform list ignores
 * everything under `.pnpm/` outside its own short whitelist, so the real
 * package can't be loaded inside Jest. Tests don't need real syntax
 * highlighting — they only need the module to load. This mock returns
 * the input unchanged.
 */

module.exports = {
  codeToHtml: async (code, _options) => `<pre><code>${code}</code></pre>`,
  codeToHast: async (code) => ({
    type: "root",
    children: [{ type: "text", value: code }],
  }),
  getHighlighter: async () => ({
    codeToHtml: (code) => `<pre><code>${code}</code></pre>`,
    dispose: () => undefined,
  }),
  createHighlighter: async () => ({
    codeToHtml: (code) => `<pre><code>${code}</code></pre>`,
    dispose: () => undefined,
  }),
  bundledLanguages: {},
  bundledThemes: {},
}
