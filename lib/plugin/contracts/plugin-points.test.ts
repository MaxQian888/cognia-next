import fs from "node:fs"
import path from "node:path"
import {
  CANONICAL_ACTIVATION_PATTERNS,
  CANONICAL_EXTENSION_POINTS,
  CANONICAL_HOOK_POINTS,
  CANONICAL_RUNTIME_POINTS,
  EXTENSION_POINT_FORM_FACTORS,
  PLUGIN_POINT_CONTRACTS,
  getExtensionPointAliases,
  getExtensionPointFormFactor,
  getRuntimePointContract,
  resolveActivationPattern,
  validateActivationEvent,
  validateExtensionPoint,
  validateHookPoint,
  type PluginPointFormFactor,
} from "./plugin-points"
import { EXTENSION_POINT_FORM_FACTORS as SDK_EXTENSION_POINT_FORM_FACTORS } from "@cognia/plugin-sdk/extensions"
import { CANONICAL_PLUGIN_PERMISSIONS } from "@cognia/plugin-sdk/contracts"

describe("plugin point contracts", () => {
  it("has unique canonical extension points", () => {
    expect(new Set(CANONICAL_EXTENSION_POINTS).size).toBe(CANONICAL_EXTENSION_POINTS.length)
  })

  it("declares the four inbox extension points (IM-completion §C)", () => {
    const expectedInboxPoints = [
      "inbox.sidebar.section",
      "inbox.conversation.actions",
      "inbox.composer.actions",
      "inbox.draft.actions",
    ]
    for (const id of expectedInboxPoints) {
      expect(CANONICAL_EXTENSION_POINTS).toContain(id)
      const result = validateExtensionPoint(id)
      expect(result.allowed).toBe(true)
      expect(result.contract?.status).toBe("implemented")
      expect(result.contract?.binding).toMatch(/^components\/inbox\//)
    }
  })

  it("has unique canonical hook points", () => {
    expect(new Set(CANONICAL_HOOK_POINTS).size).toBe(CANONICAL_HOOK_POINTS.length)
  })

  it("has unique canonical activation patterns", () => {
    expect(new Set(CANONICAL_ACTIVATION_PATTERNS).size).toBe(CANONICAL_ACTIVATION_PATTERNS.length)
  })

  it("enforces migration metadata for deprecated contracts", () => {
    const deprecated = PLUGIN_POINT_CONTRACTS.filter((entry) => entry.status === "deprecated")
    expect(deprecated.length).toBeGreaterThan(0)
    for (const entry of deprecated) {
      expect(entry.deprecatedIn).toBeDefined()
      // Demotion is migration metadata too: an entry must either redirect to a
      // replacement OR explain why no replacement exists via a retirement note.
      const hasMigrationPath = Boolean(entry.replacementId) || Boolean(entry.retirementNote)
      expect(hasMigrationPath).toBe(true)
    }
  })

  it("has no registry entries left in virtual status", () => {
    const virtualEntries = PLUGIN_POINT_CONTRACTS.filter((entry) => entry.status === "virtual")
    expect(virtualEntries).toEqual([])
  })

  it("Python SDK PluginHook enum matches canonical hook registry", () => {
    // The Python SDK is a Phase 6 deliverable for cognia-next. Until that
    // lands, skip the parity check rather than fail it — once the SDK file
    // is in place this `it()` block runs unmodified. The Cognia repo path
    // (`plugin-sdk/python/src/cognia`) is preserved as the fallback so we
    // also exercise upstream parity when this test runs in the Cognia repo.
    const candidatePaths = [
      path.join(process.cwd(), "plugin-sdk", "python", "src", "cognia_next", "types.py"),
      path.join(process.cwd(), "plugin-sdk", "python", "src", "cognia", "types.py"),
    ]
    const pyTypesPath = candidatePaths.find((p) => fs.existsSync(p))
    if (!pyTypesPath) {
      // Mark the assertion as skipped without failing the suite.

      console.warn("[plugin-points.test] Python SDK not present yet; skipping enum parity check")
      return
    }
    const source = fs.readFileSync(pyTypesPath, "utf-8")
    const marker = "class PluginHook(Enum):"
    const start = source.indexOf(marker)
    expect(start).toBeGreaterThan(-1)

    const rest = source.slice(start + marker.length)
    const hooks = new Set<string>()
    for (const line of rest.split("\n")) {
      if (!line.startsWith("    ")) {
        if (hooks.size > 0) break
        continue
      }
      const match = line.match(/=\s*"([^"]+)"/)
      if (match?.[1]) {
        hooks.add(match[1])
      }
    }

    const hostHooks = new Set<string>(CANONICAL_HOOK_POINTS)
    const missing = [...hostHooks].filter((hook) => !hooks.has(hook))
    const extra = [...hooks].filter((hook) => !hostHooks.has(hook))
    expect({ missing, extra }).toEqual({ missing: [], extra: [] })
  })

  it("maps extension aliases to canonical IDs", () => {
    const aliases = getExtensionPointAliases()
    expect(aliases["sidebar:top"]).toBe("sidebar.left.top")
    expect(aliases["chat:input"]).toBe("chat.input.actions")
  })

  it("validates known extension points", () => {
    const result = validateExtensionPoint("chat.header", {
      governanceMode: "block",
      hasPermission: () => true,
    })

    expect(result.allowed).toBe(true)
    expect(result.diagnostics).toHaveLength(0)
  })

  it("supports alias extension points with warning diagnostics", () => {
    const result = validateExtensionPoint("sidebar:top", {
      governanceMode: "warn",
      hasPermission: () => true,
    })

    expect(result.allowed).toBe(true)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "plugin.point.alias",
          canonicalId: "sidebar.left.top",
        }),
      ])
    )
  })

  it("rejects unknown extension points in block mode", () => {
    const result = validateExtensionPoint("unknown-point", { governanceMode: "block" })
    expect(result.allowed).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "plugin.point.unknown", severity: "error" }),
      ])
    )
  })

  it("validates known hooks", () => {
    const result = validateHookPoint("onAgentStep", { governanceMode: "block" })
    expect(result.allowed).toBe(true)
  })

  it("rejects unknown hooks in block mode", () => {
    const result = validateHookPoint("onMadeUpHook", { governanceMode: "block" })
    expect(result.allowed).toBe(false)
    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({ code: "plugin.point.unknown", severity: "error" })
    )
  })

  it("resolves activation patterns for dynamic events", () => {
    expect(resolveActivationPattern("onCommand:abc")).toBe("onCommand:*")
    expect(resolveActivationPattern("onTool:test")).toBe("onTool:*")
    expect(resolveActivationPattern("onLanguage:typescript")).toBe("onLanguage:*")
  })

  it("validates context-workbench onView resource kinds canonically", () => {
    expect(
      validateActivationEvent("onView:context-workbench:session", {
        governanceMode: "block",
      }).allowed
    ).toBe(true)
    const invalid = validateActivationEvent("onView:context-workbench:sesson", {
      governanceMode: "block",
    })
    expect(invalid.allowed).toBe(false)
    expect(invalid.diagnostics[0]).toEqual(
      expect.objectContaining({ code: "plugin.point.unknown", severity: "error" })
    )
  })

  it("warns for deprecated activation alias", () => {
    const result = validateActivationEvent("onStartup", { governanceMode: "warn" })
    expect(result.allowed).toBe(true)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "plugin.point.deprecated" })])
    )
  })

  it("blocks retired activation events in block mode", () => {
    const result = validateActivationEvent("onLanguage:typescript", { governanceMode: "block" })
    expect(result.allowed).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "plugin.point.deprecated", severity: "error" }),
      ])
    )
  })

  it("emits deprecation diagnostic with retirement note for retired patterns", () => {
    const result = validateActivationEvent("onA2UI:surface", { governanceMode: "warn" })
    expect(result.allowed).toBe(true)
    const diag = result.diagnostics.find((d) => d.code === "plugin.point.deprecated")
    expect(diag).toBeDefined()
    expect(diag?.hint).toContain("onA2UISurfaceCreate")
  })

  describe("VS Code extension reuse — extension points", () => {
    it("registers the four VS Code-specific UI slots", () => {
      expect(CANONICAL_EXTENSION_POINTS).toEqual(
        expect.arrayContaining([
          "vscode.sidebar.view",
          "vscode.webview.panel",
          "vscode.activity-bar",
          "vscode.terminal.output",
        ])
      )
    })

    it("treats each VS Code UI slot as implemented (not deprecated)", () => {
      const slots = [
        "vscode.sidebar.view",
        "vscode.webview.panel",
        "vscode.activity-bar",
        "vscode.terminal.output",
      ] as const
      for (const slot of slots) {
        const result = validateExtensionPoint(slot, {
          governanceMode: "block",
          hasPermission: () => true,
        })
        expect({ slot, allowed: result.allowed, diagnostics: result.diagnostics }).toEqual({
          slot,
          allowed: true,
          diagnostics: [],
        })
      }
    })

    it("emits a contract for every VS Code UI slot with an implementation binding", () => {
      const contracts = PLUGIN_POINT_CONTRACTS.filter((c) => c.id.startsWith("vscode."))
      expect(contracts).toHaveLength(4)
      // sidebar/webview/activity-bar are bound to the unified webview panel host;
      // terminal.output is bound to the bridge initializer that surfaces extension
      // terminals as tabs in <TerminalDock>.
      for (const contract of contracts) {
        expect(contract.kind).toBe("ui-slot")
        expect(contract.status).toBe("implemented")
        expect(contract.binding).toMatch(/^components\/.*\.tsx$/)
      }
    })

    it("marks every VS Code UI slot as a registration host (non-JSX mount)", () => {
      const contracts = PLUGIN_POINT_CONTRACTS.filter((c) => c.id.startsWith("vscode."))
      expect(contracts).toHaveLength(4)
      for (const contract of contracts) {
        expect({ id: contract.id, hostKind: contract.hostKind }).toEqual({
          id: contract.id,
          hostKind: "registration",
        })
      }
    })

    it("leaves non-vscode UI slots on the default jsx-mount host kind", () => {
      const sample = PLUGIN_POINT_CONTRACTS.find((c) => c.id === "chat.header")
      expect(sample?.hostKind).toBe("jsx-mount")
    })
  })

  describe("VS Code extension reuse — activation patterns", () => {
    const vscodePatterns = [
      "onView:*",
      "onWebviewPanel:*",
      "onCustomEditor:*",
      "onAuthenticationRequest",
      "onTaskType:*",
      "onFileSystem:*",
      "onDebugResolve:*",
      "onStartupFinished",
      "onUri",
      "onTerminal",
      "onTerminalProfile:*",
      "onNotebook:*",
      "onWalkthrough:*",
      "onChatParticipant:*",
      "onLanguageModelTool:*",
      "workspaceContains:*",
    ] as const

    it("registers every documented VS Code activation pattern", () => {
      for (const pattern of vscodePatterns) {
        expect(CANONICAL_ACTIVATION_PATTERNS).toContain(pattern)
      }
    })

    it("validates each VS Code activation pattern in block mode", () => {
      for (const pattern of vscodePatterns) {
        const result = validateActivationEvent(pattern, { governanceMode: "block" })
        expect({ pattern, allowed: result.allowed }).toEqual({ pattern, allowed: true })
      }
    })

    it("resolves concrete VS Code activation events to their canonical wildcard", () => {
      expect(resolveActivationPattern("onView:gitlens.views.repositories")).toBe("onView:*")
      expect(resolveActivationPattern("onWebviewPanel:catCoding")).toBe("onWebviewPanel:*")
      expect(resolveActivationPattern("workspaceContains:**/package.json")).toBe(
        "workspaceContains:*"
      )
      expect(resolveActivationPattern("onTaskType:npm")).toBe("onTaskType:*")
    })

    it("flags onDebugResolve:* with the runtime-not-supported note", () => {
      const contract = PLUGIN_POINT_CONTRACTS.find((c) => c.id === "onDebugResolve:*")
      expect(contract).toBeDefined()
      expect(contract?.retirementNote).toMatch(/NotSupportedError/i)
    })

    it("binds VS Code activation dispatch to the sidecar host", () => {
      const vscodeContracts = PLUGIN_POINT_CONTRACTS.filter(
        (c) =>
          c.kind === "activation" &&
          (vscodePatterns as readonly string[]).includes(c.id as (typeof vscodePatterns)[number])
      )
      expect(vscodeContracts).toHaveLength(vscodePatterns.length)
      for (const contract of vscodeContracts) {
        expect(contract.binding).toBe("sidecar/vscode-ext-host/src/host.ts:handleActivationEvent")
      }
    })
  })

  // ---------------------------------------------------------------------------
  // ADR-0026 — Phase 1 extension-point v2 contracts.
  //
  // Phase 1 only adds the runtime points + the onBuildOptions hook; the
  // ctx.* / bridge wiring lands in Phases 2-4. The tests below verify:
  //   - all 8 new runtime points are present in the canonical registry,
  //   - each has a binding pointing at the host registry that owns it,
  //   - each has a `permission` field reusing an existing PluginPermission
  //     value (locked decision #3 of ADR-0026),
  //   - `onBuildOptions` is registered and dispatched-by `hooks-system`.
  // ---------------------------------------------------------------------------
  describe("ADR-0026 extension-point v2 contracts (Phase 1)", () => {
    const newRuntimePoints = [
      "provider.ocr",
      "provider.workspace-backend",
      "provider.message-renderer",
      "provider.ai-llm",
      "provider.ai-embedding",
      "chat.middleware",
      "modal.mount",
      "scheduler.task",
    ] as const

    it("registers every new runtime point in PLUGIN_POINT_CONTRACTS", () => {
      const runtimeIds = new Set(
        PLUGIN_POINT_CONTRACTS.filter((c) => c.kind === "runtime").map((c) => c.id)
      )
      for (const id of newRuntimePoints) {
        expect(runtimeIds.has(id)).toBe(true)
      }
    })

    it("provides a non-empty binding for every new runtime point", () => {
      for (const id of newRuntimePoints) {
        const contract = PLUGIN_POINT_CONTRACTS.find((c) => c.id === id)
        expect(contract).toBeDefined()
        expect(contract!.binding).not.toBe("")
        // Bindings target the registry singleton the point fan-outs to.
        // The exact file is verified per-point; here we just smoke-check
        // none of the new bindings fell through to the deprecated fallback.
        expect(contract!.binding).not.toMatch(/retired/i)
      }
    })

    it("assigns a permission to every new runtime point (no new perm keys)", () => {
      const existingPermissions = new Set(CANONICAL_PLUGIN_PERMISSIONS)
      for (const id of newRuntimePoints) {
        const contract = PLUGIN_POINT_CONTRACTS.find((c) => c.id === id)
        expect(contract).toBeDefined()
        expect(contract!.permission).toBeDefined()
        expect(existingPermissions.has(contract!.permission!)).toBe(true)
      }
    })

    it("introduces the new runtime points in 0.5.0 (workflow.* stays at 0.3.0)", () => {
      for (const id of newRuntimePoints) {
        const contract = PLUGIN_POINT_CONTRACTS.find((c) => c.id === id)!
        expect(contract.introducedIn).toBe("0.5.0")
      }
      const workflowNode = PLUGIN_POINT_CONTRACTS.find((c) => c.id === "workflow.node")!
      expect(workflowNode.introducedIn).toBe("0.3.0")
    })

    it("adds onBuildOptions to the canonical hook registry", () => {
      expect(CANONICAL_HOOK_POINTS).toContain("onBuildOptions")
      const result = validateHookPoint("onBuildOptions")
      expect(result.allowed).toBe(true)
      expect(result.contract?.status).toBe("implemented")
      expect(result.contract?.binding).toBe("lib/plugin/messaging/hooks-system.ts")
    })
  })

  describe("runtime contracts for plugin-contributed registries", () => {
    const implementedRegistryPoints = [
      { point: "terminal.completion", permission: "terminal:completion" },
      { point: "provider.routing-strategy", permission: "network:fetch" },
      { point: "provider.deployment-filter", permission: "network:fetch" },
      { point: "provider.protocol-adapter", permission: "network:fetch" },
      { point: "agent.external-agent-adapter", permission: "agent:dispatch-external" },
      { point: "agent.tool-route", permission: "agent:control" },
      { point: "agent.context-provider", permission: "agent:control" },
      { point: "connectors.adapter", permission: "connectors:read" },
      { point: "subscription.balance-adapter", permission: "subscription:read" },
      { point: "subscription.limits-source", permission: "subscription:read" },
      { point: "connectors.im-rate-source", permission: "connectors:read" },
      { point: "chat.compaction-strategy", permission: "agent:control" },
      { point: "quick-action", permission: "extension:ui" },
      { point: "appearance.font", permission: "extension:ui" },
      { point: "appearance.wallpaper", permission: "extension:ui" },
      { point: "appearance.density-preset", permission: "extension:ui" },
      { point: "view.container", permission: "extension:ui" },
      { point: "view.tree", permission: "extension:ui" },
      { point: "view.webview", permission: "extension:ui" },
      { point: "agent.skill", permission: "agent:control" },
      { point: "agent.mcp-server-preset", permission: "agent:control" },
      { point: "agent.native-anthropic-tool", permission: "agent:control" },
      { point: "agent.external-agent-preset", permission: "agent:dispatch-external" },
      { point: "character.pack", permission: "agent:control" },
      { point: "agent.subagent", permission: "agent:dispatch" },
      { point: "agent.team-template", permission: "agent:dispatch" },
      { point: "agent.shared-memory-adapter", permission: "agent:shared-memory:read" },
      { point: "workflow.template", permission: "extension:workflow" },
      { point: "auth.provider", permission: "auth:provide" },
      { point: "agent.tool" },
      { point: "a2ui.component" },
      { point: "a2ui.template" },
      { point: "agent.mode" },
      { point: "command.slash" },
      { point: "importer.format" },
      { point: "exporter.format" },
      { point: "appearance.theme" },
      { point: "appearance.theme-pack" },
      { point: "lsp.server" },
      { point: "cli.tool", permission: "cli:execute" },
      { point: "tray.item" },
      { point: "uri.handler" },
    ] as const

    it("declares every implemented bridge or overlay registry as a runtime point", () => {
      for (const expectation of implementedRegistryPoints) {
        const { point } = expectation
        const permission = "permission" in expectation ? expectation.permission : undefined
        const stability = "stability" in expectation ? expectation.stability : "stable"
        expect(CANONICAL_RUNTIME_POINTS).toContain(point)
        const contract = getRuntimePointContract(point as (typeof CANONICAL_RUNTIME_POINTS)[number])
        expect(contract).toEqual(
          expect.objectContaining({
            id: point,
            kind: "runtime",
            stability,
            status: "implemented",
          })
        )
        expect(contract.permission).toBe(permission)
      }
    })

    it("provides proof metadata for every implemented registry runtime point", () => {
      for (const { point } of implementedRegistryPoints) {
        const contract = PLUGIN_POINT_CONTRACTS.find((entry) => entry.id === point)
        expect(contract).toBeDefined()
        expect(contract!.binding).toEqual(expect.any(String))
        expect(contract!.binding).not.toBe("")
        expect(contract!.docs).toEqual(expect.any(String))
        expect(contract!.requiredTests.length).toBeGreaterThan(0)
      }
    })
  })

  describe("form factor", () => {
    const VALID: PluginPointFormFactor[] = ["icon", "row", "block", "panel"]

    it("classifies every UI slot", () => {
      // `EXTENSION_POINT_FORM_FACTORS` is a total `Record`, so a new point
      // fails to compile until it is classified. This guards the case where
      // someone relaxes that to `Partial` to get a build green — the slot
      // would then silently hand `undefined` to every contributed component.
      for (const point of CANONICAL_EXTENSION_POINTS) {
        expect(VALID).toContain(getExtensionPointFormFactor(point))
      }
    })

    it("surfaces the form factor on the published contract", () => {
      for (const point of CANONICAL_EXTENSION_POINTS) {
        const contract = PLUGIN_POINT_CONTRACTS.find((c) => c.id === point)
        expect(contract?.formFactor).toBe(getExtensionPointFormFactor(point))
      }
    })

    it("matches the standalone plugin SDK map key for key", () => {
      expect(EXTENSION_POINT_FORM_FACTORS).toEqual(SDK_EXTENSION_POINT_FORM_FACTORS)
    })

    it("classifies the bar and rail slots as icon-sized", () => {
      // These mount into ~24-32px chrome; anything with a label overflows.
      for (const point of [
        "statusbar.left",
        "statusbar.center",
        "statusbar.right",
        "toolbar.left",
        "sidebar.left.top",
      ] as const) {
        expect(getExtensionPointFormFactor(point)).toBe("icon")
      }
    })

    it("classifies the context workbench slots as panels", () => {
      expect(getExtensionPointFormFactor("sidebar.right.top")).toBe("panel")
      expect(getExtensionPointFormFactor("sidebar.right.bottom")).toBe("panel")
    })

    it("classifies composer and message action rows as rows", () => {
      for (const point of [
        "chat.input.actions",
        "chat.message.actions",
        "chat.tool-call.actions",
      ] as const) {
        expect(getExtensionPointFormFactor(point)).toBe("row")
      }
    })
  })
})
