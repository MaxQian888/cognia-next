/** @jest-environment jsdom */

import {
  forgetDeploymentSource,
  loadDeploymentSource,
  normalizeDeploymentFingerprint,
  normalizeDeploymentSource,
  normalizeDeploymentUrl,
  saveDeploymentSource,
  subscribeDeploymentSource,
} from "./deployment-source"

function memory(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & {
  map: Map<string, string>
} {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}

const FP = "ab".repeat(32)

describe("normalizeDeploymentUrl", () => {
  it("adds https, strips query, hash, credentials and trailing slashes", () => {
    expect(normalizeDeploymentUrl("  host.example:27890/  ")).toBe("https://host.example:27890")
    expect(normalizeDeploymentUrl("https://u:p@host.example/prefix/?x=1#y")).toBe(
      "https://host.example/prefix"
    )
    expect(normalizeDeploymentUrl("http://127.0.0.1:27890")).toBe("http://127.0.0.1:27890")
  })

  it("refuses what cannot be fetched", () => {
    expect(normalizeDeploymentUrl("")).toBeNull()
    expect(normalizeDeploymentUrl("ftp://host")).toBeNull()
    expect(normalizeDeploymentUrl("not a url at all")).toBeNull()
  })
})

describe("normalizeDeploymentFingerprint", () => {
  it("accepts colon-separated or spaced hex in any case, and drops an empty value", () => {
    expect(normalizeDeploymentFingerprint("AB:" + "ab:".repeat(30) + "AB")).toBe(FP)
    expect(normalizeDeploymentFingerprint("   ")).toBeUndefined()
    expect(normalizeDeploymentFingerprint(undefined)).toBeUndefined()
  })

  it("marks anything that is not 32 bytes of hex as malformed", () => {
    expect(normalizeDeploymentFingerprint("abcd")).toBeNull()
    expect(normalizeDeploymentFingerprint("zz".repeat(32))).toBeNull()
  })
})

describe("normalizeDeploymentSource", () => {
  it("returns null when either half is malformed", () => {
    expect(normalizeDeploymentSource({ baseUrl: "bad url", fingerprint: FP })).toBeNull()
    expect(normalizeDeploymentSource({ baseUrl: "https://h", fingerprint: "xx" })).toBeNull()
    expect(normalizeDeploymentSource({ baseUrl: "https://h", fingerprint: "" })).toEqual({
      baseUrl: "https://h",
    })
  })
})

describe("load / save / forget", () => {
  it("prefers the profile's record over the install default", () => {
    const local = memory()
    saveDeploymentSource(null, { baseUrl: "https://default.example" }, { local })
    expect(loadDeploymentSource("acct_a", { local })).toEqual({
      baseUrl: "https://default.example",
    })
    saveDeploymentSource("acct_a", { baseUrl: "https://own.example", fingerprint: FP }, { local })
    expect(loadDeploymentSource("acct_a", { local })).toEqual({
      baseUrl: "https://own.example",
      fingerprint: FP,
    })
    expect(loadDeploymentSource("acct_b", { local })).toEqual({
      baseUrl: "https://default.example",
    })
    expect(loadDeploymentSource(null, { local })).toEqual({ baseUrl: "https://default.example" })
  })

  it("forgets one key without touching the other", () => {
    const local = memory()
    saveDeploymentSource(null, { baseUrl: "https://default.example" }, { local })
    saveDeploymentSource("acct_a", { baseUrl: "https://own.example" }, { local })
    forgetDeploymentSource("acct_a", { local })
    expect(loadDeploymentSource("acct_a", { local })).toEqual({
      baseUrl: "https://default.example",
    })
    forgetDeploymentSource(null, { local })
    expect(loadDeploymentSource("acct_a", { local })).toBeNull()
  })

  it("throws on a malformed save so the form can say so", () => {
    const local = memory()
    expect(() => saveDeploymentSource("acct_a", { baseUrl: "nope nope" }, { local })).toThrow(
      /not a valid/
    )
    expect(local.map.size).toBe(0)
  })

  it("removes a record that no longer parses instead of returning it", () => {
    const local = memory()
    local.setItem("cognia.cloud.deployment.acct_a", "{not json")
    local.setItem("cognia.cloud.deployment.default", JSON.stringify({ baseUrl: 7 }))
    expect(loadDeploymentSource("acct_a", { local })).toBeNull()
    expect(local.map.size).toBe(0)
  })

  it("returns null with no storage at all", () => {
    expect(loadDeploymentSource("acct_a", { local: undefined })).toBeNull()
  })
})

describe("subscribeDeploymentSource", () => {
  afterEach(() => localStorage.clear())

  it("notifies same-tab writes and cross-tab storage events, and unsubscribes", () => {
    const listener = jest.fn()
    const off = subscribeDeploymentSource(listener)
    saveDeploymentSource("acct_a", { baseUrl: "https://h.example" })
    expect(listener).toHaveBeenCalledTimes(1)
    window.dispatchEvent(
      new StorageEvent("storage", { key: "cognia.cloud.deployment.default", newValue: "{}" })
    )
    expect(listener).toHaveBeenCalledTimes(2)
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated", newValue: "x" }))
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    forgetDeploymentSource("acct_a")
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
