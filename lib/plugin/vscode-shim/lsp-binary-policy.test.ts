import type { AutomationAuditLogRow, TrustedPublisherRow } from "@/lib/db/schema"
import {
  __resetLspBinaryPolicyForTesting,
  configureLspBinaryPolicy,
  evaluateLspBinary,
} from "./lsp-binary-policy"

describe("lsp-binary-policy", () => {
  let audit: AutomationAuditLogRow[]
  let publishers: TrustedPublisherRow[]

  beforeEach(() => {
    __resetLspBinaryPolicyForTesting()
    audit = []
    publishers = []
    configureLspBinaryPolicy({
      findTrustedPublisherByFingerprint: async (fp) => publishers.find((p) => p.fingerprint === fp),
      appendAudit: async (row) => {
        audit.push(row)
      },
      now: () => 1_700_000_000_000,
    })
  })

  function addTrustedPublisher(fingerprint: string): void {
    publishers.push({
      publicKey: `pk-${fingerprint}`,
      fingerprint,
      firstTrustedAt: 0,
      lastSeenAt: 0,
      installCount: 1,
    })
  }

  it("allows a binary inside the plugin dir when the publisher is trusted", async () => {
    addTrustedPublisher("fp-abc")
    const result = await evaluateLspBinary({
      pluginId: "publisher.ext",
      binaryPath: "/plugins/publisher.ext/server/rust-analyzer",
      publisherFingerprint: "fp-abc",
      pluginPath: "/plugins/publisher.ext",
    })
    expect(result.allowed).toBe(true)
    expect(result.requiresPrompt).toBe(false)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.decision).toBe("allow")
    expect(audit[0]!.surface).toBe("plugin")
  })

  it("prompts when the trusted publisher's binary lives outside the plugin dir", async () => {
    addTrustedPublisher("fp-abc")
    const result = await evaluateLspBinary({
      pluginId: "publisher.ext",
      binaryPath: "/usr/local/bin/rust-analyzer",
      publisherFingerprint: "fp-abc",
      pluginPath: "/plugins/publisher.ext",
    })
    expect(result.allowed).toBe(false)
    expect(result.requiresPrompt).toBe(true)
    expect(audit[0]!.decision).toBe("consent")
    expect(result.reason).toMatch(/outside.*install directory/i)
  })

  it("prompts when the publisher is unknown", async () => {
    const result = await evaluateLspBinary({
      pluginId: "publisher.ext",
      binaryPath: "/plugins/publisher.ext/server/bin",
      publisherFingerprint: "fp-unknown",
      pluginPath: "/plugins/publisher.ext",
    })
    expect(result.allowed).toBe(false)
    expect(result.requiresPrompt).toBe(true)
    expect(result.reason).toMatch(/not in the trustedPublishers ledger/)
  })

  it("prompts when the plugin has no publisher fingerprint at all", async () => {
    const result = await evaluateLspBinary({
      pluginId: "publisher.ext",
      binaryPath: "/plugins/publisher.ext/server/bin",
      pluginPath: "/plugins/publisher.ext",
    })
    expect(result.allowed).toBe(false)
    expect(result.requiresPrompt).toBe(true)
    expect(result.reason).toMatch(/no publisher fingerprint/i)
  })

  it("survives an audit-log write failure", async () => {
    addTrustedPublisher("fp-abc")
    configureLspBinaryPolicy({
      appendAudit: async () => {
        throw new Error("dexie boom")
      },
    })
    // Decision should still resolve normally — audit is best-effort.
    const result = await evaluateLspBinary({
      pluginId: "p",
      binaryPath: "/plugins/p/bin",
      publisherFingerprint: "fp-abc",
      pluginPath: "/plugins/p",
    })
    expect(result.allowed).toBe(true)
  })

  it("normalises Windows-style paths for the inside-check", async () => {
    addTrustedPublisher("fp-x")
    const result = await evaluateLspBinary({
      pluginId: "p",
      binaryPath: "C:\\Users\\me\\plugins\\p\\bin\\server.exe",
      publisherFingerprint: "fp-x",
      pluginPath: "C:\\Users\\me\\plugins\\p",
    })
    expect(result.allowed).toBe(true)
  })

  it("processName falls back to null only when the binary path has no segment", async () => {
    addTrustedPublisher("fp")
    await evaluateLspBinary({
      pluginId: "p",
      binaryPath: "/plugins/p/server.exe",
      publisherFingerprint: "fp",
      pluginPath: "/plugins/p",
    })
    expect(audit[0]!.processName).toBe("server.exe")
  })
})
