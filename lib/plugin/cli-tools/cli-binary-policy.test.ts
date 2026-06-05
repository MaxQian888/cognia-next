import {
  evaluateCliBinary,
  configureCliBinaryPolicy,
  __resetCliBinaryPolicyForTesting,
} from "./cli-binary-policy"
import type { AutomationAuditLogRow, TrustedPublisherRow } from "@/lib/db/schema"

describe("evaluateCliBinary", () => {
  const audits: AutomationAuditLogRow[] = []
  let trustedFingerprints: Set<string>

  beforeEach(() => {
    audits.length = 0
    trustedFingerprints = new Set()
    configureCliBinaryPolicy({
      findTrustedPublisherByFingerprint: async (fingerprint) =>
        trustedFingerprints.has(fingerprint)
          ? ({ fingerprint } as unknown as TrustedPublisherRow)
          : undefined,
      appendAudit: async (row) => {
        audits.push(row)
      },
      now: () => 1234,
    })
  })

  afterAll(() => {
    __resetCliBinaryPolicyForTesting()
  })

  const input = (overrides: Partial<Parameters<typeof evaluateCliBinary>[0]> = {}) => ({
    pluginId: "demo",
    binaryPath: "C:\\plugins\\demo\\bin\\tool.exe",
    publisherFingerprint: "FP",
    pluginPath: "C:\\plugins\\demo",
    ...overrides,
  })

  it("allows silently when trusted AND inside the plugin dir", async () => {
    trustedFingerprints.add("FP")
    const decision = await evaluateCliBinary(input())
    expect(decision).toMatchObject({ allowed: true, requiresPrompt: false })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ surface: "plugin", decision: "allow", ts: 1234 })
    expect(audits[0].id).toMatch(/^cli_/)
  })

  it("prompts when the binary escapes the plugin dir even if trusted", async () => {
    trustedFingerprints.add("FP")
    const decision = await evaluateCliBinary(input({ binaryPath: "C:\\evil\\tool.exe" }))
    expect(decision).toMatchObject({ allowed: false, requiresPrompt: true })
    expect(audits[0].decision).toBe("consent")
  })

  it("prompts for untrusted fingerprints and missing fingerprints", async () => {
    const untrusted = await evaluateCliBinary(input())
    expect(untrusted).toMatchObject({ allowed: false, requiresPrompt: true })
    const unsigned = await evaluateCliBinary(input({ publisherFingerprint: undefined }))
    expect(unsigned).toMatchObject({ allowed: false, requiresPrompt: true })
    expect(unsigned.reason).toContain("no publisher fingerprint")
  })

  it("path comparison folds separators and case", async () => {
    trustedFingerprints.add("FP")
    const decision = await evaluateCliBinary(input({ binaryPath: "c:/PLUGINS/demo/bin/tool.exe" }))
    expect(decision.allowed).toBe(true)
  })

  it("a failing audit sink never blocks the decision", async () => {
    configureCliBinaryPolicy({
      appendAudit: async () => {
        throw new Error("dexie down")
      },
    })
    trustedFingerprints.add("FP")
    await expect(evaluateCliBinary(input())).resolves.toMatchObject({ allowed: true })
  })
})
