/** @jest-environment jsdom */

import {
  forgetCollabConnection,
  loadCollabConnection,
  saveCollabConnection,
  subscribeCollabConnection,
} from "./connection"

function memoryStore() {
  const values = new Map<string, string>()
  return {
    values,
    local: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
  }
}

describe("collab connection", () => {
  afterEach(() => localStorage.clear())

  it("round-trips a normalized base url", () => {
    const { local } = memoryStore()
    saveCollabConnection("acct_a", { baseUrl: "https://collab.example.com/" }, { local })
    expect(loadCollabConnection("acct_a", { local })?.baseUrl).toBe("https://collab.example.com")
  })

  it("keeps profiles apart", () => {
    // A machine can hold several local profiles, and they may belong to
    // different orgs on different servers.
    const { local } = memoryStore()
    saveCollabConnection("acct_a", { baseUrl: "https://a.example" }, { local })
    expect(loadCollabConnection("acct_b", { local })).toBeNull()
  })

  it("returns null, and forgets, a record that no longer parses", () => {
    // A half-valid connection renders a configured-looking panel that fails on
    // first use — the harder failure to diagnose.
    const { values, local } = memoryStore()
    values.set("cognia.collab.connection.acct_a", '{"baseUrl":42}')
    expect(loadCollabConnection("acct_a", { local })).toBeNull()
    expect(values.has("cognia.collab.connection.acct_a")).toBe(false)
  })

  it("returns null when nothing was ever stored", () => {
    const { local } = memoryStore()
    expect(loadCollabConnection("acct_a", { local })).toBeNull()
  })

  it("forgets a connection without touching anything else", () => {
    const { local } = memoryStore()
    saveCollabConnection("acct_a", { baseUrl: "https://a.example" }, { local })
    saveCollabConnection("acct_b", { baseUrl: "https://b.example" }, { local })
    forgetCollabConnection("acct_a", { local })
    expect(loadCollabConnection("acct_a", { local })).toBeNull()
    expect(loadCollabConnection("acct_b", { local })?.baseUrl).toBe("https://b.example")
  })

  it("notifies a mounted runner when the configured URL changes", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeCollabConnection(listener)
    saveCollabConnection("acct_a", { baseUrl: "https://a.example" })
    forgetCollabConnection("acct_a")
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    saveCollabConnection("acct_a", { baseUrl: "https://b.example" })
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
