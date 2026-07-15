import {
  evaluateCliBinary,
  configureCliBinaryPolicy,
  __resetCliBinaryPolicyForTesting,
} from "./cli-binary-policy"
import type { ApprovedBinaryRow, AutomationAuditLogRow } from "@/lib/db/schema"

const APPROVED_HASH = "a".repeat(64)
const OTHER_HASH = "b".repeat(64)

describe("evaluateCliBinary", () => {
  const audits: AutomationAuditLogRow[] = []
  let approvals: ApprovedBinaryRow[]
  let hashes: Map<string, string | null>

  beforeEach(() => {
    audits.length = 0
    approvals = []
    hashes = new Map()
    configureCliBinaryPolicy({
      findApprovedBinary: async (pluginId, binaryPath) =>
        approvals.find((a) => a.pluginId === pluginId && a.binaryPath === binaryPath),
      hashBinary: async (binaryPath) => hashes.get(binaryPath) ?? null,
      appendAudit: async (row) => {
        audits.push(row)
      },
      now: () => 1234,
    })
  })

  afterAll(() => {
    __resetCliBinaryPolicyForTesting()
  })

  const DEFAULT_BIN = "C:\\plugins\\demo\\bin\\tool.exe"

  const input = (overrides: Partial<Parameters<typeof evaluateCliBinary>[0]> = {}) => ({
    pluginId: "demo",
    binaryPath: DEFAULT_BIN,
    pluginPath: "C:\\plugins\\demo",
    ...overrides,
  })

  function approve(pluginId: string, binaryPath: string, sha256 = APPROVED_HASH): void {
    approvals.push({ pluginId, binaryPath, sha256, approvedAt: 1 })
  }

  function onDisk(binaryPath: string, sha256: string | null): void {
    hashes.set(binaryPath, sha256)
  }

  it("allows silently when the user approved these exact bytes AND they're inside the plugin dir", async () => {
    approve("demo", DEFAULT_BIN)
    onDisk(DEFAULT_BIN, APPROVED_HASH)
    const decision = await evaluateCliBinary(input())
    expect(decision).toMatchObject({ allowed: true, requiresPrompt: false })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ surface: "plugin", decision: "allow", ts: 1234 })
    expect(audits[0].id).toMatch(/^cli_/)
  })

  // The CLI twin of the LSP regression: `manager.ts` used to forward
  // `manifest.author.publicKey` here, and a matching `trustedPublishers` row
  // (seeded with repo-source placeholders) bought a silent spawn.
  describe("self_asserted_fingerprint_never_grants_trust", () => {
    it("a manifest-supplied publisher key is inert as an excess input property", async () => {
      onDisk(DEFAULT_BIN, OTHER_HASH)
      const decision = await evaluateCliBinary({
        ...input(),
        publisherFingerprint: "placeholder:microsoft.vscode",
        authorPublicKey: "placeholder:openvsx.root",
      } as Parameters<typeof evaluateCliBinary>[0])

      expect(decision).toMatchObject({ allowed: false, requiresPrompt: true })
      expect(decision.reason).toMatch(/no recorded user approval/i)
      expect(decision.reason).not.toMatch(/placeholder:/)
    })

    it("does not consult a trusted-publisher ledger at all", async () => {
      const findTrustedPublisherByFingerprint = jest.fn()
      configureCliBinaryPolicy({
        ...({ findTrustedPublisherByFingerprint } as unknown as Record<string, never>),
      })
      onDisk(DEFAULT_BIN, OTHER_HASH)
      await evaluateCliBinary(input())
      expect(findTrustedPublisherByFingerprint).not.toHaveBeenCalled()
    })
  })

  describe("approval_is_scoped_to_binary_hash", () => {
    it("approving one binary does not approve a sibling in the same plugin", async () => {
      approve("demo", DEFAULT_BIN)
      onDisk("C:\\plugins\\demo\\bin\\other.exe", APPROVED_HASH)
      const decision = await evaluateCliBinary(
        input({ binaryPath: "C:\\plugins\\demo\\bin\\other.exe" })
      )
      expect(decision.allowed).toBe(false)
      expect(decision.reason).toMatch(/no recorded user approval/i)
    })

    it("an approval recorded for another plugin never transfers", async () => {
      approve("someone-else", DEFAULT_BIN)
      onDisk(DEFAULT_BIN, APPROVED_HASH)
      const decision = await evaluateCliBinary(input())
      expect(decision.allowed).toBe(false)
    })
  })

  describe("binary_hash_change_reprompts", () => {
    it("re-prompts when the approved binary's bytes changed", async () => {
      approve("demo", DEFAULT_BIN, APPROVED_HASH)
      onDisk(DEFAULT_BIN, OTHER_HASH)
      const decision = await evaluateCliBinary(input())
      expect(decision).toMatchObject({ allowed: false, requiresPrompt: true })
      expect(decision.reason).toMatch(/changed since it was approved/i)
      expect(audits[0].decision).toBe("consent")
    })

    it("re-prompts when the binary cannot be read or hashed", async () => {
      approve("demo", DEFAULT_BIN, APPROVED_HASH)
      onDisk(DEFAULT_BIN, null)
      const decision = await evaluateCliBinary(input())
      expect(decision).toMatchObject({ allowed: false, requiresPrompt: true })
      expect(decision.reason).toMatch(/could not be read or hashed/i)
    })

    it("allows again once the user re-approves the new hash", async () => {
      approve("demo", DEFAULT_BIN, OTHER_HASH)
      onDisk(DEFAULT_BIN, OTHER_HASH)
      await expect(evaluateCliBinary(input())).resolves.toMatchObject({ allowed: true })
    })
  })

  describe("binary_outside_plugin_dir_always_prompts", () => {
    it("prompts when the binary escapes the plugin dir even if approved", async () => {
      approve("demo", "C:\\evil\\tool.exe")
      onDisk("C:\\evil\\tool.exe", APPROVED_HASH)
      const decision = await evaluateCliBinary(input({ binaryPath: "C:\\evil\\tool.exe" }))
      expect(decision).toMatchObject({ allowed: false, requiresPrompt: true })
      expect(decision.reason).toMatch(/outside the plugin install directory/i)
      expect(audits[0].decision).toBe("consent")
    })

    it("does not read the binary at all when it is outside the plugin dir", async () => {
      const hashBinary = jest.fn(async () => APPROVED_HASH)
      configureCliBinaryPolicy({ hashBinary })
      approve("demo", "C:\\evil\\tool.exe")
      await evaluateCliBinary(input({ binaryPath: "C:\\evil\\tool.exe" }))
      expect(hashBinary).not.toHaveBeenCalled()
    })
  })

  it("prompts when there is no approval for the binary", async () => {
    onDisk(DEFAULT_BIN, APPROVED_HASH)
    const decision = await evaluateCliBinary(input())
    expect(decision).toMatchObject({ allowed: false, requiresPrompt: true })
    expect(decision.reason).toContain("No recorded user approval")
  })

  it("path comparison folds separators and case", async () => {
    approve("demo", "c:/PLUGINS/demo/bin/tool.exe")
    onDisk("c:/PLUGINS/demo/bin/tool.exe", APPROVED_HASH)
    const decision = await evaluateCliBinary(input({ binaryPath: "c:/PLUGINS/demo/bin/tool.exe" }))
    expect(decision.allowed).toBe(true)
  })

  it("a failing audit sink never blocks the decision", async () => {
    configureCliBinaryPolicy({
      appendAudit: async () => {
        throw new Error("dexie down")
      },
    })
    approve("demo", DEFAULT_BIN)
    onDisk(DEFAULT_BIN, APPROVED_HASH)
    await expect(evaluateCliBinary(input())).resolves.toMatchObject({ allowed: true })
  })
})
