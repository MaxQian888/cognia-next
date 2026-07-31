/**
 * @jest-environment node
 */
import {
  clearAuthEntry,
  hasAuthTokens,
  mcpAuthPath,
  patchAuthEntry,
  readAuthEntry,
  type McpAuthFs,
} from "./oauth-store"

function memFs(seed: Record<string, string> = {}): McpAuthFs & { files: Record<string, string> } {
  const files = { ...seed }
  return {
    files,
    exists: (p) => p in files,
    readText: (p) => files[p],
    writeText: (p, data) => {
      files[p] = data
    },
  }
}

const HOME = "/home/.cognia"
const PATH = mcpAuthPath(HOME)

describe("oauth-store", () => {
  it("returns an empty entry when nothing is stored", () => {
    expect(readAuthEntry(HOME, "s", memFs())).toEqual({})
    expect(hasAuthTokens(HOME, "s", memFs())).toBe(false)
  })

  it("patches and reads back a server entry", () => {
    const fs = memFs()
    patchAuthEntry(HOME, "linear", { codeVerifier: "abc" }, fs)
    patchAuthEntry(HOME, "linear", { tokens: { access_token: "t" } }, fs)
    expect(readAuthEntry(HOME, "linear", fs)).toEqual({
      codeVerifier: "abc",
      tokens: { access_token: "t" },
    })
    expect(hasAuthTokens(HOME, "linear", fs)).toBe(true)
  })

  it("isolates entries per server", () => {
    const fs = memFs()
    patchAuthEntry(HOME, "a", { tokens: { access_token: "ta" } }, fs)
    patchAuthEntry(HOME, "b", { tokens: { access_token: "tb" } }, fs)
    expect(hasAuthTokens(HOME, "a", fs)).toBe(true)
    expect(hasAuthTokens(HOME, "b", fs)).toBe(true)
    expect(readAuthEntry(HOME, "a", fs).tokens).toEqual({ access_token: "ta" })
  })

  it("clears one server without touching others", () => {
    const fs = memFs()
    patchAuthEntry(HOME, "a", { tokens: { access_token: "ta" } }, fs)
    patchAuthEntry(HOME, "b", { tokens: { access_token: "tb" } }, fs)
    expect(clearAuthEntry(HOME, "a", fs)).toBe(true)
    expect(hasAuthTokens(HOME, "a", fs)).toBe(false)
    expect(hasAuthTokens(HOME, "b", fs)).toBe(true)
  })

  it("returns false when clearing a server with no entry", () => {
    expect(clearAuthEntry(HOME, "missing", memFs())).toBe(false)
  })

  it("treats a corrupt store as empty", () => {
    const fs = memFs({ [PATH]: "{not json" })
    expect(readAuthEntry(HOME, "s", fs)).toEqual({})
  })
})
