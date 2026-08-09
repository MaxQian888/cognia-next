/** @jest-environment jsdom */
/**
 * Tests for Plugin Permission Guard
 */

import {
  PermissionGuard,
  getPermissionGuard,
  resetPermissionGuard,
  createPermissionGuard,
  __resetPermissionGuardForTesting,
  PermissionError,
  createGuardedAPI,
  PERMISSION_GROUPS,
  PERMISSION_DESCRIPTIONS,
  DANGEROUS_PERMISSIONS,
  WASM_UNIMPLEMENTED_PERMISSIONS,
} from "./permission-guard"
import type { PluginPermission as _PluginPermission } from "@/types/plugin"

describe("PermissionGuard", () => {
  let guard: PermissionGuard

  beforeEach(() => {
    resetPermissionGuard()
    guard = new PermissionGuard()
  })

  afterEach(() => {
    guard.clear()
  })

  describe("Plugin Registration", () => {
    it("should register a plugin with permissions", () => {
      guard.registerPlugin("plugin-a", ["network:fetch", "clipboard:read"])

      const permissions = guard.getPluginPermissions("plugin-a")
      expect(permissions).toContain("network:fetch")
      expect(permissions).toContain("clipboard:read")
    })

    it("should unregister a plugin", () => {
      guard.registerPlugin("plugin-a", ["network:fetch"])
      guard.unregisterPlugin("plugin-a")

      const permissions = guard.getPluginPermissions("plugin-a")
      expect(permissions).toEqual([])
    })
  })

  describe("Permission Checking", () => {
    beforeEach(() => {
      guard.registerPlugin("plugin-a", ["network:fetch", "clipboard:read"])
    })

    it("should return true for granted permissions", () => {
      expect(guard.check("plugin-a", "network:fetch")).toBe(true)
    })

    it("should return false for non-granted permissions", () => {
      expect(guard.check("plugin-a", "filesystem:write")).toBe(false)
    })

    it("should check multiple permissions", () => {
      expect(guard.checkMultiple("plugin-a", ["network:fetch", "clipboard:read"])).toBe(true)
      expect(guard.checkMultiple("plugin-a", ["network:fetch", "filesystem:write"])).toBe(false)
    })

    it("should check any permission", () => {
      expect(guard.checkAny("plugin-a", ["network:fetch", "filesystem:write"])).toBe(true)
      expect(guard.checkAny("plugin-a", ["filesystem:read", "filesystem:write"])).toBe(false)
    })
  })

  describe("Permission Requiring", () => {
    beforeEach(() => {
      guard.registerPlugin("plugin-a", ["network:fetch"])
    })

    it("should not throw for granted permissions", () => {
      expect(() => guard.require("plugin-a", "network:fetch")).not.toThrow()
    })

    it("should throw PermissionError for non-granted permissions", () => {
      expect(() => guard.require("plugin-a", "filesystem:write")).toThrow(PermissionError)
    })

    it("should throw with correct plugin and permission info", () => {
      try {
        guard.require("plugin-a", "filesystem:write")
        fail("Expected PermissionError to be thrown")
      } catch (error) {
        expect(error).toBeInstanceOf(PermissionError)
        expect((error as PermissionError).pluginId).toBe("plugin-a")
        expect((error as PermissionError).permission).toBe("filesystem:write")
      }
    })

    it("should require multiple permissions", () => {
      guard.registerPlugin("plugin-b", ["network:fetch", "clipboard:read"])

      expect(() =>
        guard.requireMultiple("plugin-b", ["network:fetch", "clipboard:read"])
      ).not.toThrow()

      expect(() =>
        guard.requireMultiple("plugin-b", ["network:fetch", "filesystem:write"])
      ).toThrow(PermissionError)
    })
  })

  describe("Permission Granting", () => {
    it("should grant permissions at runtime", () => {
      guard.registerPlugin("plugin-a", [])

      expect(guard.check("plugin-a", "network:fetch")).toBe(false)

      guard.grant("plugin-a", "network:fetch")

      expect(guard.check("plugin-a", "network:fetch")).toBe(true)
    })

    it("should grant with expiration", async () => {
      guard.registerPlugin("plugin-a", [])

      guard.grant("plugin-a", "network:fetch", { expiresIn: 50 })

      expect(guard.check("plugin-a", "network:fetch")).toBe(true)

      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(guard.check("plugin-a", "network:fetch")).toBe(false)
    })

    it("should track grant source", () => {
      guard.registerPlugin("plugin-a", ["network:fetch"])
      guard.grant("plugin-a", "clipboard:read", { grantedBy: "user" })

      const grants = guard.getPluginGrants("plugin-a")

      const networkGrant = grants.find((g) => g.permission === "network:fetch")
      const clipboardGrant = grants.find((g) => g.permission === "clipboard:read")

      expect(networkGrant?.grantedBy).toBe("manifest")
      expect(clipboardGrant?.grantedBy).toBe("user")
    })
  })

  describe("Permission Revocation", () => {
    beforeEach(() => {
      guard.registerPlugin("plugin-a", ["network:fetch", "clipboard:read"])
    })

    it("should revoke a permission", () => {
      expect(guard.check("plugin-a", "network:fetch")).toBe(true)

      guard.revoke("plugin-a", "network:fetch")

      expect(guard.check("plugin-a", "network:fetch")).toBe(false)
    })

    it("should revoke multiple permissions", () => {
      guard.revokeMultiple("plugin-a", ["network:fetch", "clipboard:read"])

      expect(guard.check("plugin-a", "network:fetch")).toBe(false)
      expect(guard.check("plugin-a", "clipboard:read")).toBe(false)
    })

    it("should revoke all permissions", () => {
      guard.revokeAll("plugin-a")

      expect(guard.getPluginPermissions("plugin-a")).toEqual([])
    })
  })

  describe("Audit Logging", () => {
    beforeEach(() => {
      guard.registerPlugin("plugin-a", ["network:fetch"])
    })

    it("should log permission checks", () => {
      guard.check("plugin-a", "network:fetch")
      guard.check("plugin-a", "filesystem:write")

      const log = guard.getAuditLog({ pluginId: "plugin-a" })
      expect(log.length).toBeGreaterThan(0)
    })

    it("should filter audit log by action", () => {
      guard.check("plugin-a", "network:fetch")
      guard.grant("plugin-a", "clipboard:read")

      const checks = guard.getAuditLog({ action: "check" })
      const grants = guard.getAuditLog({ action: "grant" })

      expect(checks.length).toBeGreaterThan(0)
      expect(grants.length).toBeGreaterThan(0)
    })

    it("records contextual usage without performing a second permission decision", () => {
      guard.recordUsage(
        "plugin-a",
        "network:fetch",
        "egress GET https://api.example.com/logs classification=operational pii=redact"
      )

      expect(guard.getAuditLog({ pluginId: "plugin-a" })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "check",
            allowed: true,
            context:
              "egress GET https://api.example.com/logs classification=operational pii=redact",
          }),
        ])
      )
    })

    it("should clear audit log", () => {
      guard.check("plugin-a", "network:fetch")
      guard.clearAuditLog()

      expect(guard.getAuditLog().length).toBe(0)
    })
  })

  describe("Introspection", () => {
    it("should get all plugins with a permission", () => {
      guard.registerPlugin("plugin-a", ["network:fetch"])
      guard.registerPlugin("plugin-b", ["network:fetch", "clipboard:read"])
      guard.registerPlugin("plugin-c", ["clipboard:read"])

      const plugins = guard.getAllPluginsWithPermission("network:fetch")
      expect(plugins).toContain("plugin-a")
      expect(plugins).toContain("plugin-b")
      expect(plugins).not.toContain("plugin-c")
    })

    it("should identify dangerous permissions", () => {
      expect(guard.isDangerousPermission("shell:execute")).toBe(true)
      expect(guard.isDangerousPermission("clipboard:read")).toBe(false)
    })

    it("should get permission descriptions", () => {
      const desc = guard.getPermissionDescription("network:fetch")
      expect(desc).toBeTruthy()
      expect(typeof desc).toBe("string")
    })
  })

  describe("Permission Tiers (ADR-0020 3-tier model)", () => {
    it("returns 'silent' for any (plugin, permission) that has no override", () => {
      expect(guard.getTier("p1", "network:fetch")).toBe("silent")
      expect(guard.getTier("not-registered", "shell:execute")).toBe("silent")
    })

    it("setTier persists the chosen tier and notifies subscribers", () => {
      const events: Array<{ pluginId: string; permission: string; tier: string }> = []
      const dispose = guard.subscribeTierChanges((pluginId, permission, tier) => {
        events.push({ pluginId, permission, tier })
      })
      guard.setTier("p1", "shell:execute", "forbid")
      guard.setTier("p1", "clipboard:read", "confirm")
      expect(guard.getTier("p1", "shell:execute")).toBe("forbid")
      expect(guard.getTier("p1", "clipboard:read")).toBe("confirm")
      expect(events).toEqual([
        { pluginId: "p1", permission: "shell:execute", tier: "forbid" },
        { pluginId: "p1", permission: "clipboard:read", tier: "confirm" },
      ])
      dispose()
      guard.setTier("p1", "filesystem:read", "confirm")
      expect(events).toHaveLength(2) // unsubscribed
    })

    it("getTiersForPlugin lists every non-default tier row", () => {
      guard.setTier("p1", "shell:execute", "forbid")
      guard.setTier("p1", "clipboard:read", "confirm")
      const rows = guard.getTiersForPlugin("p1")
      expect(rows).toHaveLength(2)
      expect(rows).toEqual(
        expect.arrayContaining([
          { permission: "shell:execute", tier: "forbid" },
          { permission: "clipboard:read", tier: "confirm" },
        ])
      )
      expect(guard.getTiersForPlugin("never-set")).toEqual([])
    })

    it("unregisterPlugin clears the plugin's tier rows", () => {
      guard.setTier("p1", "shell:execute", "forbid")
      guard.unregisterPlugin("p1")
      expect(guard.getTier("p1", "shell:execute")).toBe("silent")
      expect(guard.getTiersForPlugin("p1")).toEqual([])
    })

    it("a listener that throws does not crash setTier", () => {
      guard.subscribeTierChanges(() => {
        throw new Error("listener boom")
      })
      // Should not throw.
      expect(() => guard.setTier("p1", "network:fetch", "forbid")).not.toThrow()
      expect(guard.getTier("p1", "network:fetch")).toBe("forbid")
    })

    it("clear() drops every tier row + listener", () => {
      guard.setTier("p1", "shell:execute", "forbid")
      guard.clear()
      expect(guard.getTier("p1", "shell:execute")).toBe("silent")
    })
  })

  describe("confirmDangerousByDefault (C4 hardening flag)", () => {
    it("defaults ON: dangerous declared permissions register at the 'confirm' tier", () => {
      const g = new PermissionGuard()
      g.registerPlugin("p1", ["shell:execute", "clipboard:read"])
      // Secure by default — dangerous perms prompt; non-dangerous stay silent.
      expect(g.getTier("p1", "shell:execute")).toBe("confirm")
      expect(g.getTier("p1", "clipboard:read")).toBe("silent")
    })

    it("when explicitly off: dangerous declared permissions stay 'silent'", () => {
      const g = new PermissionGuard({ confirmDangerousByDefault: false })
      g.registerPlugin("p1", ["shell:execute", "network:fetch"])
      expect(g.getTier("p1", "shell:execute")).toBe("silent")
    })

    it("when on: dangerous declared permissions register at the 'confirm' tier", () => {
      const g = new PermissionGuard({ confirmDangerousByDefault: true })
      g.registerPlugin("p1", ["shell:execute", "terminal:write", "clipboard:read"])
      expect(g.getTier("p1", "shell:execute")).toBe("confirm")
      expect(g.getTier("p1", "terminal:write")).toBe("confirm")
      // Non-dangerous permissions are untouched.
      expect(g.getTier("p1", "clipboard:read")).toBe("silent")
    })

    it("when on but no dangerous permissions declared: no tier rows are created", () => {
      const g = new PermissionGuard({ confirmDangerousByDefault: true })
      g.registerPlugin("p1", ["clipboard:write", "clipboard:read"])
      expect(g.getTiersForPlugin("p1")).toEqual([])
    })
  })

  describe("checkWithConsent (tier-aware enforcement)", () => {
    const stubBroker = (response: boolean) => ({
      request: jest.fn(async () => response),
    })

    it("returns true for silent tier when the permission is granted", async () => {
      guard.registerPlugin("p1", ["clipboard:read"])
      const broker = stubBroker(true)
      await expect(guard.checkWithConsent("p1", "clipboard:read", broker)).resolves.toBe(true)
      expect(broker.request).not.toHaveBeenCalled()
    })

    it("returns false for silent tier when the permission is not granted", async () => {
      guard.registerPlugin("p1", [])
      const broker = stubBroker(true)
      await expect(guard.checkWithConsent("p1", "shell:execute", broker)).resolves.toBe(false)
      expect(broker.request).not.toHaveBeenCalled()
    })

    it("returns false immediately when tier === forbid, never asking the broker", async () => {
      guard.registerPlugin("p1", ["shell:execute"])
      guard.setTier("p1", "shell:execute", "forbid")
      const broker = stubBroker(true)
      await expect(guard.checkWithConsent("p1", "shell:execute", broker)).resolves.toBe(false)
      expect(broker.request).not.toHaveBeenCalled()
    })

    it("delegates to broker for confirm tier — respects allow", async () => {
      guard.registerPlugin("p1", ["filesystem:write"])
      guard.setTier("p1", "filesystem:write", "confirm")
      const broker = stubBroker(true)
      await expect(
        guard.checkWithConsent("p1", "filesystem:write", broker, { reason: "save artifact" })
      ).resolves.toBe(true)
      expect(broker.request).toHaveBeenCalledWith({
        pluginId: "p1",
        permission: "filesystem:write",
        reason: "save artifact",
      })
    })

    it("delegates to broker for confirm tier — respects deny", async () => {
      guard.registerPlugin("p1", ["filesystem:write"])
      guard.setTier("p1", "filesystem:write", "confirm")
      const broker = stubBroker(false)
      await expect(guard.checkWithConsent("p1", "filesystem:write", broker)).resolves.toBe(false)
    })

    it("writes an audit entry per outcome (silent/forbid/confirm)", async () => {
      guard.registerPlugin("p1", ["clipboard:read"])
      const broker = stubBroker(false)
      await guard.checkWithConsent("p1", "clipboard:read", broker) // silent → check
      guard.setTier("p1", "clipboard:read", "forbid")
      await guard.checkWithConsent("p1", "clipboard:read", broker) // forbid → deny
      guard.setTier("p1", "clipboard:read", "confirm")
      await guard.checkWithConsent("p1", "clipboard:read", broker) // confirm → request + deny
      const entries = guard.getAuditLog({ pluginId: "p1", permission: "clipboard:read" })
      // silent path uses "check"; forbid uses "deny"; confirm uses "request" + "deny".
      const actions = entries.map((e) => e.action)
      expect(actions).toEqual(expect.arrayContaining(["check", "deny", "request"]))
    })
  })
})

describe("createGuardedAPI", () => {
  let guard: PermissionGuard

  beforeEach(() => {
    resetPermissionGuard()
    guard = getPermissionGuard()
    guard.registerPlugin("plugin-a", ["clipboard:read"])
  })

  it("should create a guarded API", () => {
    const api = {
      fetchData: () => "data",
      writeFile: () => "written",
    }

    const guarded = createGuardedAPI("plugin-a", api, {
      fetchData: "clipboard:read",
      writeFile: "filesystem:write",
    })

    expect(guarded.fetchData()).toBe("data")
    expect(() => guarded.writeFile()).toThrow(PermissionError)
  })

  it("fails closed: an unmapped, non-unguarded method throws on call", () => {
    const api = {
      publicMethod: () => "public",
      protectedMethod: () => "protected",
    }

    const guarded = createGuardedAPI("plugin-a", api, {
      protectedMethod: "filesystem:write",
    })

    expect(() => guarded.publicMethod()).toThrow(/neither permission-mapped nor declared unguarded/)
  })

  it("onConsentGranted fires after a confirm-tier approval, but not for silent methods", async () => {
    // fs:write is dangerous → confirm tier; clipboard:read stays silent. The
    // hook lets a host-gated namespace persist a ledger grant once the user
    // consents, so the desktop gateway accepts the follow-up call.
    guard.registerPlugin("plugin-a", ["filesystem:write", "clipboard:read"])
    const granted: string[] = []
    const api = {
      writeText: async () => "ok",
      readText: () => "value",
    }
    const guarded = createGuardedAPI(
      "plugin-a",
      api,
      { writeText: "filesystem:write", readText: "clipboard:read" },
      { onConsentGranted: (permission) => granted.push(permission) }
    )

    await guarded.writeText()
    expect(granted).toEqual(["filesystem:write"])

    guarded.readText()
    expect(granted).toEqual(["filesystem:write"]) // silent read does not consent
  })

  it("passes through a method explicitly listed in unguarded", () => {
    const api = {
      helper: () => "helper-result",
      gated: () => "gated",
    }

    const guarded = createGuardedAPI(
      "plugin-a",
      api,
      { gated: "filesystem:read" },
      { unguarded: ["helper"] }
    )

    expect(guarded.helper()).toBe("helper-result")
  })

  it("passes through non-function properties unchanged", () => {
    const api = { value: 42, builder: { make: () => "x" }, gated: () => "g" }
    const guarded = createGuardedAPI("plugin-a", api, { gated: "filesystem:read" })
    expect(guarded.value).toBe(42)
    expect(guarded.builder.make()).toBe("x")
  })

  // Per-call consent path: a dangerous (confirm-tier) permission routes the
  // guarded async method through the consent broker before running. The
  // jest.setup auto-responder honors `globalThis.__PLUGIN_CONSENT_AUTO`.
  describe("consent path (confirm tier)", () => {
    const flags = globalThis as { __PLUGIN_CONSENT_AUTO?: "allow" | "deny" | "off" }
    afterEach(() => {
      flags.__PLUGIN_CONSENT_AUTO = "allow"
    })

    it("routes a confirm-tier async method through consent and runs it on allow", async () => {
      // filesystem:write is DANGEROUS → confirm tier under the default posture.
      guard.registerPlugin("p", ["filesystem:write"])
      expect(guard.getTier("p", "filesystem:write")).toBe("confirm")
      const fn = jest.fn(async () => "ok")
      const guarded = createGuardedAPI("p", { writeFile: fn }, { writeFile: "filesystem:write" })
      flags.__PLUGIN_CONSENT_AUTO = "allow"
      await expect(guarded.writeFile()).resolves.toBe("ok")
      expect(fn).toHaveBeenCalled()
    })

    it("rejects the call when consent is denied, without running the method", async () => {
      guard.registerPlugin("p", ["filesystem:write"])
      const fn = jest.fn(async () => "ok")
      const guarded = createGuardedAPI("p", { writeFile: fn }, { writeFile: "filesystem:write" })
      flags.__PLUGIN_CONSENT_AUTO = "deny"
      await expect(guarded.writeFile()).rejects.toThrow(PermissionError)
      expect(fn).not.toHaveBeenCalled()
    })

    it("consentExempt methods skip the prompt and stay synchronous", () => {
      guard.registerPlugin("p", ["filesystem:write"])
      const fn = jest.fn(() => "sync-result")
      const guarded = createGuardedAPI(
        "p",
        { query: fn },
        { query: "filesystem:write" },
        { consentExempt: ["query"] }
      )
      // Even with consent set to deny, an exempt method skips the prompt and
      // returns synchronously (the granted permission still gates access).
      flags.__PLUGIN_CONSENT_AUTO = "deny"
      expect(guarded.query()).toBe("sync-result")
      expect(fn).toHaveBeenCalled()
    })
  })
})

describe("Permission Constants", () => {
  it("should have permission groups", () => {
    expect(PERMISSION_GROUPS.filesystem).toContain("filesystem:read")
    expect(PERMISSION_GROUPS.filesystem).toContain("filesystem:write")
    expect(PERMISSION_GROUPS.network).toContain("network:fetch")
    expect(PERMISSION_GROUPS.network).toContain("network:upload")
  })

  it("should have permission descriptions", () => {
    expect(PERMISSION_DESCRIPTIONS["network:fetch"]).toBeTruthy()
    expect(PERMISSION_DESCRIPTIONS["network:upload"]).toBeTruthy()
    expect(PERMISSION_DESCRIPTIONS["filesystem:write"]).toBeTruthy()
    expect(PERMISSION_DESCRIPTIONS["builtin-skills:invoke"]).toMatch(/built-in skills/i)
    expect(PERMISSION_DESCRIPTIONS["extension:workflow"]).toBe(
      "Contribute workflow nodes, triggers, tasks, and templates"
    )
  })

  it("should have dangerous permissions list", () => {
    expect(DANGEROUS_PERMISSIONS).toContain("shell:execute")
    expect(DANGEROUS_PERMISSIONS).toContain("process:spawn")
  })

  it("lists no WASM stub capabilities in api-version 0.2", () => {
    // Every capability the v0.2 WIT declares has a backend: clipboard and
    // notifications are served in-process by the Tauri plugins, and
    // ai.generate-text / workflow.emit-event go through the renderer bridge.
    expect(WASM_UNIMPLEMENTED_PERMISSIONS).toEqual([])
  })

  it("no longer disables the clipboard permissions the v0.2 host implements", () => {
    // The regression this pins: leaving these listed would make the grant sheet
    // render working capabilities as permanently disabled and never add them to
    // the granted set — implemented in Rust, unreachable in practice.
    expect(WASM_UNIMPLEMENTED_PERMISSIONS).not.toContain("clipboard:read")
    expect(WASM_UNIMPLEMENTED_PERMISSIONS).not.toContain("clipboard:write")
    expect(WASM_UNIMPLEMENTED_PERMISSIONS).not.toContain("notification")
    // ai.generate-text is gated on ai:chat as of v0.2, not network:fetch.
    expect(WASM_UNIMPLEMENTED_PERMISSIONS).not.toContain("ai:chat")
    expect(WASM_UNIMPLEMENTED_PERMISSIONS).not.toContain("network:fetch")
  })

  it("flags network egress as dangerous (arbitrary-host fetch is an exfiltration channel)", () => {
    // network:* reaches any host and can carry whatever the plugin can read
    // (secrets, clipboard, fs). It must prompt for consent rather than being
    // silently granted on enable.
    expect(DANGEROUS_PERMISSIONS).toContain("network:fetch")
    expect(DANGEROUS_PERMISSIONS).toContain("network:upload")
    expect(DANGEROUS_PERMISSIONS).toContain("network:websocket")
  })

  describe("terminal:* permissions (plan: vscode-vivid-wilkinson)", () => {
    it("groups terminal permissions under a `terminal` family", () => {
      expect(PERMISSION_GROUPS.terminal).toEqual(
        expect.arrayContaining(["terminal:spawn", "terminal:write", "terminal:kill"])
      )
    })

    it("describes each terminal permission", () => {
      expect(PERMISSION_DESCRIPTIONS["terminal:spawn"]).toBeTruthy()
      expect(PERMISSION_DESCRIPTIONS["terminal:write"]).toBeTruthy()
      expect(PERMISSION_DESCRIPTIONS["terminal:kill"]).toBeTruthy()
    })

    it("flags terminal:spawn and terminal:write as dangerous (arbitrary code execution surface)", () => {
      expect(DANGEROUS_PERMISSIONS).toContain("terminal:spawn")
      // Wave 3 — writing to an existing terminal session is equivalent
      // to executing arbitrary shell commands in that shell, so it
      // sits in the same risk tier as terminal:spawn.
      expect(DANGEROUS_PERMISSIONS).toContain("terminal:write")
    })

    it("does NOT flag terminal:kill as dangerous on its own", () => {
      // Killing a session you already have a handle to is recoverable —
      // medium risk at worst (kills the user's work). Marking it
      // dangerous would force per-call confirmation which is more
      // annoying than the action warrants.
      expect(DANGEROUS_PERMISSIONS).not.toContain("terminal:kill")
    })

    it("granting terminal:spawn lets check() pass for that permission only", () => {
      const guard = new PermissionGuard()
      guard.registerPlugin("term-plugin", ["terminal:spawn"])
      expect(guard.check("term-plugin", "terminal:spawn")).toBe(true)
      expect(guard.check("term-plugin", "terminal:write")).toBe(false)
      expect(guard.check("term-plugin", "terminal:kill")).toBe(false)
    })

    it("checkMultiple gates a plugin that only holds spawn but not write", () => {
      const guard = new PermissionGuard()
      guard.registerPlugin("term-plugin", ["terminal:spawn"])
      expect(guard.checkMultiple("term-plugin", ["terminal:spawn", "terminal:write"])).toBe(false)
    })
  })
})

describe("Singleton", () => {
  it("should return the same instance", () => {
    resetPermissionGuard()
    const instance1 = getPermissionGuard()
    const instance2 = getPermissionGuard()
    expect(instance1).toBe(instance2)
  })
})

describe("Factory + __resetForTesting (PR-E)", () => {
  beforeEach(() => {
    resetPermissionGuard()
  })

  it("createPermissionGuard returns a fresh instance independent of the default", () => {
    const defaultGuard = getPermissionGuard()
    const isolated = createPermissionGuard({ strictMode: false })
    expect(isolated).not.toBe(defaultGuard)
    // State changes on the isolated guard MUST NOT leak into the default.
    isolated.registerPlugin("isolated-plugin", ["network:fetch"])
    expect(isolated.check("isolated-plugin", "network:fetch")).toBe(true)
    expect(defaultGuard.check("isolated-plugin", "network:fetch")).toBe(false)
  })

  it("__resetPermissionGuardForTesting drops the default instance", () => {
    const first = getPermissionGuard()
    __resetPermissionGuardForTesting()
    const second = getPermissionGuard()
    expect(first).not.toBe(second)
  })

  it("__resetPermissionGuardForTesting throws outside NODE_ENV=test", () => {
    const original = process.env.NODE_ENV
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    try {
      expect(() => __resetPermissionGuardForTesting()).toThrow(/NODE_ENV=test/)
    } finally {
      ;(process.env as Record<string, string | undefined>).NODE_ENV = original
    }
  })
})
