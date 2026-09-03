// Runs in the `node` environment on purpose, like its `dev-auto-unlock`
// sibling: the "is there a webview, and is it Tauri" checks are half of what
// this module decides, and jsdom's `window` is non-configurable, so those
// branches can only be exercised where we own the global.

import {
  devSessionUnlockStorageKey,
  forgetDevSessionUnlock,
  isDevSessionUnlockEnabled,
  readDevSessionUnlock,
  rememberDevSessionUnlock,
} from "./dev-session-unlock"

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

function attachWindow(storage?: Storage, tauri = false): void {
  const win: Record<string, unknown> = {}
  if (storage) win.sessionStorage = storage
  if (tauri) win.__TAURI_INTERNALS__ = {}
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

describe("isDevSessionUnlockEnabled", () => {
  it("is on in a development browser build", () => {
    expect(isDevSessionUnlockEnabled()).toBe(true)
  })

  it("is off in a production build", () => {
    setNodeEnv("production")
    expect(isDevSessionUnlockEnabled()).toBe(false)
  })

  it("is off when the account gate is forced back on", () => {
    setForceGate("1")
    expect(isDevSessionUnlockEnabled()).toBe(false)
  })

  it("is off under Tauri, where the password also binds the OS keyring", () => {
    attachWindow(storage, true)
    expect(isDevSessionUnlockEnabled()).toBe(false)
  })

  it("is off with no window at all, so the server never reads it", () => {
    detachWindow()
    expect(isDevSessionUnlockEnabled()).toBe(false)
  })
})

describe("remember / read", () => {
  it("round-trips a secret for one account", () => {
    rememberDevSessionUnlock("acct_a", "hunter2")
    expect(readDevSessionUnlock("acct_a")).toBe("hunter2")
  })

  it("keeps accounts separate", () => {
    rememberDevSessionUnlock("acct_a", "hunter2")
    expect(readDevSessionUnlock("acct_b")).toBeNull()
  })

  it("writes nothing in a production build", () => {
    setNodeEnv("production")
    rememberDevSessionUnlock("acct_a", "hunter2")
    setNodeEnv("development")
    expect(readDevSessionUnlock("acct_a")).toBeNull()
  })

  it("refuses to read a secret a production build might still hold", () => {
    rememberDevSessionUnlock("acct_a", "hunter2")
    setNodeEnv("production")
    expect(readDevSessionUnlock("acct_a")).toBeNull()
  })

  it("ignores an empty secret rather than storing a falsy one", () => {
    rememberDevSessionUnlock("acct_a", "")
    expect(readDevSessionUnlock("acct_a")).toBeNull()
  })

  it("survives a storage that throws on write", () => {
    storage.throwOnWrite = true
    expect(() => rememberDevSessionUnlock("acct_a", "hunter2")).not.toThrow()
    expect(readDevSessionUnlock("acct_a")).toBeNull()
  })

  it("survives a window whose sessionStorage getter throws", () => {
    const win: Record<string, unknown> = {}
    Object.defineProperty(win, "sessionStorage", {
      get() {
        throw new Error("blocked")
      },
    })
    ;(globalThis as MaybeWindow).window = win
    expect(() => rememberDevSessionUnlock("acct_a", "hunter2")).not.toThrow()
    expect(readDevSessionUnlock("acct_a")).toBeNull()
  })
})

describe("forget", () => {
  it("clears one account when given an id", () => {
    rememberDevSessionUnlock("acct_a", "hunter2")
    rememberDevSessionUnlock("acct_b", "swordfish")
    forgetDevSessionUnlock("acct_a")
    expect(readDevSessionUnlock("acct_a")).toBeNull()
    expect(readDevSessionUnlock("acct_b")).toBe("swordfish")
  })

  it("clears every account when given none, so a lock really locks", () => {
    rememberDevSessionUnlock("acct_a", "hunter2")
    rememberDevSessionUnlock("acct_b", "swordfish")
    forgetDevSessionUnlock()
    expect(readDevSessionUnlock("acct_a")).toBeNull()
    expect(readDevSessionUnlock("acct_b")).toBeNull()
  })

  it("leaves unrelated session keys alone", () => {
    storage.setItem("cognia-pet-ui", "{}")
    rememberDevSessionUnlock("acct_a", "hunter2")
    forgetDevSessionUnlock()
    expect(storage.getItem("cognia-pet-ui")).toBe("{}")
  })

  it("still clears in a production build, so the gate can never be bypassed", () => {
    rememberDevSessionUnlock("acct_a", "hunter2")
    setNodeEnv("production")
    forgetDevSessionUnlock()
    setNodeEnv("development")
    expect(readDevSessionUnlock("acct_a")).toBeNull()
  })

  it("does not throw with no window", () => {
    detachWindow()
    expect(() => forgetDevSessionUnlock()).not.toThrow()
  })
})

describe("devSessionUnlockStorageKey", () => {
  it("namespaces the key so the sweep cannot catch anything else", () => {
    expect(devSessionUnlockStorageKey("acct_a")).toBe("cognia.dev-session-unlock.acct_a")
  })
})
