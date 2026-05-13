/**
 * Manual Jest mock for `@octokit/core` v7+.
 *
 * The real package is `"type": "module"` (pure ESM) and the Next.js Babel
 * transform doesn't strip ESM imports inside node_modules, so loading it from
 * a Jest CJS test environment fails with "Cannot use import statement outside
 * a module".
 *
 * This mock matches the surface our `lib/github/` modules use:
 *   - `Octokit` constructor stores opts and exposes `auth()`, `request()`.
 *   - `Octokit.plugin(...)` returns a subclass with the same surface.
 *   - When `authStrategy` is provided, the constructor invokes it once with
 *     `{ token: opts.auth }` and stores the result for `auth()` / `request()`.
 *
 * Tests can drill in via `client.__opts` / `client.__authResult` if they need
 * to inspect what was passed.
 */

class Octokit {
  constructor(opts = {}) {
    this.__opts = opts
    this.__authResult = null
    if (typeof opts.authStrategy === "function") {
      const strategy = opts.authStrategy({ token: opts.auth })
      // The token-strategy callable is itself an `auth()` returning the cred record.
      this.__authResult = strategy
    }
  }

  async auth(authOpts) {
    if (typeof this.__authResult === "function") {
      return this.__authResult(authOpts)
    }
    if (this.__authResult && typeof this.__authResult.then === "function") {
      return this.__authResult
    }
    return { type: "token", token: this.__opts.auth }
  }

  request = jest.fn(async () => ({ data: {}, status: 200, headers: {}, url: "" }))

  static plugin(...plugins) {
    const Subclass = class extends Octokit {}
    Subclass.__plugins = (Octokit.__plugins || []).concat(plugins)
    return Subclass
  }
}

Octokit.__plugins = []

module.exports = { Octokit }
