/** @jest-environment jsdom */

import { setConnectorCommandInvoker } from "@/lib/connectors/tauri/commands"
import {
  clearLarkOAuthPending,
  getLarkOAuthPending,
  setLarkOAuthPending,
  OAUTH_PENDING_CREDENTIAL,
} from "./oauth-pending"

const T0 = 1_800_000_000_000
const TTL_MS = 10 * 60 * 1000

/**
 * Stands in for the connectors secret store. Driving the real seam (rather
 * than `jest.mock`-ing the wrapper) is what proves the store is reached
 * through the swappable invoker — the whole reason this record no longer
 * lives in `localStorage`.
 */
function fakeStore() {
  const entries = new Map<string, string>()
  const calls: string[] = []
  const invoker = async <T>(name: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push(name)
    const key = `${String(args?.adapterId)}:${String(args?.credential)}`
    if (name === "connectors_keyring_set") {
      entries.set(key, String(args?.value))
      return undefined as T
    }
    if (name === "connectors_keyring_get") return (entries.get(key) ?? null) as T
    if (name === "connectors_keyring_delete") {
      entries.delete(key)
      return undefined as T
    }
    throw new Error(`unexpected command ${name}`)
  }
  return { entries, calls, invoker }
}

let store: ReturnType<typeof fakeStore>
let restore: ReturnType<typeof setConnectorCommandInvoker>

beforeEach(() => {
  store = fakeStore()
  restore = setConnectorCommandInvoker(store.invoker)
})

afterEach(() => {
  setConnectorCommandInvoker(restore)
})

describe("setLarkOAuthPending / getLarkOAuthPending", () => {
  it("round-trips state, codeVerifier and redirectUri and stamps ts", async () => {
    await setLarkOAuthPending(
      "lk-1",
      {
        state: "lark:lk-1:nonce",
        codeVerifier: "verifier-123",
        redirectUri: "https://tunnel.example/oauth/lark/callback",
      },
      T0
    )
    const got = await getLarkOAuthPending("lk-1", T0)
    expect(got).toEqual({
      state: "lark:lk-1:nonce",
      codeVerifier: "verifier-123",
      redirectUri: "https://tunnel.example/oauth/lark/callback",
      ts: T0,
    })
  })

  it("stores in the adapter's secret store, never in Web Storage", async () => {
    await setLarkOAuthPending(
      "lk-1",
      { state: "s", codeVerifier: "the-verifier", redirectUri: "r" },
      T0
    )
    expect([...store.entries.keys()]).toEqual([`lk-1:${OAUTH_PENDING_CREDENTIAL}`])
    // The headless brain's localStorage is an in-memory shim in a different
    // process from the browser that opened the dialog — a verifier there is
    // unreachable by the process that has to spend it.
    expect(localStorage.getItem(`lark-oauth-pending:lk-1`)).toBeNull()
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain("the-verifier")
  })

  it("scopes records per adapter", async () => {
    await setLarkOAuthPending("lk-1", { state: "s1", codeVerifier: "v1", redirectUri: "r" }, T0)
    await setLarkOAuthPending("lk-2", { state: "s2", codeVerifier: "v2", redirectUri: "r" }, T0)
    expect((await getLarkOAuthPending("lk-1", T0))?.state).toBe("s1")
    expect((await getLarkOAuthPending("lk-2", T0))?.state).toBe("s2")
    await clearLarkOAuthPending("lk-1")
    expect(await getLarkOAuthPending("lk-1", T0)).toBeNull()
    expect(await getLarkOAuthPending("lk-2", T0)).not.toBeNull()
  })

  it("returns null when nothing is stored", async () => {
    expect(await getLarkOAuthPending("lk-1", T0)).toBeNull()
  })

  it("returns null and evicts an expired record", async () => {
    await setLarkOAuthPending("lk-1", { state: "s", codeVerifier: "v", redirectUri: "r" }, T0)
    expect(await getLarkOAuthPending("lk-1", T0 + TTL_MS)).not.toBeNull()
    expect(await getLarkOAuthPending("lk-1", T0 + TTL_MS + 1)).toBeNull()
    // Evicted, not merely hidden — a stale verifier must not linger encrypted
    // on disk waiting for a clock change.
    expect(store.entries.size).toBe(0)
  })

  it("returns null for a malformed or half-written record", async () => {
    store.entries.set(`lk-1:${OAUTH_PENDING_CREDENTIAL}`, "not json")
    expect(await getLarkOAuthPending("lk-1", T0)).toBeNull()
    store.entries.set(`lk-1:${OAUTH_PENDING_CREDENTIAL}`, JSON.stringify({ state: "s" }))
    expect(await getLarkOAuthPending("lk-1", T0)).toBeNull()
    store.entries.set(`lk-1:${OAUTH_PENDING_CREDENTIAL}`, JSON.stringify(null))
    expect(await getLarkOAuthPending("lk-1", T0)).toBeNull()
  })

  it("treats an unreachable store as absent rather than throwing", async () => {
    setConnectorCommandInvoker(async () => {
      throw new Error("no host")
    })
    // The caller's next step is "retry Connect" either way; a throw here would
    // surface as an unhandled rejection inside the OAuth completion path.
    await expect(getLarkOAuthPending("lk-1", T0)).resolves.toBeNull()
    await expect(clearLarkOAuthPending("lk-1")).resolves.toBeUndefined()
  })

  it("uses the current clock when none is supplied", async () => {
    await setLarkOAuthPending("lk-1", { state: "s", codeVerifier: "v", redirectUri: "r" })
    const got = await getLarkOAuthPending("lk-1")
    expect(got?.ts).toBeGreaterThan(0)
  })

  it("clears idempotently", async () => {
    await clearLarkOAuthPending("lk-1")
    await clearLarkOAuthPending("lk-1")
    expect(store.calls.filter((c) => c === "connectors_keyring_delete")).toHaveLength(2)
  })
})
