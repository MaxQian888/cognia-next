/**
 * External Bridge — first-class `browser_*` tools (ADR-0201).
 *
 * External agents used to reach the browser only through the generic
 * `plugin_tool_invoke`, which skipped the per-tool approval flag and had no
 * notion of a browser session. These tools publish the SAME definitions the
 * in-app agent sees (`packages/plugin-sdk/src/api/browser-tool-definitions.ts`) and run the
 * SAME plugin executors, with:
 *
 *  - one scope, `browser:control`, default OFF and independent of any
 *    character's tool settings (checked by the MCP server before this runs);
 *  - a browser session bound to each MCP client: every call from a client
 *    carries the synthetic chat session id `external-bridge:browser:<client>`,
 *    so the plugin keeps that client's backend choice (`browser_open`) and
 *    download attachments apart from every other client and chat;
 *  - the tool's approval flag honoured: a `requiresApproval` tool asks the user
 *    in-app before it runs; `browser_fill_credential` asks on EVERY call and
 *    its approval can never be remembered;
 *  - on a client's first call, the browser pane is revealed when a person can
 *    see the window, otherwise a headless local-Chromium session is started
 *    (when installed) so the agent is not driving an invisible embedded pane.
 *
 * Wire path mirrors `orchestration.ts`: the renderer runs the core directly;
 * the Node MCP sidecar forwards `browser_tool` over the orchestration proxy.
 *
 * PII: page content leaves Cognia here, so every string in the result is run
 * through `redactText` (image bytes excepted) before it crosses the boundary,
 * and the redacted result must then pass `hasNoLeakingPiiDeep`: anything the
 * redactor could not mask is withheld (`pii_blocked`), never sent. Error text
 * from a thrown call is redacted, gated and fenced the same way.
 */

import { isTauri } from "@/lib/tauri"
import { proxyToRenderer } from "@/lib/external-bridge/orchestration-proxy-client"
import { wrapUntrusted } from "@/lib/external-bridge/untrusted"
import {
  BROWSER_TOOL_DEFINITIONS,
  BROWSER_TOOL_NAMES,
  type BrowserToolName,
} from "@cognia/plugin-sdk/api/browser"

export const BROWSER_TOOLS_PLUGIN_ID = "cognia-browser-tools"

/**
 * Consent identities. Grantable tools share one ("Always allow this session"
 * covers them); the per-call identity is cleared before and after every ask,
 * so a remembered grant can never satisfy it.
 */
export const BROWSER_BRIDGE_CONSENT_ID = `${BROWSER_TOOLS_PLUGIN_ID}:external-bridge`
export const BROWSER_BRIDGE_PER_CALL_CONSENT_ID = `${BROWSER_TOOLS_PLUGIN_ID}:external-bridge:per-call`

/**
 * Tools whose approval is asked on every call and never remembered — the same
 * set the in-app sidecar treats as per-call (`PER_CALL_PLUGIN_TOOL_NAMES`):
 * filling a vault password, and handing local files to a web page.
 */
export const PER_CALL_BROWSER_TOOLS: ReadonlySet<BrowserToolName> = new Set([
  "browser_fill_credential",
  "browser_set_files",
])

export interface BrowserToolInput {
  tool: string
  args?: Record<string, unknown>
  /** The MCP client identity (`mcp:<client>` or `mcp:stdio`). */
  clientId: string
}

export interface BrowserToolOutput {
  ok: boolean
  result?: unknown
  error?: string
  code?: string
  /** True iff a string in the result was PII-redacted on the way out. */
  redacted?: boolean
}

export function isBrowserToolName(name: string): name is BrowserToolName {
  return (BROWSER_TOOL_NAMES as readonly string[]).includes(name)
}

/** The chat session id a client's browser calls are bound to. */
export function bridgeBrowserSessionId(clientId: string): string {
  const normalized = clientId.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 128) || "client"
  return `external-bridge:browser:${normalized}`
}

export async function browserTool(input: BrowserToolInput): Promise<BrowserToolOutput> {
  if (isTauri()) return browserToolCore(input)
  return proxyToRenderer<BrowserToolOutput>("browser_tool", { ...input })
}

// ---------------------------------------------------------------------------
// Renderer side
// ---------------------------------------------------------------------------

/** Clients whose browser surface has been prepared this app session. */
const preparedClients = new Set<string>()

/** Test seam. */
export function __resetBrowserBridgeForTests(): void {
  preparedClients.clear()
}

export interface BrowserBridgeDeps {
  invokeTool(
    toolName: BrowserToolName,
    args: Record<string, unknown>,
    options: { sessionId: string; reason?: string }
  ): Promise<unknown>
  requestConsent(request: { consentId: string; reason: string; perCall: boolean }): Promise<boolean>
  isSurfaceVisible(): boolean
  revealPane(): boolean
  localChromiumInstalled(): Promise<boolean>
  translate(key: string, values?: Record<string, unknown>): Promise<string>
  redact(text: string): { text: string; redacted: boolean }
  /**
   * The outbound PII gate, run on the ALREADY-redacted result. Defaults to
   * `hasNoLeakingPiiDeep` from `@cognia/redact`.
   */
  piiFree?(value: unknown): boolean | Promise<boolean>
}

let depsOverride: BrowserBridgeDeps | null = null

/** Test seam: inject deps (pass `null` to restore the real ones). */
export function __setBrowserBridgeDepsForTests(deps: BrowserBridgeDeps | null): void {
  depsOverride = deps
}

async function defaultDeps(): Promise<BrowserBridgeDeps> {
  const [
    { invokePluginTool },
    { getPluginConsentBroker },
    openUrl,
    { localBrowser },
    { getRuntimeTranslator },
    { redactText },
  ] = await Promise.all([
    import("@/lib/plugin/core/invoke-plugin-tool"),
    import("@/lib/plugin/security/consent-broker"),
    import("@/lib/browser/open-url-request"),
    import("@/lib/browser/local-client"),
    import("@/lib/i18n/runtime-translator"),
    import("@cognia/redact"),
  ])
  return {
    invokeTool: async (toolName, args, options) =>
      (await invokePluginTool(BROWSER_TOOLS_PLUGIN_ID, toolName, args, options)).result,
    requestConsent: async ({ consentId, reason, perCall }) => {
      const broker = getPluginConsentBroker()
      if (perCall) broker.clearSessionGrantsForPlugin(consentId)
      try {
        return await broker.request({ pluginId: consentId, permission: "agent:control", reason })
      } finally {
        // "Always allow this session" must not outlive a per-call approval.
        if (perCall) broker.clearSessionGrantsForPlugin(consentId)
      }
    },
    isSurfaceVisible: openUrl.isBrowserSurfaceVisible,
    revealPane: () => openUrl.requestBrowserUrl("", { source: "agent" }),
    localChromiumInstalled: async () => {
      try {
        return (await localBrowser.status()).installed
      } catch {
        return false
      }
    },
    translate: async (key, values) =>
      (await getRuntimeTranslator("settings.externalBridge"))(key, values),
    redact: (text) => {
      const { redacted, map } = redactText(text)
      return { text: redacted, redacted: Object.keys(map).length > 0 }
    },
    piiFree: defaultPiiFree,
  }
}

async function defaultPiiFree(value: unknown): Promise<boolean> {
  const { hasNoLeakingPiiDeep } = await import("@cognia/redact")
  return hasNoLeakingPiiDeep(value)
}

/**
 * The value the PII gate inspects: image bytes are replaced by a placeholder
 * (base64 is not prose, and its character soup trips the key detectors), every
 * other leaf is kept.
 */
export function withoutImageBytes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutImageBytes)
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    const isImage = record.type === "image" && typeof record.data === "string"
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(record)) {
      out[key] = isImage && key === "data" ? "" : withoutImageBytes(child)
    }
    return out
  }
  return value
}

async function isPiiFree(deps: BrowserBridgeDeps, value: unknown): Promise<boolean> {
  try {
    return await (deps.piiFree ?? defaultPiiFree)(withoutImageBytes(value))
  } catch {
    // A gate that cannot run is a closed gate.
    return false
  }
}

const PII_BLOCKED_ERROR =
  "the browser result contained personal data that could not be redacted, so it was withheld"

/**
 * Redact every string leaf of a tool result. MCP image blocks keep their bytes
 * (base64 is not prose, and rewriting it would corrupt the image).
 */
export function redactBrowserResult(
  value: unknown,
  redact: BrowserBridgeDeps["redact"]
): { value: unknown; redacted: boolean } {
  let redacted = false
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const out = redact(node)
      if (out.redacted) redacted = true
      return out.text
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === "object") {
      const record = node as Record<string, unknown>
      const isImage = record.type === "image" && typeof record.data === "string"
      const out: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(record)) {
        out[key] = isImage && key === "data" ? child : walk(child)
      }
      return out
    }
    return node
  }
  return { value: walk(value), redacted }
}

/**
 * First call from a client: put the browser where a person can see it, or —
 * with nobody looking — run a headless local Chromium session for it.
 */
async function prepareSurface(
  deps: BrowserBridgeDeps,
  tool: BrowserToolName,
  clientId: string,
  sessionId: string
): Promise<void> {
  if (preparedClients.has(clientId)) return
  preparedClients.add(clientId)
  // `browser_open` does its own pane work with the backend it was asked for.
  if (tool === "browser_open") return
  if (deps.isSurfaceVisible()) {
    deps.revealPane()
    return
  }
  if (await deps.localChromiumInstalled()) {
    await deps.invokeTool("browser_open", { backend: "local-chromium" }, { sessionId })
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = []
  for (const key of [
    "url",
    "action",
    "backend",
    "credentialId",
    "downloadId",
    "targetPath",
    "expression",
  ]) {
    const value = args[key]
    if (typeof value === "string" && value) parts.push(`${key}=${value.slice(0, 200)}`)
  }
  if (Array.isArray(args.paths)) parts.push(`paths=${args.paths.slice(0, 10).join(", ")}`)
  return parts.join(" · ")
}

/** Renderer-side execution: validate → prepare → approve → run → redact. */
export async function browserToolCore(input: BrowserToolInput): Promise<BrowserToolOutput> {
  if (!input.tool || !isBrowserToolName(input.tool)) {
    return {
      ok: false,
      code: "unknown_tool",
      error: `unknown browser tool '${String(input.tool)}'`,
    }
  }
  const tool = input.tool
  const args = input.args && typeof input.args === "object" ? input.args : {}
  const clientId = input.clientId || "mcp:stdio"
  const sessionId = bridgeBrowserSessionId(clientId)
  const deps = depsOverride ?? (await defaultDeps())

  try {
    await prepareSurface(deps, tool, clientId, sessionId)

    const definition = BROWSER_TOOL_DEFINITIONS[tool]
    let reason: string | undefined
    if ("requiresApproval" in definition && definition.requiresApproval === true) {
      const perCall = PER_CALL_BROWSER_TOOLS.has(tool)
      const summary = summarizeArgs(args)
      reason = await deps.translate(
        perCall ? "browserApproval.perCallReason" : "browserApproval.reason",
        { client: clientId, tool, detail: summary || "—" }
      )
      const approved = await deps.requestConsent({
        consentId: perCall ? BROWSER_BRIDGE_PER_CALL_CONSENT_ID : BROWSER_BRIDGE_CONSENT_ID,
        reason,
        perCall,
      })
      if (!approved) {
        return { ok: false, code: "approval_denied", error: `the user declined ${tool}` }
      }
    }

    const result = await deps.invokeTool(tool, args, {
      sessionId,
      ...(reason ? { reason } : {}),
    })
    const { value, redacted } = redactBrowserResult(result, deps.redact)
    const flags = redacted ? { redacted: true } : {}
    // Redaction masks what it recognises; the gate refuses what is left.
    if (!(await isPiiFree(deps, value))) {
      return { ok: false, code: "pii_blocked", error: PII_BLOCKED_ERROR, ...flags }
    }
    // The plugin reports engine refusals as a `{ ok: false, code?, error }`
    // value rather than a throw; surface it as a failed call.
    if (value && typeof value === "object" && (value as { ok?: unknown }).ok === false) {
      const failure = value as { error?: unknown; code?: unknown }
      return {
        ok: false,
        result: value,
        error: typeof failure.error === "string" ? failure.error : `${tool} failed`,
        ...(typeof failure.code === "string" ? { code: failure.code } : {}),
        ...flags,
      }
    }
    return { ok: true, result: value, ...flags }
  } catch (err) {
    const code = (err as { code?: unknown } | undefined)?.code
    // Engine / page errors can quote page text: redact, gate and fence them.
    const raw = err instanceof Error ? err.message : String(err)
    const { text, redacted } = deps.redact(raw)
    const safe = await isPiiFree(deps, text)
    return {
      ok: false,
      error: safe ? wrapUntrusted(text) : PII_BLOCKED_ERROR,
      ...(!safe ? { code: "pii_blocked" } : typeof code === "string" ? { code } : {}),
      ...(redacted ? { redacted: true } : {}),
    }
  }
}
