import type { ApprovedBinaryRow, AutomationAuditLogRow } from "@/lib/db/schema"

// Only `defaultIsUnsignedLspAllowed` reaches the database in this file — every
// other default dep is overridden per-test. The stub lets the untouched
// default read path be exercised directly.
const storedSettings: {
  value: {
    lsp?: { unsignedAllowed?: boolean }
    developer?: { unsignedLspAllowed?: boolean }
  } | null
} = { value: null }

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    settings: { get: async () => storedSettings.value },
  }),
}))

import {
  __resetLspBinaryPolicyForTesting,
  configureLspBinaryPolicy,
  evaluateLspBinary,
} from "./lsp-binary-policy"

const APPROVED_HASH = "a".repeat(64)
const OTHER_HASH = "b".repeat(64)

describe("lsp-binary-policy", () => {
  let audit: AutomationAuditLogRow[]
  let approvals: ApprovedBinaryRow[]
  let hashes: Map<string, string | null>
  let devModeFlag: boolean

  beforeEach(() => {
    __resetLspBinaryPolicyForTesting()
    audit = []
    approvals = []
    hashes = new Map()
    devModeFlag = false
    configureLspBinaryPolicy({
      findApprovedBinary: async (pluginId, binaryPath) =>
        approvals.find((a) => a.pluginId === pluginId && a.binaryPath === binaryPath),
      hashBinary: async (binaryPath) => hashes.get(binaryPath) ?? null,
      appendAudit: async (row) => {
        audit.push(row)
      },
      isUnsignedLspAllowed: async () => devModeFlag,
      now: () => 1_700_000_000_000,
    })
  })

  afterAll(() => {
    __resetLspBinaryPolicyForTesting()
  })

  function approve(pluginId: string, binaryPath: string, sha256 = APPROVED_HASH): void {
    approvals.push({ pluginId, binaryPath, sha256, approvedAt: 1 })
  }

  function onDisk(binaryPath: string, sha256: string | null): void {
    hashes.set(binaryPath, sha256)
  }

  it("allows a binary inside the plugin dir that the user approved, whose bytes still match", async () => {
    approve("publisher.ext", "/plugins/publisher.ext/server/rust-analyzer")
    onDisk("/plugins/publisher.ext/server/rust-analyzer", APPROVED_HASH)

    const result = await evaluateLspBinary({
      pluginId: "publisher.ext",
      binaryPath: "/plugins/publisher.ext/server/rust-analyzer",
      pluginPath: "/plugins/publisher.ext",
    })

    expect(result.allowed).toBe(true)
    expect(result.requiresPrompt).toBe(false)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.decision).toBe("allow")
    expect(audit[0]!.surface).toBe("plugin")
  })

  // ── The regression that motivated the v109 trust-model rebuild ────────────
  //
  // Before v109, a plugin could declare `vscodeExtension.publisherKeyFingerprint`
  // in its own manifest; the policy matched that string against `trustedPublishers`
  // by plain equality, and the v39 seed had planted `"placeholder:microsoft.vscode"`
  // — a literal in this repo's source. Declaring it bought a prompt-free spawn.
  //
  // The policy no longer has a parameter for a self-asserted identity at all,
  // so these tests assert the property structurally: whatever a hostile plugin
  // says about itself, an unapproved binary still prompts.
  describe("self_asserted_fingerprint_never_grants_trust", () => {
    it("a hostile manifest field cannot be smuggled in as an extra input property", async () => {
      // Exactly what a malicious .vsix used to declare, passed as an excess
      // property. It must be inert: nothing in the policy reads it.
      const hostileInput = {
        pluginId: "evil.ext",
        binaryPath: "/plugins/evil.ext/bin/payload",
        pluginPath: "/plugins/evil.ext",
        publisherFingerprint: "placeholder:microsoft.vscode",
        publisherKeyFingerprint: "placeholder:microsoft.vscode",
        authorPublicKey: "placeholder:openvsx.root",
      }
      onDisk("/plugins/evil.ext/bin/payload", OTHER_HASH)

      const result = await evaluateLspBinary(hostileInput)

      expect(result.allowed).toBe(false)
      expect(result.requiresPrompt).toBe(true)
      expect(result.reason).toMatch(/no recorded user approval/i)
      // The decision must not even mention the string the plugin supplied.
      expect(result.reason).not.toMatch(/placeholder:/)
      expect(audit[0]!.decision).toBe("consent")
    })

    it("every seeded placeholder fingerprint is inert", async () => {
      // The nine strings the v39 seed planted. Each one used to be a skeleton
      // key; none may grant anything now.
      const seededPlaceholders = [
        "placeholder:microsoft.vscode",
        "placeholder:dbaeumer.vscode-eslint",
        "placeholder:ms-python",
        "placeholder:rust-lang.rust-analyzer",
        "placeholder:golang.go",
        "placeholder:palantir.python-language-server",
        "placeholder:python-lsp.python-lsp-server",
        "placeholder:openvsx.root",
        "placeholder:eamodio.gitlens",
      ]
      onDisk("/plugins/evil.ext/bin/payload", OTHER_HASH)

      for (const fingerprint of seededPlaceholders) {
        const result = await evaluateLspBinary({
          pluginId: "evil.ext",
          binaryPath: "/plugins/evil.ext/bin/payload",
          pluginPath: "/plugins/evil.ext",
          publisherFingerprint: fingerprint,
        } as Parameters<typeof evaluateLspBinary>[0])
        expect(result).toMatchObject({ allowed: false, requiresPrompt: true })
      }
    })

    it("does not consult a trusted-publisher ledger at all", async () => {
      // If a fingerprint lookup ever comes back, this dep would be called.
      // Its absence from the deps surface is the guarantee; assert the
      // evaluation completes without one being configured.
      const findTrustedPublisherByFingerprint = jest.fn()
      configureLspBinaryPolicy({
        ...({ findTrustedPublisherByFingerprint } as unknown as Record<string, never>),
      })
      onDisk("/plugins/p/bin", OTHER_HASH)

      await evaluateLspBinary({
        pluginId: "p",
        binaryPath: "/plugins/p/bin",
        pluginPath: "/plugins/p",
      })

      expect(findTrustedPublisherByFingerprint).not.toHaveBeenCalled()
    })
  })

  describe("approval_is_scoped_to_binary_hash", () => {
    it("approving one binary does not approve a sibling binary in the same plugin", async () => {
      approve("p", "/plugins/p/bin/approved")
      onDisk("/plugins/p/bin/approved", APPROVED_HASH)
      onDisk("/plugins/p/bin/sneaky", APPROVED_HASH)

      const result = await evaluateLspBinary({
        pluginId: "p",
        binaryPath: "/plugins/p/bin/sneaky",
        pluginPath: "/plugins/p",
      })

      expect(result.allowed).toBe(false)
      expect(result.reason).toMatch(/no recorded user approval/i)
    })

    it("an approval recorded for another plugin never transfers", async () => {
      approve("good.ext", "/plugins/evil.ext/bin/payload")
      onDisk("/plugins/evil.ext/bin/payload", APPROVED_HASH)

      const result = await evaluateLspBinary({
        pluginId: "evil.ext",
        binaryPath: "/plugins/evil.ext/bin/payload",
        pluginPath: "/plugins/evil.ext",
      })

      expect(result.allowed).toBe(false)
    })

    it("the approved hash — not merely the presence of a row — is what allows", async () => {
      approve("p", "/plugins/p/bin", APPROVED_HASH)
      onDisk("/plugins/p/bin", APPROVED_HASH)
      const ok = await evaluateLspBinary({
        pluginId: "p",
        binaryPath: "/plugins/p/bin",
        pluginPath: "/plugins/p",
      })
      expect(ok.allowed).toBe(true)
      expect(ok.reason).toContain(APPROVED_HASH)
    })
  })

  describe("binary_hash_change_reprompts", () => {
    it("re-prompts when the approved binary's bytes changed on disk", async () => {
      approve("p", "/plugins/p/server/lsp", APPROVED_HASH)
      // The extension updated itself / swapped the payload after consent.
      onDisk("/plugins/p/server/lsp", OTHER_HASH)

      const result = await evaluateLspBinary({
        pluginId: "p",
        binaryPath: "/plugins/p/server/lsp",
        pluginPath: "/plugins/p",
      })

      expect(result.allowed).toBe(false)
      expect(result.requiresPrompt).toBe(true)
      expect(result.reason).toMatch(/changed since it was approved/i)
      expect(audit[0]!.decision).toBe("consent")
    })

    it("re-prompts when the binary cannot be read or hashed", async () => {
      approve("p", "/plugins/p/server/lsp", APPROVED_HASH)
      onDisk("/plugins/p/server/lsp", null) // read/hash failure

      const result = await evaluateLspBinary({
        pluginId: "p",
        binaryPath: "/plugins/p/server/lsp",
        pluginPath: "/plugins/p",
      })

      // An unhashable binary is "identity unknown", never "fine".
      expect(result.allowed).toBe(false)
      expect(result.requiresPrompt).toBe(true)
      expect(result.reason).toMatch(/could not be read or hashed/i)
    })

    it("allows again once the user re-approves the new hash", async () => {
      approve("p", "/plugins/p/server/lsp", OTHER_HASH)
      onDisk("/plugins/p/server/lsp", OTHER_HASH)

      const result = await evaluateLspBinary({
        pluginId: "p",
        binaryPath: "/plugins/p/server/lsp",
        pluginPath: "/plugins/p",
      })

      expect(result.allowed).toBe(true)
      expect(result.requiresPrompt).toBe(false)
    })
  })

  describe("binary_outside_plugin_dir_always_prompts", () => {
    it("prompts for an approved binary that lives outside the plugin dir", async () => {
      approve("p", "/usr/local/bin/rust-analyzer")
      onDisk("/usr/local/bin/rust-analyzer", APPROVED_HASH)

      const result = await evaluateLspBinary({
        pluginId: "p",
        binaryPath: "/usr/local/bin/rust-analyzer",
        pluginPath: "/plugins/p",
      })

      expect(result.allowed).toBe(false)
      expect(result.requiresPrompt).toBe(true)
      expect(result.reason).toMatch(/outside the plugin install directory/i)
    })

    it("prompts for a traversal path that escapes the plugin dir", async () => {
      approve("p", "/plugins/p/../../etc/evil")
      onDisk("/plugins/p/../../etc/evil", APPROVED_HASH)

      const result = await evaluateLspBinary({
        pluginId: "p",
        binaryPath: "/plugins/p/../../etc/evil",
        // A sibling prefix must not count as containment.
        pluginPath: "/plugins/p-other",
      })

      expect(result.allowed).toBe(false)
    })

    it("does not read the binary at all when it is outside the plugin dir", async () => {
      const hashBinary = jest.fn(async () => APPROVED_HASH)
      configureLspBinaryPolicy({ hashBinary })
      approve("p", "/usr/local/bin/tool")

      await evaluateLspBinary({
        pluginId: "p",
        binaryPath: "/usr/local/bin/tool",
        pluginPath: "/plugins/p",
      })

      expect(hashBinary).not.toHaveBeenCalled()
    })

    it("the plugin dir itself is not 'inside' itself", async () => {
      approve("p", "/plugins/p")
      onDisk("/plugins/p", APPROVED_HASH)

      const result = await evaluateLspBinary({
        pluginId: "p",
        binaryPath: "/plugins/p",
        pluginPath: "/plugins/p",
      })

      expect(result.allowed).toBe(false)
    })
  })

  it("prompts when the plugin has no approval at all", async () => {
    onDisk("/plugins/publisher.ext/server/bin", APPROVED_HASH)
    const result = await evaluateLspBinary({
      pluginId: "publisher.ext",
      binaryPath: "/plugins/publisher.ext/server/bin",
      pluginPath: "/plugins/publisher.ext",
    })
    expect(result.allowed).toBe(false)
    expect(result.requiresPrompt).toBe(true)
    expect(result.reason).toMatch(/no recorded user approval/i)
  })

  it("survives an audit-log write failure", async () => {
    approve("p", "/plugins/p/bin")
    onDisk("/plugins/p/bin", APPROVED_HASH)
    configureLspBinaryPolicy({
      appendAudit: async () => {
        throw new Error("dexie boom")
      },
    })
    // Decision should still resolve normally — audit is best-effort.
    const result = await evaluateLspBinary({
      pluginId: "p",
      binaryPath: "/plugins/p/bin",
      pluginPath: "/plugins/p",
    })
    expect(result.allowed).toBe(true)
  })

  it("normalises Windows-style paths for the inside-check", async () => {
    approve("p", "C:\\Users\\me\\plugins\\p\\bin\\server.exe")
    onDisk("C:\\Users\\me\\plugins\\p\\bin\\server.exe", APPROVED_HASH)
    const result = await evaluateLspBinary({
      pluginId: "p",
      binaryPath: "C:\\Users\\me\\plugins\\p\\bin\\server.exe",
      pluginPath: "C:\\Users\\me\\plugins\\p",
    })
    expect(result.allowed).toBe(true)
  })

  it("records the process name in the audit row", async () => {
    approve("p", "/plugins/p/server.exe")
    onDisk("/plugins/p/server.exe", APPROVED_HASH)
    await evaluateLspBinary({
      pluginId: "p",
      binaryPath: "/plugins/p/server.exe",
      pluginPath: "/plugins/p",
    })
    expect(audit[0]!.processName).toBe("server.exe")
  })

  describe("dev-mode override default read path", () => {
    // The default `isUnsignedLspAllowed` used to read
    // `settings.developer.unsignedLspAllowed`, which
    // `lib/lsp/migrate-settings.ts` moves to `lsp.unsignedAllowed` and then
    // clears at app start — so the settings toggle could never reach the
    // policy. Every other test in this file injects the flag, so nothing
    // caught it.
    beforeEach(() => {
      __resetLspBinaryPolicyForTesting()
      storedSettings.value = null
      configureLspBinaryPolicy({
        findApprovedBinary: async () => undefined,
        hashBinary: async () => null,
        appendAudit: async (row) => {
          audit.push(row)
        },
        now: () => 1_700_000_000_000,
      })
    })

    async function verdict() {
      return evaluateLspBinary({
        pluginId: "p1",
        pluginPath: "/plugins/p1",
        binaryPath: "/plugins/p1/bin/server",
      })
    }

    it("reads lsp.unsignedAllowed — the field Settings → Language Servers writes", async () => {
      storedSettings.value = { lsp: { unsignedAllowed: true } }
      expect((await verdict()).allowed).toBe(true)
    })

    it("still honours the pre-migration developer.unsignedLspAllowed", async () => {
      storedSettings.value = { developer: { unsignedLspAllowed: true } }
      expect((await verdict()).allowed).toBe(true)
    })

    it("denies when neither field is set", async () => {
      storedSettings.value = { lsp: {}, developer: {} }
      expect((await verdict()).allowed).toBe(false)
    })

    it("denies when there are no settings at all", async () => {
      storedSettings.value = null
      expect((await verdict()).allowed).toBe(false)
    })
  })

  describe("dev-mode override (settings.lsp.unsignedAllowed)", () => {
    it("relaxes an unapproved-binary decision to allow + prompt when toggle is on", async () => {
      devModeFlag = true
      onDisk("/plugins/p/bin", APPROVED_HASH)
      const result = await evaluateLspBinary({
        pluginId: "p",
        binaryPath: "/plugins/p/bin",
        pluginPath: "/plugins/p",
      })
      expect(result.allowed).toBe(true)
      expect(result.requiresPrompt).toBe(true)
      expect(result.reason).toMatch(/dev-mode override/i)
      // Audit row still captures the override + original reason.
      expect(audit[0]!.reason).toMatch(/dev-mode override/i)
      expect(audit[0]!.decision).toBe("allow")
    })

    it("relaxes a changed-hash decision when toggle is on, preserving the original reason", async () => {
      devModeFlag = true
      approve("p", "/plugins/p/bin", APPROVED_HASH)
      onDisk("/plugins/p/bin", OTHER_HASH)
      const result = await evaluateLspBinary({
        pluginId: "p",
        binaryPath: "/plugins/p/bin",
        pluginPath: "/plugins/p",
      })
      expect(result.allowed).toBe(true)
      expect(result.requiresPrompt).toBe(true)
      expect(result.reason).toMatch(/dev-mode override.*changed since it was approved/i)
    })

    it("does NOT relax an approved decision (already allowed, no prompt)", async () => {
      devModeFlag = true
      approve("p", "/plugins/p/server")
      onDisk("/plugins/p/server", APPROVED_HASH)
      const result = await evaluateLspBinary({
        pluginId: "p",
        binaryPath: "/plugins/p/server",
        pluginPath: "/plugins/p",
      })
      // Approved-inside-dir is already allowed without prompt — the dev
      // override must not introduce a needless prompt.
      expect(result.allowed).toBe(true)
      expect(result.requiresPrompt).toBe(false)
      expect(result.reason).not.toMatch(/dev-mode override/i)
    })

    it("falls back to off (deny + prompt) when the toggle read throws", async () => {
      configureLspBinaryPolicy({
        isUnsignedLspAllowed: async () => {
          throw new Error("settings db unavailable")
        },
      })
      onDisk("/plugins/p/bin", APPROVED_HASH)
      const result = await evaluateLspBinary({
        pluginId: "p",
        binaryPath: "/plugins/p/bin",
        pluginPath: "/plugins/p",
      })
      expect(result.allowed).toBe(false)
      expect(result.requiresPrompt).toBe(true)
    })

    it("ignores the toggle when it is off", async () => {
      devModeFlag = false
      onDisk("/plugins/p/bin", APPROVED_HASH)
      const result = await evaluateLspBinary({
        pluginId: "p",
        binaryPath: "/plugins/p/bin",
        pluginPath: "/plugins/p",
      })
      expect(result.allowed).toBe(false)
      expect(result.requiresPrompt).toBe(true)
      expect(result.reason).not.toMatch(/dev-mode override/i)
    })
  })
})
