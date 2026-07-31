/**
 * Runtime-free offline eval harness for cognia-web-tools.
 *
 * `pnpm plugin:eval` cannot load the real plugin entry (`src/index.ts` imports
 * the Next app — `@/lib/...`, Zustand stores), so this harness provides a
 * deterministic, network-free stand-in for each tool. Its job is to verify the
 * tool CONTRACT (input → output shape) in CI; model tool-SELECTION is verified
 * separately by the `--online` cases run inside the app.
 *
 * Keep the output shape in lockstep with `src/index.ts`'s `web_fetch` (readable
 * text extraction) so a contract drift is caught here.
 */

const FIXTURES = {
  "https://example.com":
    "Example Domain\n\nThis domain is for use in illustrative examples in documents.",
}

/**
 * @param {string} name tool name as declared in the manifest
 * @param {Record<string, unknown>} args
 * @returns {Promise<unknown>}
 */
export async function invokeTool(name, args) {
  if (name === "web_fetch") {
    const url = String(args.url ?? "")
    const body = FIXTURES[url]
    if (body === undefined) throw new Error(`no fixture for url: ${url}`)
    return body
  }
  throw new Error(`unknown tool: ${name}`)
}
