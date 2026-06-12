/**
 * CJS mock for `chalk` (v5, ESM-only) used in Jest tests.
 *
 * `chalk` v5 ships ESM-only and resolves through pnpm's `.pnpm/` layout, which
 * `next/jest`'s injected transformIgnorePatterns always excludes from
 * transformation — so the real module can't load under Jest (the same reason
 * `ink`, `shiki`, etc. are mocked here). The only importer is the TUI syntax
 * highlighter (`cli/src/tui/markdown/highlight.ts`).
 *
 * Behaviour mirrors real chalk in a NON-TTY environment (colour level 0): every
 * style is a passthrough that returns its input unchanged, so highlighted output
 * equals the original text after stripping — exactly what chalk does in Jest
 * anyway. Colour factories (`hex`, `rgb`, …) return a styler function so callers
 * like `chalk.hex(value)(text)` keep working.
 */
const identity = (s) => (typeof s === "string" ? s : "")

// Colour factories take a colour argument and return a styler function.
const factory = () => identity
const FACTORIES = new Set([
  "hex",
  "rgb",
  "ansi256",
  "bgHex",
  "bgRgb",
  "bgAnsi256",
  "ansi",
  "bgAnsi",
])

const chalk = new Proxy(identity, {
  get(_target, prop) {
    if (prop === "__esModule") return true
    if (prop === "default" || prop === "Chalk") return chalk
    if (typeof prop === "symbol") return identity[prop]
    if (prop === "level") return 0
    if (FACTORIES.has(prop)) return factory
    // Named colours / modifiers (red, gray, bold, redBright, …) are passthroughs.
    return identity
  },
  apply(_target, _thisArg, args) {
    return identity(args[0])
  },
})

module.exports = chalk
