/** Platform-neutral parser for every first-party `cognia://` route. */
export type CogniaDeeplinkRoute =
  | {
      kind: "oauth_callback"
      provider: string
      code: string | null
      state: string | null
      raw: string
    }
  | { kind: "pair_qr"; payload: string; raw: string }
  | { kind: "open_session"; sessionId: string; raw: string }
  | { kind: "share_target"; text?: string; url?: string; raw: string }
  | { kind: "open_workflow_run"; workflowId: string; runId: string; raw: string }
  | { kind: "open_im"; conversationKey?: string; raw: string }
  | { kind: "open_scheduler_task"; taskId?: string; raw: string }
  | { kind: "open_settings"; settingsTab?: string; raw: string }
  | { kind: "open_workspace"; workspacePath?: string; raw: string }
  | { kind: "unknown"; raw: string }

export function parseCogniaDeeplink(raw: string): CogniaDeeplinkRoute {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { kind: "unknown", raw }
  }
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
  if (host === "pair") {
    return { kind: "pair_qr", payload: params.get("payload") ?? path, raw }
  }
  if (host === "session" || host === "chat") {
    return { kind: "open_session", sessionId: path || params.get("id") || "", raw }
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
    return {
      kind: "open_scheduler_task",
      taskId: parts[0] === "task" ? parts[1] : (params.get("taskId") ?? undefined),
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
