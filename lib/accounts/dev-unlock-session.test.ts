/**
 * @jest-environment jsdom
 */

import {
  forgetDevUnlock,
  isDevUnlockPersistenceEnabled,
  readDevUnlock,
  rememberDevUnlock,
} from "./dev-unlock-session"

const ORIGINAL_NODE_ENV = process.env.NODE_ENV

function setNodeEnv(value: string | undefined): void {
  // process.env.NODE_ENV is read at call time by the module, so flipping it
  // between calls is enough to exercise both the dev and production gates.
  Object.defineProperty(process.env, "NODE_ENV", { value, configurable: true })
}

afterEach(() => {
  setNodeEnv(ORIGINAL_NODE_ENV)
  window.sessionStorage.clear()
  jest.restoreAllMocks()
})

describe("dev-unlock-session", () => {
  it("is enabled in non-production builds with sessionStorage", () => {
    setNodeEnv("development")
    expect(isDevUnlockPersistenceEnabled()).toBe(true)
  })

  it("is disabled in production builds", () => {
    setNodeEnv("production")
    expect(isDevUnlockPersistenceEnabled()).toBe(false)
  })

  it("remembers and reads the unlocked account id in dev", () => {
    setNodeEnv("development")
    rememberDevUnlock("acct_alpha")
    expect(readDevUnlock()).toBe("acct_alpha")
  })

  it("forgets the remembered account id", () => {
    setNodeEnv("development")
    rememberDevUnlock("acct_alpha")
    forgetDevUnlock()
    expect(readDevUnlock()).toBeNull()
  })

  it("never persists or reads in production", () => {
    setNodeEnv("development")
    rememberDevUnlock("acct_alpha")

    setNodeEnv("production")
    expect(readDevUnlock()).toBeNull()
    rememberDevUnlock("acct_beta")
    // production write is a no-op; switching back proves nothing changed.

    setNodeEnv("development")
    expect(readDevUnlock()).toBe("acct_alpha")
  })

  it("swallows sessionStorage write failures", () => {
    setNodeEnv("development")
    jest.spyOn(window.sessionStorage.__proto__, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded")
    })
    expect(() => rememberDevUnlock("acct_alpha")).not.toThrow()
  })

  it("returns null when sessionStorage read throws", () => {
    setNodeEnv("development")
    jest.spyOn(window.sessionStorage.__proto__, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(readDevUnlock()).toBeNull()
  })

  it("swallows sessionStorage remove failures", () => {
    setNodeEnv("development")
    jest.spyOn(window.sessionStorage.__proto__, "removeItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(() => forgetDevUnlock()).not.toThrow()
  })
})
