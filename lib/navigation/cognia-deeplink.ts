/**
 * Platform-neutral parser for every first-party `cognia://` route, plus the
 * one route on the reverse-domain scheme (`cn.cognia.app:/auth/callback`).
 */
export type CogniaDeeplinkRoute =
  | {
      kind: "oauth_callback"
      provider: string
      code: string | null
      state: string | null
      raw: string
    }
  | {
      /**
       * The authorization response landing on the native application:
       * `cognia://logto/callback?code=…&state=…` from a Logto issuer, or
       * `cn.cognia.app:/auth/callback?…` from any other OIDC issuer
       * (`nativeCallbackUriFor` in `lib/logto/client.ts`). Consumed by the cloud
       * sign-in gate on the desktop and by the Capacitor drivers; carries the
       * raw parameters and no verdict, because only the flow that minted the
       * `state` can validate it.
       */
      kind: "logto_callback"
      code: string | null
      state: string | null
      error: string | null
      raw: string
    }
  | { kind: "pair_qr"; payload: string; raw: string }
  | { kind: "open_session"; sessionId: string; raw: string }
  /**
   * One issue on the board (`cognia://issues/<id>`). The Browser Companion
   * mints these for a page filed as an issue; `/issues?id=` is the page.
   */
  | { kind: "open_issue"; issueId: string; raw: string }
  /**
   * One agent task (`cognia://agent-tasks/<id>`). Minted by the Browser
   * Companion for a page handed to an agent. There is no page of its own —
   * the task board lives with the agent in Settings → Characters — so the
   * desktop resolves it at click time: the task's conversation when it has
   * one, the board otherwise.
   */
  | { kind: "open_agent_task"; taskId: string; raw: string }
  | { kind: "share_target"; text?: string; url?: string; raw: string }
  | { kind: "open_workflow_run"; workflowId: string; runId: string; raw: string }
  | { kind: "open_im"; conversationKey?: string; raw: string }
  | {
      kind: "open_scheduler_task"
      taskId?: string
      /**
       * Promotion wake-up token (`?run=<token>`), present only on links minted
       * by the OS-scheduler promotion. The desktop handler runs the task iff it
       * matches the task's stored token; without it the link only navigates.
       */
      runToken?: string
      raw: string
    }
  | { kind: "open_settings"; settingsTab?: string; raw: string }
  | { kind: "open_workspace"; workspacePath?: string; raw: string }
  | { kind: "unknown"; raw: string }

/** The RFC 8252 private-use scheme of `OIDC_NATIVE_CALLBACK_URI`. */
const OIDC_CALLBACK_PROTOCOL = "cn.cognia.app:"

/**
 * The reverse-domain scheme carries exactly one route, spelled without an
 * authority (`cn.cognia.app:/auth/callback`). Anything else on it, including
 * `cn.cognia.app://auth/callback` where `auth` would be a host, is unknown.
 */
function parseOidcCallback(url: URL, raw: string): CogniaDeeplinkRoute {
  if (url.hostname !== "" || url.pathname !== "/auth/callback") return { kind: "unknown", raw }
  return {
    kind: "logto_callback",
    code: url.searchParams.get("code"),
    state: url.searchParams.get("state"),
    error: url.searchParams.get("error"),
    raw,
  }
}

export function parseCogniaDeeplink(raw: string): CogniaDeeplinkRoute {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { kind: "unknown", raw }
  }
  if (url.protocol === OIDC_CALLBACK_PROTOCOL) return parseOidcCallback(url, raw)
  if (url.protocol !== "cognia:") return { kind: "unknown", raw }

  const host = url.hostname || url.pathname.replace(/^\/+/, "").split("/")[0] || ""
  const path = url.pathname.replace(/^\/+/, "")
  const params = url.searchParams

  if (host === "oauth") {
    return {
      kind: "oauth_callback",
      provider: path || params.get("provider") || "default",
      code: params.get("code"),
      state: params.get("state"),
      raw,
    }
  }
  if (host === "logto" && (path === "" || path === "callback")) {
    return {
      kind: "logto_callback",
      code: params.get("code"),
      state: params.get("state"),
      error: params.get("error"),
      raw,
    }
  }
  if (host === "pair") {
    return { kind: "pair_qr", payload: params.get("payload") ?? path, raw }
  }
  if (host === "session" || host === "chat") {
    return { kind: "open_session", sessionId: path || params.get("id") || "", raw }
  }
  if (host === "issues" || host === "issue") {
    return { kind: "open_issue", issueId: firstSegment(path) || params.get("id") || "", raw }
  }
  if (host === "agent-tasks" || host === "agent-task") {
    return {
      kind: "open_agent_task",
      taskId: firstSegment(path) || params.get("id") || "",
      raw,
    }
  }
  if (host === "share") {
    return {
      kind: "share_target",
      text: params.get("text") ?? undefined,
      url: params.get("url") ?? undefined,
      raw,
    }
  }
  if (host === "workflow-run") {
    const parts = path.split("/").filter(Boolean)
    return {
      kind: "open_workflow_run",
      workflowId: parts[0] ?? params.get("workflowId") ?? "",
      runId: parts[1] ?? params.get("runId") ?? "",
      raw,
    }
  }
  if (host === "im") {
    return { kind: "open_im", conversationKey: params.get("conversationKey") ?? undefined, raw }
  }
  if (host === "scheduler") {
    const parts = path.split("/").filter(Boolean)
    const runToken = params.get("run")
    return {
      kind: "open_scheduler_task",
      taskId: parts[0] === "task" ? parts[1] : (params.get("taskId") ?? undefined),
      runToken: runToken && runToken.length > 0 ? runToken : undefined,
      raw,
    }
  }
  if (host === "settings") {
    return { kind: "open_settings", settingsTab: params.get("tab") ?? undefined, raw }
  }
  if (host === "workspace") {
    return { kind: "open_workspace", workspacePath: params.get("path") ?? undefined, raw }
  }
  return { kind: "unknown", raw }
}

/**
 * The first path segment, percent-decoded.
 *
 * The Browser Companion builds these links with `encodeURIComponent`, so an id
 * with a reserved character arrives escaped. A malformed escape is kept as
 * written rather than thrown: the lookup it feeds then finds nothing, which is
 * the right answer for an id nobody minted.
 */
function firstSegment(path: string): string {
  const segment = path.split("/").filter(Boolean)[0] ?? ""
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** Session ids the path form can carry verbatim (what `newId` mints). */
const PATH_SAFE_ID = /^[A-Za-z0-9._~-]+$/

/**
 * The `cognia://` link that opens one conversation — the inverse of the
 * `open_session` branch above, which is how the OS hands it back.
 *
 * The parser reads the path undecoded, so only an id that needs no escaping
 * goes in the path (`cognia://session/<id>`, the form the CLI's `open` prints
 * and the Browser Companion mints); anything else rides the `id` query
 * parameter, which `URLSearchParams` does decode.
 */
export function buildSessionDeeplink(sessionId: string): string {
  if (PATH_SAFE_ID.test(sessionId)) return `cognia://session/${sessionId}`
  return `cognia://session?id=${encodeURIComponent(sessionId)}`
}
