/**
 * Jest mock for `@xterm/addon-ligatures`.
 *
 * Not an ESM-only package like the other mocks here — this one is simply
 * mis-packaged. `@xterm/addon-ligatures@0.10.0` declares
 * `"main": "lib/addon-ligatures.js"` but ships only `lib/addon-ligatures.mjs`,
 * so there is no CJS entry for Jest's resolver to find and *every* suite whose
 * module graph reaches `components/terminal/terminal-instance.tsx` fails to
 * load with `Cannot find module '@xterm/addon-ligatures'` — the import is
 * dynamic and try/caught in the component, but resolution happens at
 * `moduleNameMapper` time, long before the try/catch can swallow anything.
 *
 * Pointing the mapping at the real `.mjs` is not an option: it would need to
 * join the transformIgnorePatterns allowlist, and it pulls in `font-finder` /
 * `font-ligatures`, which read font files off the real filesystem. jsdom has
 * no fonts to shape.
 *
 * The shape is faithful rather than empty on purpose. `terminal-instance.tsx`
 * does `new LigaturesAddon()` and hands the result to `term.loadAddon(...)`,
 * with a `catch` that silently degrades to no ligatures. An empty stub would
 * make `LigaturesAddon` undefined, so every suite that renders the terminal
 * with `fontLigatures: true` and does not `jest.mock()` this module would take
 * the catch branch and prove nothing. A real constructor exercises the live
 * path instead.
 */

class LigaturesAddon {
  constructor(options) {
    this.options = options
    this.disposed = false
  }

  // xterm calls this when the addon is loaded; the real one starts font
  // lookup here, which is exactly what jsdom cannot do.
  activate(_terminal) {}

  dispose() {
    this.disposed = true
  }
}

module.exports = { LigaturesAddon }
