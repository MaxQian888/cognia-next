/**
 * CJS-compatible shape for @streamdown/cjk.
 *
 * The package exposes only an ESM `import` condition, which Jest's CommonJS
 * resolver cannot load through transitive MarkdownRenderer imports. The real
 * CJK transformations are exercised in browser builds; unit tests retain the
 * before/GFM/after ordering contract with named no-op plugins.
 */
function cjkBefore() {}
function cjkAfter() {}

const cjk = {
  name: "cjk",
  type: "cjk",
  remarkPluginsBefore: [cjkBefore],
  remarkPluginsAfter: [cjkAfter],
  remarkPlugins: [cjkBefore, cjkAfter],
}

module.exports = { cjk, createCjkPlugin: () => cjk }
module.exports.__esModule = true
