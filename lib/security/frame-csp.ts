/**
 * Shared `<meta http-equiv="Content-Security-Policy">` injector for the
 * srcdoc-backed sandboxes.
 *
 * Three surfaces need the exact same thing — take an HTML document a third
 * party authored, and force a policy onto it before it is handed to an
 * opaque-origin iframe: MCP Apps (`lib/mcp/apps-sandbox.ts`), interactive HTML
 * artifacts (`lib/artifacts/preview-utils.ts`), and anything that follows.
 * Injection is the half that is easy to get subtly wrong (a document with no
 * `<head>`, a policy containing a double quote), so it lives once here and the
 * callers only own their directive list.
 */

/** A CSP directive list, in the order it should be serialized. */
export type FrameCspDirectives = Array<readonly [directive: string, value: string]>

/**
 * Serialize directives into a policy string. Values are used verbatim — the
 * caller is responsible for validating origins (see `normalizeOrigin` in
 * `lib/mcp/apps-sandbox.ts`); this only owns the `name value; name value` shape.
 */
export function serializeFrameCsp(directives: FrameCspDirectives): string {
  return directives.map(([directive, value]) => `${directive} ${value}`).join("; ")
}

/**
 * Splice a CSP meta tag into `html` as the FIRST child of `<head>`, so it
 * governs every element after it. A document with no `<head>` is wrapped in
 * one rather than left unprotected.
 *
 * The policy is attribute-escaped: a stray `"` would otherwise close the
 * attribute and turn the rest of the policy into markup.
 */
export function injectFrameCsp(html: string, policy: string): string {
  return injectFrameHead(
    html,
    `<meta http-equiv="Content-Security-Policy" content="${policy.replaceAll('"', "&quot;")}">`
  )
}

/**
 * Splice `markup` in as the FIRST child of `<head>`. Everything a sandboxed
 * document must see before its own content — the policy, and the bootstrap
 * script that will run its code — arrives this way.
 */
export function injectFrameHead(html: string, markup: string): string {
  return /<head[\s>]/i.test(html)
    ? html.replace(/<head[^>]*>/i, (tag) => `${tag}${markup}`)
    : `<!doctype html><html><head>${markup}</head><body>${html}</body></html>`
}
