/** @jest-environment node */

import { APP_VERSION } from "./app-version"
import pkg from "../package.json"

describe("APP_VERSION", () => {
  it("is a non-empty string", () => {
    expect(typeof APP_VERSION).toBe("string")
    expect(APP_VERSION.length).toBeGreaterThan(0)
  })

  it("matches the version field in package.json", () => {
    expect(APP_VERSION).toBe(pkg.version)
  })

  it("conforms to semver shape (MAJOR.MINOR.PATCH)", () => {
    // Accept optional pre-release / build-metadata suffixes per semver spec.
    const semverRe = /^\d+\.\d+\.\d+/
    expect(APP_VERSION).toMatch(semverRe)
  })

  it("does not contain undefined or null placeholders", () => {
    expect(APP_VERSION).not.toContain("undefined")
    expect(APP_VERSION).not.toContain("null")
  })
})
