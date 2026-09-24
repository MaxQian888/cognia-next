jest.mock("@cognia/logging", () => ({
  loggers: { auth: { warn: jest.fn(), debug: jest.fn(), info: jest.fn() } },
}))

import { loggers } from "@cognia/logging"

import {
  SECRET_STORE_INITIALIZING_CODE,
  SECRET_STORE_LOCKED_CODE,
  SecretStoreUnavailableError,
  __resetSecretStoreReadinessForTesting,
  classifySecretStoreError,
  deferUntilSecretStoreReady,
  getSecretStoreFailureSources,
  getSecretStoreReadiness,
  isSecretStoreReadiness,
  onSecretStoreRecovered,
  reportSecretStoreFailure,
  setSecretStoreReadiness,
  subscribeSecretStoreReadiness,
  toSecretStoreUnavailableError,
} from "./secret-store-readiness"

const warn = loggers.auth.warn as jest.Mock
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  jest.clearAllMocks()
  __resetSecretStoreReadinessForTesting()
})

describe("classifySecretStoreError", () => {
  it.each([
    ["SECRET_STORE_LOCKED: master key read: passphrase not correct", "locked"],
    ["vault: SECRET_STORE_INITIALIZING: in progress", "initializing"],
    [new Error("secrets:get: SECRET_STORE_LOCKED: denied"), "locked"],
    [{ code: "UNAVAILABLE", details: { reason: "SECRET_STORE_INITIALIZING" } }, "initializing"],
    [{ code: "SECRET_STORE_LOCKED" }, "locked"],
    [new SecretStoreUnavailableError("locked"), "locked"],
  ])("recognises %p as %s", (error, reason) => {
    expect(classifySecretStoreError(error)).toBe(reason)
  })

  it.each([
    "legacy keyring read: denied",
    new Error("network"),
    { code: "UNAVAILABLE", details: { reason: "OTHER" } },
    { code: "PERMISSION_DENIED", message: "no" },
    null,
    undefined,
    42,
  ])("ignores %p", (error) => {
    expect(classifySecretStoreError(error)).toBeNull()
  })

  it("wraps only readiness failures as a typed error with the stable code", () => {
    const typed = toSecretStoreUnavailableError("SECRET_STORE_LOCKED: x")
    expect(typed).toBeInstanceOf(SecretStoreUnavailableError)
    expect(typed?.code).toBe(SECRET_STORE_LOCKED_CODE)
    expect(typed?.cause).toBe("SECRET_STORE_LOCKED: x")
    expect(toSecretStoreUnavailableError(new Error("other"))).toBeNull()
    expect(new SecretStoreUnavailableError("initializing").code).toBe(
      SECRET_STORE_INITIALIZING_CODE
    )
  })

  it("validates wire readiness values", () => {
    expect(isSecretStoreReadiness("locked")).toBe(true)
    expect(isSecretStoreReadiness("open")).toBe(false)
  })
})

describe("reportSecretStoreFailure", () => {
  it("logs once per locked episode however many consumers fail", () => {
    const states: string[] = []
    subscribeSecretStoreReadiness((state) => states.push(state))
    for (const source of ["subscription.init", "subscription.limits", "tts.keys", "plugin:e2b"]) {
      expect(reportSecretStoreFailure("SECRET_STORE_LOCKED: denied", source)).toBe(true)
    }
    expect(warn).toHaveBeenCalledTimes(1)
    expect(getSecretStoreReadiness()).toBe("locked")
    expect(states).toEqual(["locked"])
    expect(getSecretStoreFailureSources()).toEqual([
      "subscription.init",
      "subscription.limits",
      "tts.keys",
      "plugin:e2b",
    ])
  })

  it("returns false and changes nothing for unrelated errors", () => {
    expect(reportSecretStoreFailure(new Error("boom"), "x")).toBe(false)
    expect(getSecretStoreReadiness()).toBe("uninitialized")
    expect(warn).not.toHaveBeenCalled()
  })

  it("never downgrades locked to initializing", () => {
    reportSecretStoreFailure("SECRET_STORE_LOCKED: denied", "a")
    reportSecretStoreFailure("SECRET_STORE_INITIALIZING: busy", "b")
    expect(getSecretStoreReadiness()).toBe("locked")
  })
})

describe("recovery", () => {
  it("re-runs deferred consumers once and recovery listeners on every unlock", async () => {
    const recovered = jest.fn()
    onSecretStoreRecovered(recovered)
    reportSecretStoreFailure("SECRET_STORE_LOCKED: denied", "subscription.init")
    const rerun = jest.fn()
    deferUntilSecretStoreReady("subscription.init", rerun)
    // Keyed: repeated failures of the same consumer re-run it once.
    deferUntilSecretStoreReady("subscription.init", rerun)

    setSecretStoreReadiness("ready")
    await flush()
    expect(rerun).toHaveBeenCalledTimes(1)
    expect(recovered).toHaveBeenCalledTimes(1)

    setSecretStoreReadiness("locked")
    setSecretStoreReadiness("ready")
    await flush()
    expect(rerun).toHaveBeenCalledTimes(1)
    expect(recovered).toHaveBeenCalledTimes(2)
  })

  it("does not fire recovery listeners for a healthy first boot", async () => {
    const recovered = jest.fn()
    onSecretStoreRecovered(recovered)
    setSecretStoreReadiness("ready")
    await flush()
    expect(recovered).not.toHaveBeenCalled()
  })

  it("runs a deferral immediately when the store is already ready", async () => {
    setSecretStoreReadiness("ready")
    const run = jest.fn()
    deferUntilSecretStoreReady("late", run)
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("isolates a failing re-run from the others", async () => {
    reportSecretStoreFailure("SECRET_STORE_LOCKED: denied", "a")
    const ok = jest.fn()
    deferUntilSecretStoreReady("broken", async () => {
      throw new Error("still failing")
    })
    deferUntilSecretStoreReady("ok", ok)
    setSecretStoreReadiness("ready")
    await flush()
    expect(ok).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      "Deferred secret-store consumer failed after unlock",
      expect.objectContaining({ consumer: "broken", error: "still failing" })
    )
  })

  it("logs the next locked episode again after a recovery", () => {
    reportSecretStoreFailure("SECRET_STORE_LOCKED: denied", "a")
    setSecretStoreReadiness("ready")
    reportSecretStoreFailure("SECRET_STORE_LOCKED: denied", "a")
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it("unsubscribes listeners", async () => {
    const recovered = jest.fn()
    const off = onSecretStoreRecovered(recovered)
    const state = jest.fn()
    const offState = subscribeSecretStoreReadiness(state)
    off()
    offState()
    reportSecretStoreFailure("SECRET_STORE_LOCKED: denied", "a")
    setSecretStoreReadiness("ready")
    await flush()
    expect(recovered).not.toHaveBeenCalled()
    expect(state).not.toHaveBeenCalled()
  })
})
