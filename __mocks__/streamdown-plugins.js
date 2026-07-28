/**
 * CJS-compatible shapes for Streamdown's ESM-only optional plugins.
 *
 * Jest tests exercise Cognia's wrappers rather than the plugins' browser
 * rendering internals, so stable no-op plugin objects are sufficient here.
 */
function createCodePlugin(options = {}) {
  return { name: "code", type: "code", options }
}

const math = { name: "math", type: "math" }
const mermaid = { name: "mermaid", type: "mermaid" }

module.exports = { createCodePlugin, math, mermaid }
module.exports.__esModule = true
