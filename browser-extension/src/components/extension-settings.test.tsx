/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { STORAGE_KEYS, type BrowserApi, type PermissionRequest } from "@ext/src/lib/browser-api"

import { ExtensionSettings } from "./extension-settings"

function fakeApi(options: { grant?: boolean; preferences?: unknown } = {}) {
  const local = new Map<string, unknown>([[STORAGE_KEYS.preferences, options.preferences ?? {}]])
  const granted = new Set<string>()
  const listeners = new Set<(value: unknown) => void>()
  const api = {
    message: (key: string) => key,
    read: async (key: string) => local.get(key) ?? null,
    write: async (key: string, value: unknown) => {
      local.set(key, value)
      for (const listener of listeners) listener(value)
    },
    readSession: async () => null,
    onStorageChange: (_key: string, listener: (value: unknown) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onSessionChange: () => () => undefined,
    hasPermissions: async (request: PermissionRequest) =>
      (request.permissions ?? []).every((entry) => granted.has(entry)),
    requestPermissions: async (request: PermissionRequest) => {
      if (options.grant === false) return false
      for (const entry of request.permissions ?? []) granted.add(entry)
      return true
    },
  } as unknown as BrowserApi
  return { api, local, granted }
}

describe("ExtensionSettings", () => {
  it("turns notifications on by asking for the permission first", async () => {
    const fake = fakeApi()
    render(<ExtensionSettings api={fake.api} />)
    await act(async () => undefined)
    fireEvent.click(screen.getByTestId("notifications-switch"))
    await waitFor(() =>
      expect(fake.local.get(STORAGE_KEYS.preferences)).toMatchObject({ notifications: true })
    )
    expect(fake.granted.has("notifications")).toBe(true)
    await waitFor(() =>
      expect(screen.getByTestId("notifications-switch")).toHaveAttribute("aria-checked", "true")
    )
  })

  it("keeps notifications off when the permission is refused", async () => {
    const fake = fakeApi({ grant: false })
    render(<ExtensionSettings api={fake.api} />)
    await act(async () => undefined)
    fireEvent.click(screen.getByTestId("notifications-switch"))
    expect(await screen.findByTestId("settings-error")).toHaveTextContent("notificationsDenied")
    expect(fake.local.get(STORAGE_KEYS.preferences)).toEqual({})
  })

  it("adds normalized hosts to the blocklist, refuses nonsense, and removes", async () => {
    const fake = fakeApi({ preferences: { blockedHosts: ["old.test"] } })
    render(<ExtensionSettings api={fake.api} />)
    await screen.findByTestId("blocked-host-remove-old.test")
    fireEvent.change(screen.getByTestId("blocked-host-input"), {
      target: { value: "https://Bank.Example.com/login" },
    })
    fireEvent.click(screen.getByTestId("blocked-host-add"))
    await waitFor(() =>
      expect(fake.local.get(STORAGE_KEYS.preferences)).toMatchObject({
        blockedHosts: ["old.test", "bank.example.com"],
      })
    )
    expect(screen.getByTestId("blocked-host-input")).toHaveValue("")

    fireEvent.change(screen.getByTestId("blocked-host-input"), { target: { value: "nodot" } })
    fireEvent.click(screen.getByTestId("blocked-host-add"))
    expect(await screen.findByTestId("settings-error")).toHaveTextContent("blockedHostInvalid")

    fireEvent.click(screen.getByTestId("blocked-host-remove-old.test"))
    await waitFor(() =>
      expect(fake.local.get(STORAGE_KEYS.preferences)).toMatchObject({
        blockedHosts: ["bank.example.com"],
      })
    )
  })
})
