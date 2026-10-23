import { useEffect, useState } from "react"
import { Badge, Button, Label, Switch } from "@cognia/plugin-ui"

import { AGENT_SESSIONS_KEY, type AgentSessions } from "@ext/src/lib/agent/sessions"
import { SITE_DECISIONS_KEY, type StandingDecision } from "@ext/src/lib/agent/site-permissions"
import type { SocketState } from "@ext/src/lib/agent/socket-client"
import { SESSION_KEYS, type BrowserApi, type PermissionRequest } from "@ext/src/lib/browser-api"
import { usePreferences, useStoredValue } from "@ext/src/lib/panel/use-stored-value"

export interface AgentSettingsProps {
  api: BrowserApi
  /** Whether the Owner granted `browser.drive` to this browser (capability). */
  driveAllowed: boolean
  /** Conversation titles by session id, from the recent list, when known. */
  conversationTitles?: Record<string, string>
}

const ALL_SITES: PermissionRequest = { origins: ["<all_urls>"] }

function parseSocketState(value: unknown): SocketState {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { kind?: unknown }).kind === "string"
  ) {
    return value as SocketState
  }
  return { kind: "stopped" }
}

function parseSessions(value: unknown): AgentSessions {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AgentSessions) : {}
}

function parseDecisions(value: unknown): Record<string, StandingDecision> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, StandingDecision] => entry[1] === "always" || entry[1] === "never"
    )
  )
}

export function socketStateMessage(state: SocketState, message: (key: string) => string): string {
  switch (state.kind) {
    case "connected":
      return message("agentSocketConnected")
    case "connecting":
      return message("agentSocketConnecting")
    case "status-only":
      return message("agentSocketStatusOnly")
    case "incompatible":
      return message("agentSocketIncompatible")
    case "waiting":
      return state.code ? message("agentSocketRefused") : message("agentSocketRetrying")
    default:
      return message("agentSocketStopped")
  }
}

/**
 * Agent mode (ADR-0228 §5–§7): whether agents may act in this browser, and
 * what they have been allowed so far.
 *
 * Turning it on asks for `<all_urls>` inside the click — the one install-time
 * warning this extension never shows, asked for only by the person who wants
 * it — and keeps the device socket open. Whether the Host will actually send
 * operations is the Owner's separate grant in the desktop app; the panel
 * shows both, because either alone does nothing.
 */
export function AgentSettings({ api, driveAllowed, conversationTitles = {} }: AgentSettingsProps) {
  const [preferences, updatePreferences] = usePreferences(api)
  const socket = useStoredValue(api, "session", SESSION_KEYS.socketState, parseSocketState)
  const sessions = useStoredValue(api, "session", AGENT_SESSIONS_KEY, parseSessions)
  const decisions = useStoredValue(api, "local", SITE_DECISIONS_KEY, parseDecisions)
  const [granted, setGranted] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      api.hasPermissions(ALL_SITES),
      api.hasPermissions({ permissions: ["downloads"] }),
      api.hasPermissions({ permissions: ["cookies"] }),
    ])
      .then(([sites, downloads, cookies]) => {
        if (!cancelled) setGranted({ sites, downloads, cookies })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [api])

  const toggleAgentMode = async (next: boolean) => {
    setError(null)
    if (next) {
      // First thing in the click: the request must run inside the gesture.
      const ok = await api.requestPermissions(ALL_SITES)
      setGranted((current) => ({ ...current, sites: ok }))
      if (!ok) {
        setError(api.message("agentSitesDenied"))
        return
      }
      await updatePreferences({ agentMode: true })
    } else {
      await updatePreferences({ agentMode: false })
      const removed = await api.removePermissions(ALL_SITES).catch(() => false)
      if (removed) setGranted((current) => ({ ...current, sites: false }))
    }
  }

  const togglePermission = async (permission: "downloads" | "cookies", next: boolean) => {
    setError(null)
    const request: PermissionRequest = { permissions: [permission] }
    const ok = next ? await api.requestPermissions(request) : await api.removePermissions(request)
    if (next && !ok) setError(api.message("agentPermissionDenied"))
    setGranted((current) => ({
      ...current,
      [permission]: next ? ok : !ok && current[permission] === true,
    }))
  }

  const conversations = Object.values(sessions)
  const decided = Object.entries(decisions)
  const active = preferences.agentMode && granted.sites === true

  return (
    <div className="space-y-2" data-testid="agent-settings">
      <div className="flex items-start justify-between gap-2">
        <Label htmlFor="cognia-agent-mode" className="flex-col items-start gap-0.5 text-xs">
          <span>{api.message("agentModeLabel")}</span>
          <span className="font-normal text-muted-foreground">{api.message("agentModeHint")}</span>
        </Label>
        <Switch
          id="cognia-agent-mode"
          checked={active}
          onCheckedChange={(next) => void toggleAgentMode(next)}
          data-testid="agent-mode-switch"
        />
      </div>
      {preferences.agentMode ? (
        <div className="space-y-1 text-[11px]" data-testid="agent-status">
          <p>
            <span className="text-muted-foreground">{api.message("agentSocketLabel")} </span>
            <span data-testid="agent-socket-state">{socketStateMessage(socket, api.message)}</span>
          </p>
          <p data-testid="agent-drive-state">
            {driveAllowed ? api.message("agentDriveAllowed") : api.message("agentDriveNotAllowed")}
          </p>
        </div>
      ) : null}
      {preferences.agentMode ? (
        <div className="space-y-1.5">
          {(["downloads", "cookies"] as const).map((permission) => (
            <div key={permission} className="flex items-center justify-between gap-2">
              <Label htmlFor={`cognia-agent-${permission}`} className="text-xs">
                {permission === "downloads"
                  ? api.message("agentDownloadsLabel")
                  : api.message("agentCookiesLabel")}
              </Label>
              <Switch
                id={`cognia-agent-${permission}`}
                checked={granted[permission] === true}
                onCheckedChange={(next) => void togglePermission(permission, next)}
                data-testid={`agent-${permission}-switch`}
              />
            </div>
          ))}
        </div>
      ) : null}
      {conversations.length > 0 ? (
        <div className="space-y-1" data-testid="agent-conversations">
          <p className="text-[11px] font-medium text-muted-foreground">
            {api.message("agentConversationsTitle")}
          </p>
          <ul className="space-y-1">
            {conversations.map((conversation) => (
              <li
                key={conversation.id}
                className="flex items-center justify-between gap-2 text-[11px]"
              >
                <span className="min-w-0 truncate" title={conversation.id}>
                  {conversationTitles[conversation.id] ?? (
                    <span className="font-mono">{conversation.id.slice(0, 8)}</span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <Badge variant="outline">
                    {api.message("agentConversationTabs", [String(conversation.tabIds.length)])}
                  </Badge>
                  {conversation.takeover ? (
                    <Badge variant="warning">{api.message("agentTakenOver")}</Badge>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {decided.length > 0 ? (
        <div className="space-y-1" data-testid="agent-decisions">
          <p className="text-[11px] font-medium text-muted-foreground">
            {api.message("agentDecisionsTitle")}
          </p>
          <ul className="space-y-1">
            {decided.map(([origin, decision]) => (
              <li key={origin} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="min-w-0 truncate font-mono" title={origin}>
                  {origin}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <Badge variant={decision === "never" ? "destructive" : "secondary"}>
                    {decision === "never"
                      ? api.message("siteNever")
                      : api.message("siteAllowAlways")}
                  </Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => void api.forgetSiteDecision(origin)}
                    data-testid={`agent-decision-forget-${origin}`}
                  >
                    {api.message("agentDecisionForget")}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-[11px] text-destructive" data-testid="agent-error">
          {error}
        </p>
      ) : null}
    </div>
  )
}
