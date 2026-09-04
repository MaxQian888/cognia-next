import { compiledTrustRoot, initialTrustState, parseTrustRoot } from "./trust-root"

const ROOT = {
  _type: "root",
  version: 3,
  expires: "2030-01-01T00:00:00Z",
  keys: { k1: { keyid: "k1", keytype: "ed25519", publicKey: "aa" } },
  roles: {
    root: { keyids: ["k1"], threshold: 1 },
    targets: { keyids: ["k1"], threshold: 1 },
    snapshot: { keyids: ["k1"], threshold: 1 },
    timestamp: { keyids: ["k1"], threshold: 1 },
  },
}

describe("parseTrustRoot", () => {
  it("accepts raw JSON", () => {
    expect(parseTrustRoot(JSON.stringify(ROOT))?.version).toBe(3)
  })

  it("accepts base64 JSON", () => {
    const encoded = Buffer.from(JSON.stringify(ROOT), "utf8").toString("base64")
    expect(parseTrustRoot(encoded)?.version).toBe(3)
  })

  it("returns null when nothing is configured", () => {
    expect(parseTrustRoot(undefined)).toBeNull()
    expect(parseTrustRoot("")).toBeNull()
  })

  it("refuses a document that is not a root", () => {
    expect(parseTrustRoot(JSON.stringify({ ...ROOT, _type: "targets" }))).toBeNull()
  })

  it("refuses a root with no targets role", () => {
    const broken = { ...ROOT, roles: { root: ROOT.roles.root } }
    expect(parseTrustRoot(JSON.stringify(broken))).toBeNull()
  })

  it("refuses malformed input rather than throwing", () => {
    expect(parseTrustRoot("{not json")).toBeNull()
  })
})

describe("initialTrustState", () => {
  it("seeds the high-water mark from the root version", () => {
    const state = initialTrustState(parseTrustRoot(JSON.stringify(ROOT)))
    expect(state?.seenVersions.root).toBe(3)
  })

  it("is null when no root ships with the build", () => {
    expect(initialTrustState(null)).toBeNull()
  })
})

describe("compiledTrustRoot", () => {
  const original = process.env.NEXT_PUBLIC_UPDATE_TRUST_ROOT

  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_UPDATE_TRUST_ROOT
    else process.env.NEXT_PUBLIC_UPDATE_TRUST_ROOT = original
  })

  it("treats an unconfigured build as having no root, never as trusting everything", () => {
    delete process.env.NEXT_PUBLIC_UPDATE_TRUST_ROOT
    expect(compiledTrustRoot()).toBeNull()
  })

  it("reads a configured root", () => {
    process.env.NEXT_PUBLIC_UPDATE_TRUST_ROOT = JSON.stringify(ROOT)
    expect(compiledTrustRoot()?.version).toBe(3)
  })
})
