/**
 * `cognia-agent lark <…>` — Feishu principal-registry administration for
 * headless installs (plan 2026-07-24 P1.1).
 *
 * The registry fails closed: an unbound sender is parked and answered with a
 * bind code. On desktop an operator approves it in Settings → Connections; a
 * headless deployment has no UI, and that is what this command is for.
 *
 * It deliberately does NOT open the account database. Headless persistence is
 * fake-indexeddb plus a debounced JSON snapshot owned by the running `serve`
 * process — a second writer would lose whichever flush landed last. Instead it
 * submits the operation to the companion API, which hands it to the brain over
 * the Lark intent bridge, then polls for the answer.
 *
 * Auth reuses the existing service-token tier (`COGNIA_SERVICE_TOKEN`), which
 * the companion honors only from loopback — so this command is meant to run on
 * the host serving the API, exactly like the brain it talks to.
 */

import { larkMenuManifest } from "@/lib/connectors/commands/registry"
import { type ParsedArgs } from "./args"
import { realOutput, type OutputSink } from "./output"

export const LARK_HELP = `cognia-agent lark — Feishu identity registry (headless operator channel)

Usage:
  cognia-agent lark list                        pending bind requests + bound principals
  cognia-agent lark approve <code> [--user id]  approve a bind request
  cognia-agent lark reject <code>               close a bind request without binding
  cognia-agent lark disable <principalId>       stop a principal from executing
  cognia-agent lark enable <principalId>        re-activate a principal
  cognia-agent lark unlink <principalId>        detach a principal's Cognia linkage
  cognia-agent lark rebind <principalId> --user <id>
                                                point a principal at another
                                                account-local Cognia user
  cognia-agent lark tenant register             admit this adapter's tenant scope
  cognia-agent lark tenant disable|enable       flip the tenant's admission
  cognia-agent lark authorize [--redirect <u>]  print the send-as-user OAuth
                                                URL to open in a browser
  cognia-agent lark sweep                       expire stale bind requests
  cognia-agent lark menu-manifest               bot-menu items to configure in
                                                the Feishu developer console

Flags:
  --adapter <id>   Lark adapter id (or COGNIA_LARK_ADAPTER_ID)
  --user <id>      account-local user id for approve (defaults to the account)
  --redirect <u>   OAuth redirect_uri for authorize (defaults to
                   $COGNIA_LARK_PUBLIC_BASE/connectors/oauth/lark/callback)
  --server-url <u> companion base URL (or COGNIA_SERVER_URL)
  --json           print the raw result object

Env: COGNIA_SERVICE_TOKEN (required), COGNIA_SERVER_URL, COGNIA_LARK_ADAPTER_ID
`

/** Poll budget — the companion drops an unanswered intent after 60 s. */
const POLL_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 500

interface AdminRequest {
  op: string
  adapterId: string
  code?: string
  principalId?: string
  status?: string
  cogniaUserId?: string
  redirectUri?: string
}

export interface LarkCommandDeps {
  out?: OutputSink
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
  /** Injected so tests never actually wait. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Map the operator-facing verb onto the wire op. Keeping the CLI verbs
 * (`disable`/`enable`/`unlink`) separate from the single wire op
 * (`set-principal-status`) means the transport never has to grow a verb.
 */
function buildRequest(args: ParsedArgs, adapterId: string): AdminRequest | { error: string } {
  const [first, second] = args.positionals
  switch (args.subcommand) {
    case "list":
      return { op: "list", adapterId }
    case "sweep":
      return { op: "sweep", adapterId }
    case "authorize":
      // The brain mints state + PKCE and keeps the verifier; this command only
      // relays the resulting URL, so nothing secret passes through the CLI.
      return {
        op: "oauth-begin",
        adapterId,
        ...(stringFlag(args, "redirect") ? { redirectUri: stringFlag(args, "redirect") } : {}),
      }
    case "approve":
      if (!first) return { error: "lark approve: missing <code>" }
      return {
        op: "approve",
        adapterId,
        code: first,
        ...(stringFlag(args, "user") ? { cogniaUserId: stringFlag(args, "user") } : {}),
      }
    case "reject":
      if (!first) return { error: "lark reject: missing <code>" }
      return { op: "reject", adapterId, code: first }
    case "rebind": {
      if (!first) return { error: "lark rebind: missing <principalId>" }
      const user = stringFlag(args, "user")
      if (!user) return { error: "lark rebind: missing --user <id>" }
      return { op: "rebind", adapterId, principalId: first, cogniaUserId: user }
    }
    case "disable":
    case "enable":
    case "unlink": {
      if (!first) return { error: `lark ${args.subcommand}: missing <principalId>` }
      const status =
        args.subcommand === "disable"
          ? "disabled"
          : args.subcommand === "enable"
            ? "active"
            : "unlinked"
      return { op: "set-principal-status", adapterId, principalId: first, status }
    }
    case "tenant": {
      if (second === undefined && first === "register") {
        return { op: "register-tenant", adapterId }
      }
      if (first === "register") return { op: "register-tenant", adapterId }
      if (first === "disable") return { op: "set-tenant-status", adapterId, status: "disabled" }
      if (first === "enable") return { op: "set-tenant-status", adapterId, status: "active" }
      return { error: "lark tenant: expected register | disable | enable" }
    }
    default:
      return { error: "lark: expected a subcommand — see `cognia-agent lark --help`" }
  }
}

function renderResult(out: OutputSink, op: string, result: Record<string, unknown>): void {
  if (op === "oauth-begin") {
    out.write(`redirect_uri (must be registered in the Feishu console):\n`)
    out.write(`  ${String(result.redirectUri)}\n\n`)
    out.write("Open this URL in a browser signed in to Feishu:\n")
    out.write(`  ${String(result.authorizeUrl)}\n\n`)
    out.write("The link is valid for 10 minutes. Completion lands in the running brain.\n")
    return
  }
  if (op !== "list") {
    out.write(JSON.stringify(result) + "\n")
    return
  }
  const tenant = result.tenant as { tenantKey?: string; appId?: string } | null
  out.write(
    tenant ? `tenant: ${tenant.tenantKey} / ${tenant.appId}\n` : "tenant: unknown (run whoami)\n"
  )
  const requests = (result.requests ?? []) as Array<Record<string, unknown>>
  out.write(`pending bind requests (${requests.length}):\n`)
  for (const request of requests) {
    out.write(`  ${String(request.code)}  ${String(request.openId)}\n`)
  }
  const principals = (result.principals ?? []) as Array<Record<string, unknown>>
  out.write(`bound principals (${principals.length}):\n`)
  for (const principal of principals) {
    out.write(
      `  ${String(principal.id)}  ${String(principal.openId)}  ${String(principal.status)}\n`
    )
  }
}

export async function larkCommand(args: ParsedArgs, deps: LarkCommandDeps = {}): Promise<number> {
  const out = deps.out ?? realOutput
  const env = deps.env ?? process.env
  const doFetch = deps.fetch ?? fetch
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const now = deps.now ?? Date.now

  if (args.help || !args.subcommand) {
    out.write(LARK_HELP)
    return args.subcommand ? 0 : 2
  }

  // Local, offline, and brain-independent: the manifest is derived purely from
  // the command registry, so it works before anything is deployed.
  if (args.subcommand === "menu-manifest") {
    const manifest = larkMenuManifest()
    if (args.flags.json) {
      out.json(manifest)
      return 0
    }
    out.write("Feishu console → Bot → Bot menu (action: 发送文字消息, client V7.22+)\n")
    for (const item of manifest) out.write(`  ${item.name}\t${item.text}\n`)
    return 0
  }

  const serverUrl = stringFlag(args, "server-url") ?? env.COGNIA_SERVER_URL
  if (!serverUrl) {
    out.error("lark: missing --server-url / COGNIA_SERVER_URL")
    return 2
  }
  const token = env.COGNIA_SERVICE_TOKEN
  if (!token) {
    out.error("lark: COGNIA_SERVICE_TOKEN is not set (env-only by design)")
    return 2
  }
  const adapterId = stringFlag(args, "adapter") ?? env.COGNIA_LARK_ADAPTER_ID
  if (!adapterId) {
    out.error("lark: missing --adapter / COGNIA_LARK_ADAPTER_ID")
    return 2
  }

  const request = buildRequest(args, adapterId)
  if ("error" in request) {
    out.error(request.error)
    return 2
  }

  const base = serverUrl.replace(/\/+$/, "")
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` }

  let requestId: string
  try {
    const response = await doFetch(`${base}/operator/lark/admin`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    })
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (response.status !== 202 || typeof body.requestId !== "string") {
      out.error(`lark: submit failed (${response.status} ${String(body.error ?? "unknown")})`)
      return 1
    }
    requestId = body.requestId
  } catch (err) {
    out.error(`lark: cannot reach the companion API — ${(err as Error).message}`)
    return 1
  }

  // The brain answers asynchronously; poll until it does. A brain that is not
  // running never answers, so the timeout is the "is anything listening?"
  // signal and says so instead of hanging forever.
  const deadline = now() + POLL_TIMEOUT_MS
  while (now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    let body: Record<string, unknown>
    try {
      const response = await doFetch(`${base}/operator/lark/admin/${requestId}`, { headers })
      body = (await response.json().catch(() => ({}))) as Record<string, unknown>
      if (response.status === 404) {
        out.error("lark: the request expired before the brain answered")
        return 1
      }
    } catch (err) {
      out.error(`lark: poll failed — ${(err as Error).message}`)
      return 1
    }
    if (body.status === "done") {
      const result = (body.result ?? {}) as Record<string, unknown>
      if (args.flags.json) out.json(result)
      else renderResult(out, request.op, result)
      return 0
    }
    if (body.status === "error") {
      out.error(`lark: ${String(body.error ?? "admin_failed")}`)
      return 1
    }
  }

  out.error("lark: timed out waiting for the brain — is `cognia-agent serve` running?")
  return 1
}
