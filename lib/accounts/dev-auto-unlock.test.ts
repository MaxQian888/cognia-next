// Runs in the `node` environment on purpose: the webview check is the whole
// point of this module, and jsdom's `window` is non-configurable, so the
// no-window branch can only be exercised where we own the global.

import { FORCE_ACCOUNT_GATE_ENV, isDevAutoUnlockEnabled } from "./dev-auto-unlock"

const ORIGINAL_NODE_ENV = process.env.NODE_ENV
const ORIGINAL_FORCE_GATE = process.env.NEXT_PUBLIC_ACCOUNT_GATE
const ORIGINAL_E2E = process.env.NEXT_PUBLIC_E2E

type MaybeWindow = { window?: unknown }

function setNodeEnv(value: string | undefined): void {
  // The module reads process.env at call time, so flipping it between calls is
  // enough to exercise both the dev and production branches.
  Object.defineProperty(process.env, "NODE_ENV", { value, configurable: true })
}

function setForceGate(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.NEXT_PUBLIC_ACCOUNT_GATE
    return
  }
  process.env.NEXT_PUBLIC_ACCOUNT_GATE = value
}

function setE2E(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.NEXT_PUBLIC_E2E
    return
  }
  process.env.NEXT_PUBLIC_E2E = value
}

function attachWindow(): void {
  ;(globalThis as MaybeWindow).window = {}
}

function detachWindow(): void {
  delete (globalThis as MaybeWindow).window
}

beforeEach(() => {
  setForceGate(undefined)
  setE2E(undefined)
  attachWindow()
})

afterEach(() => {
  setNodeEnv(ORIGINAL_NODE_ENV)
  setForceGate(ORIGINAL_FORCE_GATE)
  setE2E(ORIGINAL_E2E)
  detachWindow()
})

describe("dev-auto-unlock", () => {
  it("is enabled in a non-production build running in a webview", () => {
    setNodeEnv("development")
    expect(isDevAutoUnlockEnabled()).toBe(true)
  })

  it("is disabled in production builds", () => {
    setNodeEnv("production")
    expect(isDevAutoUnlockEnabled()).toBe(false)
  })

  it("is enabled in a production-mode E2E build", () => {
    setNodeEnv("production")
    setE2E("1")
    expect(isDevAutoUnlockEnabled()).toBe(true)
  })

  it("is disabled when NEXT_PUBLIC_ACCOUNT_GATE=1 forces the real gate", () => {
    setNodeEnv("development")
    setForceGate("1")
    expect(isDevAutoUnlockEnabled()).toBe(false)
  })

  it("lets the explicit account-gate override win over E2E mode", () => {
    setNodeEnv("production")
    setE2E("1")
    setForceGate("1")
    expect(isDevAutoUnlockEnabled()).toBe(false)
  })

  it("ignores other values of the force-gate env", () => {
    setNodeEnv("development")
    setForceGate("0")
    expect(isDevAutoUnlockEnabled()).toBe(true)
  })

  it("is disabled without a window (server render / node host)", () => {
    setNodeEnv("development")
    detachWindow()
    expect(isDevAutoUnlockEnabled()).toBe(false)
  })

  it("names the force-gate env so callers and docs cannot drift", () => {
    expect(FORCE_ACCOUNT_GATE_ENV).toBe("NEXT_PUBLIC_ACCOUNT_GATE")
  })
})
