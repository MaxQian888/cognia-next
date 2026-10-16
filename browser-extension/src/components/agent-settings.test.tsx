/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { AGENT_SESSIONS_KEY } from "@ext/src/lib/agent/sessions"
import { SITE_DECISIONS_KEY } from "@ext/src/lib/agent/site-permissions"
import {
  SESSION_KEYS,
  STORAGE_KEYS,
  type BrowserApi,
  type PermissionRequest,
} from "@ext/src/lib/browser-api"

import { AgentSettings, socketStateMessage } from "./agent-settings"

function fakeApi(options: { grant?: boolean; preferences?: unknown } = {}) {
  const local = new Map<string, unknown>([[STORAGE_KEYS.preferences, options.preferences ?? {}]])
  const session = new Map<string, unknown>()
  const granted = new Set<string>()
  const forgotten: string[] = []
  const entries = (request: PermissionRequest) => [
    ...(request.permissions ?? []),
    ...(request.origins ?? []),
  ]
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  const listen = (key: string, listener: (value: unknown) => void) => {
    const set = listeners.get(key) ?? new Set()
    set.add(listener)
    listeners.set(key, set)
    return () => set.delete(listener)
  }
  const api = {
    message: (key: string, subs?: string[]) => (subs ? `${key}:${subs.join("/")}` : key),
    read: async (key: string) => local.get(key) ?? null,
    write: async (key: string, value: unknown) => {
      local.set(key, value)
      for (const listener of listeners.get(key) ?? []) listener(value)
    },
    readSession: async (key: string) => session.get(key) ?? null,
    onStorageChange: listen,
    onSessionChange: listen,
    hasPermissions: async (request: PermissionRequest) =>
      entries(request).every((entry) => granted.has(entry)),
    requestPermissions: async (request: PermissionRequest) => {
      if (options.grant === false) return false
      for (const entry of entries(request)) granted.add(entry)
      return true
    },
    removePermissions: async (request: PermissionRequest) => {
      for (const entry of entries(request)) granted.delete(entry)
      return true
    },
    forgetSiteDecision: async (origin: string) => {
      forgotten.push(origin)
    },
  } as unknown as BrowserApi
  return { api, local, session, granted, forgotten }
}

describe("AgentSettings", () => {
  it("turns agent mode on by asking for all sites, then shows the socket and the Owner's grant", async () => {
    const fake = fakeApi()
    fake.session.set(SESSION_KEYS.socketState, {
      kind: "connected",
      connectionId: "c",
      driveAllowed: false,
    })
    render(<AgentSettings api={fake.api} driveAllowed={false} />)
    await act(async () => undefined)
    fireEvent.click(screen.getByTestId("agent-mode-switch"))
    await waitFor(() =>
      expect(fake.local.get(STORAGE_KEYS.preferences)).toMatchObject({ agentMode: true })
    )
    expect(fake.granted.has("<all_urls>")).toBe(true)
    expect(await screen.findByTestId("agent-socket-state")).toHaveTextContent(
      "agentSocketConnected"
    )
    expect(screen.getByTestId("agent-drive-state")).toHaveTextContent("agentDriveNotAllowed")
  })

  it("leaves agent mode off when the browser refuses all-sites access", async () => {
    const fake = fakeApi({ grant: false })
    render(<AgentSettings api={fake.api} driveAllowed />)
    await act(async () => undefined)
    fireEvent.click(screen.getByTestId("agent-mode-switch"))
    expect(await screen.findByTestId("agent-error")).toHaveTextContent("agentSitesDenied")
    expect(fake.local.get(STORAGE_KEYS.preferences)).toEqual({})
  })

  it("turns it off and gives the access back", async () => {
    const fake = fakeApi({ preferences: { agentMode: true } })
    fake.granted.add("<all_urls>")
    render(<AgentSettings api={fake.api} driveAllowed />)
    await waitFor(() =>
      expect(screen.getByTestId("agent-mode-switch")).toHaveAttribute("aria-checked", "true")
    )
    fireEvent.click(screen.getByTestId("agent-mode-switch"))
    await waitFor(() => expect(fake.granted.has("<all_urls>")).toBe(false))
    expect(fake.local.get(STORAGE_KEYS.preferences)).toMatchObject({ agentMode: false })
  })

  it("grants downloads and cookies separately", async () => {
    const fake = fakeApi({ preferences: { agentMode: true } })
    render(<AgentSettings api={fake.api} driveAllowed />)
    fireEvent.click(await screen.findByTestId("agent-downloads-switch"))
    await waitFor(() => expect(fake.granted.has("downloads")).toBe(true))
    expect(fake.granted.has("cookies")).toBe(false)
  })

  it("lists conversations and standing decisions, and forgets one", async () => {
    const fake = fakeApi()
    fake.session.set(AGENT_SESSIONS_KEY, {
      s1: {
        id: "s1-conversation",
        tabIds: [1, 2],
        ownedTabIds: [],
        activeTabId: 1,
        groupId: null,
        windowId: 1,
        takeover: true,
        onceOrigins: [],
        startedAt: 1,
        lastActivityAt: 1,
      },
    })
    fake.local.set(SITE_DECISIONS_KEY, {
      "https://a.test": "always",
      "https://b.test": "never",
      bad: "maybe",
    })
    render(
      <AgentSettings
        api={fake.api}
        driveAllowed
        conversationTitles={{ "s1-conversation": "Compare laptops" }}
      />
    )
    expect(await screen.findByTestId("agent-conversations")).toHaveTextContent(
      "agentConversationTabs:2"
    )
    expect(screen.getByTestId("agent-conversations")).toHaveTextContent("Compare laptops")
    expect(screen.getByTestId("agent-conversations")).toHaveTextContent("agentTakenOver")
    expect(screen.getByTestId("agent-decisions")).not.toHaveTextContent("bad")
    fireEvent.click(screen.getByTestId("agent-decision-forget-https://b.test"))
    await waitFor(() => expect(fake.forgotten).toEqual(["https://b.test"]))
  })
})

describe("socketStateMessage", () => {
  it("names every state", () => {
    const message = (key: string) => key
    expect(socketStateMessage({ kind: "stopped" }, message)).toBe("agentSocketStopped")
    expect(socketStateMessage({ kind: "connecting", attempt: 0 }, message)).toBe(
      "agentSocketConnecting"
    )
    expect(socketStateMessage({ kind: "waiting", retryAt: 1, code: null }, message)).toBe(
      "agentSocketRetrying"
    )
    expect(
      socketStateMessage({ kind: "waiting", retryAt: 1, code: "device_unavailable" }, message)
    ).toBe("agentSocketRefused")
  })
})
