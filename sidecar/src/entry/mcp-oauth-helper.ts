import nodePath from "node:path"
import { pathToFileURL } from "node:url"
import { runFlow } from "../mcp/oauth/flow.ts"
import { prepareHeadlessFlow, completeHeadlessFlow } from "../mcp/oauth/headless.ts"
import { msg, type HeadlessInput } from "../mcp/oauth/types.ts"
export { parseCallback } from "../mcp/oauth/callback.ts"
export { randomState, buildProvider } from "../mcp/oauth/provider.ts"
export { runFlow } from "../mcp/oauth/flow.ts"
export { prepareHeadlessFlow, completeHeadlessFlow } from "../mcp/oauth/headless.ts"

/** Read one JSON line from stdin. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (d) => {
      buf += d
      const i = buf.indexOf("\n")
      if (i >= 0) resolve(buf.slice(0, i))
    })
    process.stdin.on("end", () => resolve(buf))
  })
}

// Only the separately shipped helper owns this one-shot stdin protocol.
// Bundling collapses import.meta.url onto the host entry, so URL equality alone
// also starts this helper inside claude-host.mjs. A spawned helper may inherit
// COGNIA_ROLE from its parent; its own filename and URL, not that role, identify it.
export function isMcpOauthHelperEntry({
  importUrl,
  argvPath,
}: {
  importUrl: string
  argvPath?: string
  role?: unknown
}) {
  if (typeof argvPath !== "string" || nodePath.basename(argvPath) !== "mcp-oauth-helper.mjs")
    return false
  return importUrl === pathToFileURL(nodePath.resolve(argvPath)).href
}

export function runMcpOauthHelper() {
  const mode = process.argv[2] ?? "authenticate"
  readStdin()
    .then(async (line) => {
      let input: HeadlessInput
      try {
        input = JSON.parse(line)
      } catch {
        return { result: { ok: false, status: "error", message: "invalid stdin JSON" }, entry: {} }
      }
      if (mode === "headless-prepare") {
        return prepareHeadlessFlow({
          server: input.server,
          entry: input.entry,
          redirectUrl: input.redirectUrl,
          state: input.state,
        })
      }
      if (mode === "headless-complete") {
        return completeHeadlessFlow({
          server: input.server,
          entry: input.entry,
          redirectUrl: input.redirectUrl,
          state: input.state,
          code: input.code,
        })
      }
      return runFlow({
        server: input.server,
        entry: input.entry,
        mode: mode === "refresh" ? "refresh" : "authenticate",
      })
    })
    .then((out) => {
      process.stdout.write(JSON.stringify(out) + "\n")
      process.exit(0)
    })
    .catch((err) => {
      process.stdout.write(
        JSON.stringify({ result: { ok: false, status: "error", message: msg(err) }, entry: {} }) +
          "\n"
      )
      process.exit(0)
    })
}
