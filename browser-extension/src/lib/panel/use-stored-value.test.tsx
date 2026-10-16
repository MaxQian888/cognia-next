/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

import { STORAGE_KEYS, type BrowserApi } from "../browser-api"
import { usePreferences, useStoredValue } from "./use-stored-value"

function fakeApi() {
  const local = new Map<string, unknown>()
  const session = new Map<string, unknown>()
  const listeners = {
    local: new Map<string, Set<(v: unknown) => void>>(),
    session: new Map<string, Set<(v: unknown) => void>>(),
  }
  const listen = (area: "local" | "session") => (key: string, listener: (v: unknown) => void) => {
    const set = listeners[area].get(key) ?? new Set()
    set.add(listener)
    listeners[area].set(key, set)
    return () => set.delete(listener)
  }
  const emit = (area: "local" | "session", key: string, value: unknown) => {
    for (const listener of listeners[area].get(key) ?? []) listener(value)
  }
  const api = {
    read: async (key: string) => local.get(key) ?? null,
    write: async (key: string, value: unknown) => {
      local.set(key, value)
      emit("local", key, value)
    },
    readSession: async (key: string) => session.get(key) ?? null,
    onStorageChange: listen("local"),
    onSessionChange: listen("session"),
  } as unknown as BrowserApi
  return { api, local, session, emit }
}

describe("useStoredValue", () => {
  it("reads, then follows changes in its own area", async () => {
    const { api, session, emit } = fakeApi()
    session.set("k", 2)
    const { result } = renderHook(() =>
      useStoredValue(api, "session", "k", (value) => (typeof value === "number" ? value : 0))
    )
    expect(result.current).toBe(0)
    await waitFor(() => expect(result.current).toBe(2))
    act(() => emit("session", "k", 5))
    expect(result.current).toBe(5)
    act(() => emit("local", "k", 9))
    expect(result.current).toBe(5)
  })

  it("does not let a slow first read undo a newer change", async () => {
    const { api, emit } = fakeApi()
    let release: (value: unknown) => void = () => undefined
    ;(api as { readSession: unknown }).readSession = () =>
      new Promise((resolve) => (release = resolve))
    const { result } = renderHook(() =>
      useStoredValue(api, "session", "k", (value) => value ?? "none")
    )
    act(() => emit("session", "k", "new"))
    await act(async () => release("old"))
    expect(result.current).toBe("new")
  })
})

describe("usePreferences", () => {
  it("merges a change into what storage holds now", async () => {
    const { api, local } = fakeApi()
    local.set(STORAGE_KEYS.preferences, { notifications: true, blockedHosts: ["a.test"] })
    const { result } = renderHook(() => usePreferences(api))
    await waitFor(() => expect(result.current[0].notifications).toBe(true))
    await act(async () => result.current[1]({ agentMode: true }))
    expect(local.get(STORAGE_KEYS.preferences)).toEqual({
      notifications: true,
      agentMode: true,
      blockedHosts: ["a.test"],
    })
    expect(result.current[0].agentMode).toBe(true)
  })
})
