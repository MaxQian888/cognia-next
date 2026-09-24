// Runs in the `node` environment on purpose, like its `dev-auto-unlock`
// sibling: the "is there a webview, and is it Tauri or Capacitor" checks are
// half of what this module decides, and jsdom's `window` is non-configurable,
// so those branches can only be exercised where we own the global.

import {
  forgetTabSessionUnlock,
  isTabSessionUnlockEnabled,
  readTabSessionUnlock,
  rememberTabSessionUnlock,
  tabSessionUnlockStorageKey,
} from "./tab-session-unlock"

const ORIGINAL_NODE_ENV = process.env.NODE_ENV
const ORIGINAL_FORCE_GATE = process.env.NEXT_PUBLIC_ACCOUNT_GATE

type MaybeWindow = { window?: unknown }

function setNodeEnv(value: string | undefined): void {
  Object.defineProperty(process.env, "NODE_ENV", { value, configurable: true })
}

function setForceGate(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.NEXT_PUBLIC_ACCOUNT_GATE
    return
  }
  process.env.NEXT_PUBLIC_ACCOUNT_GATE = value
}

/** Minimal `sessionStorage` stand-in: the real one is not in the node env. */
function makeStorage(): Storage & { throwOnWrite?: boolean } {
  const entries = new Map<string, string>()
  const store = {
    get length() {
      return entries.size
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem(key: string, value: string) {
      if ((store as { throwOnWrite?: boolean }).throwOnWrite) throw new Error("quota")
      entries.set(key, value)
    },
    removeItem: (key: string) => void entries.delete(key),
    clear: () => entries.clear(),
  }
  return store as unknown as Storage & { throwOnWrite?: boolean }
}

function attachWindow(
  storage?: Storage,
  shell: "browser" | "tauri" | "capacitor" = "browser"
): void {
  const win: Record<string, unknown> = {}
  if (storage) win.sessionStorage = storage
  if (shell === "tauri") win.__TAURI_INTERNALS__ = {}
  if (shell === "capacitor") win.Capacitor = { isNativePlatform: () => true }
  ;(globalThis as MaybeWindow).window = win
}

function detachWindow(): void {
  delete (globalThis as MaybeWindow).window
}

let storage: Storage & { throwOnWrite?: boolean }

beforeEach(() => {
  setForceGate(undefined)
  setNodeEnv("development")
  storage = makeStorage()
  attachWindow(storage)
})

afterEach(() => {
  setNodeEnv(ORIGINAL_NODE_ENV)
  setForceGate(ORIGINAL_FORCE_GATE)
  detachWindow()
})

describe("isTabSessionUnlockEnabled", () => {
  it("is on in a development browser build", () => {
    expect(isTabSessionUnlockEnabled()).toBe(true)
  })

  it("is off in a production browser build, which must never keep the password", () => {
    setNodeEnv("production")
    expect(isTabSessionUnlockEnabled()).toBe(false)
  })

  it("is off when the account gate is forced back on", () => {
    setForceGate("1")
    expect(isTabSessionUnlockEnabled()).toBe(false)
  })

  it("is off under Tauri, which remembers through the native secret store instead", () => {
    attachWindow(storage, "tauri")
    expect(isTabSessionUnlockEnabled()).toBe(false)
  })

  it("is off in the Capacitor shell", () => {
    attachWindow(storage, "capacitor")
    expect(isTabSessionUnlockEnabled()).toBe(false)
  })

  it("is off with no window at all, so the server never reads it", () => {
    detachWindow()
    expect(isTabSessionUnlockEnabled()).toBe(false)
  })
})

describe("remember / read", () => {
  it("round-trips a secret for one account", () => {
    rememberTabSessionUnlock("acct_a", "hunter2")
    expect(readTabSessionUnlock("acct_a")).toBe("hunter2")
  })

  it("neither writes nor reads a secret in a production browser build", () => {
    rememberTabSessionUnlock("acct_a", "hunter2")
    setNodeEnv("production")
    expect(readTabSessionUnlock("acct_a")).toBeNull()
    rememberTabSessionUnlock("acct_b", "hunter2")
    setNodeEnv(ORIGINAL_NODE_ENV)
    expect(readTabSessionUnlock("acct_b")).toBeNull()
  })

  it("keeps accounts separate", () => {
    rememberTabSessionUnlock("acct_a", "hunter2")
    expect(readTabSessionUnlock("acct_b")).toBeNull()
  })

  it("writes nothing under Tauri", () => {
    attachWindow(storage, "tauri")
    rememberTabSessionUnlock("acct_a", "hunter2")
    expect(storage.length).toBe(0)
  })

  it("refuses to read a secret once the gate is forced", () => {
    rememberTabSessionUnlock("acct_a", "hunter2")
    setForceGate("1")
    expect(readTabSessionUnlock("acct_a")).toBeNull()
  })

  it("ignores an empty secret rather than storing a falsy one", () => {
    rememberTabSessionUnlock("acct_a", "")
    expect(readTabSessionUnlock("acct_a")).toBeNull()
  })

  it("survives a storage that throws on write", () => {
    storage.throwOnWrite = true
    expect(() => rememberTabSessionUnlock("acct_a", "hunter2")).not.toThrow()
    expect(readTabSessionUnlock("acct_a")).toBeNull()
  })

  it("survives a window whose sessionStorage getter throws", () => {
    const win: Record<string, unknown> = {}
    Object.defineProperty(win, "sessionStorage", {
      get() {
        throw new Error("blocked")
      },
    })
    ;(globalThis as MaybeWindow).window = win
    expect(() => rememberTabSessionUnlock("acct_a", "hunter2")).not.toThrow()
    expect(readTabSessionUnlock("acct_a")).toBeNull()
  })
})

describe("forget", () => {
  it("clears one account when given an id", () => {
    rememberTabSessionUnlock("acct_a", "hunter2")
    rememberTabSessionUnlock("acct_b", "swordfish")
    forgetTabSessionUnlock("acct_a")
    expect(readTabSessionUnlock("acct_a")).toBeNull()
    expect(readTabSessionUnlock("acct_b")).toBe("swordfish")
  })

  it("clears every account when given none, so a lock really locks", () => {
    rememberTabSessionUnlock("acct_a", "hunter2")
    rememberTabSessionUnlock("acct_b", "swordfish")
    forgetTabSessionUnlock()
    expect(readTabSessionUnlock("acct_a")).toBeNull()
    expect(readTabSessionUnlock("acct_b")).toBeNull()
  })

  it("sweeps secrets written under the pre-rename key", () => {
    storage.setItem("cognia.dev-session-unlock.acct_a", "hunter2")
    forgetTabSessionUnlock()
    expect(storage.getItem("cognia.dev-session-unlock.acct_a")).toBeNull()
    storage.setItem("cognia.dev-session-unlock.acct_b", "swordfish")
    forgetTabSessionUnlock("acct_b")
    expect(storage.getItem("cognia.dev-session-unlock.acct_b")).toBeNull()
  })

  it("leaves unrelated session keys alone", () => {
    storage.setItem("cognia-pet-ui", "{}")
    rememberTabSessionUnlock("acct_a", "hunter2")
    forgetTabSessionUnlock()
    expect(storage.getItem("cognia-pet-ui")).toBe("{}")
  })

  it("still clears when remembering is disabled, so the gate can never be bypassed", () => {
    rememberTabSessionUnlock("acct_a", "hunter2")
    setForceGate("1")
    forgetTabSessionUnlock()
    setForceGate(undefined)
    expect(readTabSessionUnlock("acct_a")).toBeNull()
  })

  it("does not throw with no window", () => {
    detachWindow()
    expect(() => forgetTabSessionUnlock()).not.toThrow()
  })
})

describe("tabSessionUnlockStorageKey", () => {
  it("namespaces the key so the sweep cannot catch anything else", () => {
    expect(tabSessionUnlockStorageKey("acct_a")).toBe("cognia.tab-session-unlock.acct_a")
  })
})
