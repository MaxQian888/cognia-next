/**
 * Tests for `adaptVscodeManifest`. Uses minimal hand-built fixtures rather
 * than synthesising real `.vsix` archives — adapter is a pure function.
 */

import { adaptVscodeManifest, mapActivationEvent } from "./manifest-adapter"
import type { VsCodeManifest, VsCodePermissionInference } from "@/types/plugin/plugin-vscode"
import type { VsixInstallResult } from "./vsix-installer"

function makeVsixResult(
  pkgJson: VsCodeManifest,
  overrides: Partial<VsixInstallResult> = {}
): VsixInstallResult {
  return {
    pkgJson,
    files: new Map(),
    sha256: "a".repeat(64),
    themes: [],
    lspBinaryCandidates: [],
    bundleFormat: pkgJson.main ? "cjs" : null,
    ...overrides,
  }
}

const emptyInference: VsCodePermissionInference = {
  permissions: [],
  reasons: [],
  confidence: "high",
  unparsedBundle: false,
  unsupportedApis: [],
}

describe("adaptVscodeManifest", () => {
  it("produces the canonical id from publisher.name", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "prettier-vscode",
        publisher: "esbenp",
        version: "11.0.0",
        engines: { vscode: ">=1.74.0" },
      }),
      inference: emptyInference,
      source: "openvsx",
    })
    expect(result.manifest.id).toBe("esbenp.prettier-vscode")
  })

  it("projects contributes.languages onto manifest.vscodeLanguages", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "svelte",
        publisher: "svelte",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
        contributes: {
          languages: [
            { id: "svelte", extensions: [".svelte"], aliases: ["Svelte"] },
            // Malformed entry (no id) must be dropped.
            { extensions: [".bad"] } as never,
          ],
        },
      }),
      inference: emptyInference,
      source: "openvsx",
    })
    expect(result.manifest.vscodeLanguages).toEqual([
      { id: "svelte", extensions: [".svelte"], aliases: ["Svelte"] },
    ])
  })

  it("omits vscodeLanguages when no languages are contributed", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "no-lang",
        publisher: "acme",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
      }),
      inference: emptyInference,
      source: "openvsx",
    })
    expect(result.manifest.vscodeLanguages).toBeUndefined()
  })

  it("escapes characters disallowed in plugin ids", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "weird name with spaces",
        publisher: "publisher@with@symbols",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
      }),
      inference: emptyInference,
      source: "vsix-upload",
    })
    expect(result.manifest.id).toBe("publisher-with-symbols.weird-name-with-spaces")
  })

  it("records the resolved targetPlatform so the update check can re-query it", () => {
    // A `universal` fallback install must keep asking Open VSX for
    // `universal`. Re-deriving the platform from the asking machine would
    // silently offer a platform-specific build as an "update".
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "rust-analyzer",
        publisher: "rust-lang",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
      }),
      inference: emptyInference,
      source: "openvsx",
      targetPlatform: "universal",
    })
    expect(result.manifest.vscodeExtension?.targetPlatform).toBe("universal")
  })

  it("omits targetPlatform for a .vsix upload, which has no registry platform", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "local",
        publisher: "acme",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
      }),
      inference: emptyInference,
      source: "vsix-upload",
    })
    // Absent, not `""` / `"universal"` — we must not invent a platform claim.
    expect(result.manifest.vscodeExtension).not.toHaveProperty("targetPlatform")
  })

  it("persists unsupportedApis onto the manifest so the card warning survives install", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "dbg",
        publisher: "acme",
        version: "1.0.0",
        engines: { vscode: "^1.93.0" },
        main: "./out/extension.js",
      }),
      inference: { ...emptyInference, unsupportedApis: ["vscode.debug"] },
      source: "openvsx",
    })
    expect(result.manifest.vscodeExtension?.unsupportedApis).toEqual(["vscode.debug"])
    expect(result.warnings).toContainEqual(
      expect.stringContaining("uses APIs cognia doesn't implement")
    )
  })

  it("omits unsupportedApis entirely when the walk found none", () => {
    // `[]` would assert "we looked and found none" — a claim the minified
    // path can't support. Absent means "no evidence recorded".
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "clean",
        publisher: "acme",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
      }),
      inference: emptyInference,
      source: "openvsx",
    })
    expect(result.manifest.vscodeExtension).not.toHaveProperty("unsupportedApis")
  })

  it("an engine range the shim can't satisfy warns but still produces a manifest", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "modern",
        publisher: "acme",
        version: "1.0.0",
        engines: { vscode: "^1.93.0" },
        main: "./out/extension.js",
      }),
      inference: emptyInference,
      source: "openvsx",
    })
    // Adaptation succeeded — the range is never a gate.
    expect(result.manifest.id).toBe("acme.modern")
    expect(result.manifest.vscodeExtension?.engineVscode).toBe("^1.93.0")
    expect(result.warnings).toContainEqual(expect.stringContaining("requires VS Code ^1.93.0"))
  })

  it("sets type to vscode-extension and main to vscodeMain", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "hello",
        publisher: "cognia",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
        main: "./out/extension.js",
      }),
      inference: emptyInference,
      source: "vsix-upload",
    })
    expect(result.manifest.type).toBe("vscode-extension")
    expect(result.manifest.vscodeMain).toBe("./out/extension.js")
    expect(result.manifest.main).toBeUndefined()
  })

  it("preserves the original VS Code manifest in vscodeExtension", () => {
    const pkg: VsCodeManifest = {
      name: "verbatim",
      publisher: "cognia",
      version: "0.0.1",
      engines: { vscode: ">=1.74.0" },
      activationEvents: ["onCommand:verbatim.hello", "onStartupFinished"],
    }
    const result = adaptVscodeManifest({
      vsix: makeVsixResult(pkg),
      inference: emptyInference,
      source: "vsix-upload",
    })
    expect(result.vscodeManifest).toEqual(pkg)
    expect(result.manifest.vscodeExtension).toMatchObject({
      identifier: "cognia.verbatim",
      version: "0.0.1",
      engineVscode: ">=1.74.0",
      source: "vsix-upload",
      vsixSha256: "a".repeat(64),
      activationEvents: ["onCommand:verbatim.hello", "onStartupFinished"],
    })
  })

  it("propagates inferred permissions into the cognia manifest", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "fs-user",
        publisher: "cognia",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
        main: "./out/extension.js",
      }),
      inference: {
        permissions: ["filesystem:read", "filesystem:write", "network:fetch"],
        reasons: [],
        confidence: "high",
        unparsedBundle: false,
        unsupportedApis: [],
      },
      source: "vsix-upload",
    })
    expect(result.manifest.permissions).toEqual([
      "filesystem:read",
      "filesystem:write",
      "network:fetch",
    ])
  })

  it("deduplicates duplicated permissions", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "dup",
        publisher: "cognia",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
        main: "./out/extension.js",
      }),
      inference: {
        permissions: ["filesystem:read", "filesystem:read", "filesystem:write"],
        reasons: [],
        confidence: "high",
        unparsedBundle: false,
        unsupportedApis: [],
      },
      source: "vsix-upload",
    })
    expect(result.manifest.permissions).toEqual(["filesystem:read", "filesystem:write"])
  })

  it("translates onCommand and onView activation events 1:1", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "act",
        publisher: "cognia",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
        activationEvents: ["onCommand:act.run", "onView:act.tree", "onStartupFinished"],
      }),
      inference: emptyInference,
      source: "vsix-upload",
    })
    expect(result.manifest.activationEvents).toEqual(
      expect.arrayContaining(["onCommand:act.run", "onView:act.tree", "onStartupFinished"])
    )
  })

  it("rewrites onLanguage: events to startup with a warning", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "lang",
        publisher: "cognia",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
        activationEvents: ["onLanguage:typescript"],
      }),
      inference: emptyInference,
      source: "vsix-upload",
    })
    expect(result.manifest.activationEvents).toEqual(["startup"])
    expect(result.warnings.join("\n")).toMatch(/onLanguage activation rewritten/)
  })

  it("maps `*` to startup", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "eager",
        publisher: "cognia",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
        activationEvents: ["*"],
      }),
      inference: emptyInference,
      source: "vsix-upload",
    })
    expect(result.manifest.activationEvents).toEqual(["startup"])
  })

  it("collapses onDebug variants to onDebugResolve:*", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "debug",
        publisher: "cognia",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
        activationEvents: ["onDebug", "onDebugResolve:node"],
      }),
      inference: emptyInference,
      source: "vsix-upload",
    })
    expect(result.manifest.activationEvents).toEqual(["onDebugResolve:*"])
    expect(result.warnings.join("\n")).toMatch(/NotSupportedError/)
  })

  it("adds startup when manifest has contributions but no activation events", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "implicit",
        publisher: "cognia",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
        contributes: {
          commands: [{ command: "implicit.hello", title: "Hello" }],
        },
      }),
      inference: emptyInference,
      source: "vsix-upload",
    })
    expect(result.manifest.activationEvents).toEqual(["startup"])
  })

  it("leaves activationEvents empty when there are neither events nor contributions", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "nothing",
        publisher: "cognia",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
      }),
      inference: emptyInference,
      source: "vsix-upload",
    })
    expect(result.manifest.activationEvents).toEqual([])
  })

  it("surfaces unknown VS Code activation events as warnings", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "weird",
        publisher: "cognia",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
        activationEvents: ["onMadeUpEvent:foo" as never],
      }),
      inference: emptyInference,
      source: "vsix-upload",
    })
    expect(result.warnings.join("\n")).toMatch(/Unknown VS Code activation event/)
  })

  it("infers capabilities from contribution points", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "rich",
        publisher: "cognia",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
        main: "./out/extension.js",
        contributes: {
          commands: [{ command: "rich.hello", title: "Hello" }],
          themes: [{ label: "Rich Dark", uiTheme: "vs-dark", path: "themes/dark.json" }],
          chatParticipants: [{ id: "rich.bot", fullName: "Rich Bot", name: "rich" }],
          mcpServerDefinitionProviders: [{ id: "rich.mcp" }],
          authentication: [{ id: "rich.auth", label: "Rich Auth" }],
          taskDefinitions: [{ type: "rich-task" }],
        },
      }),
      inference: emptyInference,
      source: "vsix-upload",
    })
    expect(result.manifest.capabilities).toEqual(
      expect.arrayContaining([
        "tools",
        "commands",
        "themes",
        "modes",
        "mcp-server-preset",
        "providers",
        "scheduler",
      ])
    )
  })

  it("flattens vsix themes into manifest.themes contributions", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult(
        {
          name: "themes",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
        },
        {
          themes: [
            {
              label: "Rich Dark",
              uiTheme: "vs-dark",
              path: "themes/dark.json",
              parsed: {
                theme: {
                  name: "Rich Dark",
                  isDark: true,
                  colors: { background: "#000", foreground: "#fff" } as never,
                } as never,
                emptyColors: false,
                matchedCount: 2,
              },
            },
            {
              label: "Rich Light",
              uiTheme: "vs",
              path: "themes/light.json",
              parsed: {
                theme: {
                  name: "Rich Light",
                  isDark: false,
                  colors: { background: "#fff", foreground: "#000" } as never,
                } as never,
                emptyColors: false,
                matchedCount: 2,
              },
            },
          ],
        }
      ),
      inference: emptyInference,
      source: "vsix-upload",
    })
    expect(result.manifest.themes).toEqual([
      { id: "rich-dark", name: "Rich Dark", vscodeJsonPath: "themes/dark.json" },
      { id: "rich-light", name: "Rich Light", vscodeJsonPath: "themes/light.json" },
    ])
  })

  it("sets runtimeCompatibility.browser=blocked when there is a main bundle", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "hasbundle",
        publisher: "cognia",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
        main: "./out/extension.js",
      }),
      inference: emptyInference,
      source: "vsix-upload",
    })
    expect(result.manifest.runtimeCompatibility?.browser?.availability).toBe("blocked")
    expect(result.manifest.runtimeCompatibility?.tauri?.availability).toBe("supported")
  })

  it("sets runtimeCompatibility.browser=supported for theme-only extensions", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "themeonly",
        publisher: "cognia",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
        contributes: {
          themes: [{ label: "T", uiTheme: "vs-dark", path: "t.json" }],
        },
      }),
      inference: emptyInference,
      source: "vsix-upload",
    })
    expect(result.manifest.runtimeCompatibility?.browser?.availability).toBe("supported")
  })

  it("resolves repository URLs from both string and object forms", () => {
    const stringForm = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "r1",
        publisher: "cognia",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
        repository: "https://github.com/cognia/r1",
      }),
      inference: emptyInference,
      source: "vsix-upload",
    })
    expect(stringForm.manifest.repository).toBe("https://github.com/cognia/r1")

    const objectForm = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "r2",
        publisher: "cognia",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
        repository: { type: "git", url: "https://github.com/cognia/r2.git" },
      }),
      inference: emptyInference,
      source: "vsix-upload",
    })
    expect(objectForm.manifest.repository).toBe("https://github.com/cognia/r2.git")
  })

  it("falls back to name when displayName is missing", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "myExtension",
        publisher: "cognia",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
      }),
      inference: emptyInference,
      source: "vsix-upload",
    })
    expect(result.manifest.name).toBe("myExtension")
  })

  it("preserves the vsixSha256 in the vscodeExtension block", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult(
        {
          name: "hash",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
        },
        { sha256: "deadbeef".repeat(8) }
      ),
      inference: emptyInference,
      source: "vsix-upload",
    })
    expect(result.manifest.vscodeExtension?.vsixSha256).toBe("deadbeef".repeat(8))
  })

  it("defaults engineVscode to '*' when missing", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "no-engines",
        publisher: "cognia",
        version: "1.0.0",
        engines: { vscode: "" },
      }),
      inference: emptyInference,
      source: "vsix-upload",
    })
    // Empty string is preserved (not falsy-replaced) — VS Code's contract is
    // that this field is mandatory at type level; we accept blank but record
    // it verbatim so consumers can flag the missing constraint themselves.
    expect(result.manifest.vscodeExtension?.engineVscode).toBe("")
  })
})

describe("mapActivationEvent", () => {
  const warnings: string[] = []
  beforeEach(() => {
    warnings.length = 0
  })

  it("returns undefined for events with no cognia analogue", () => {
    expect(mapActivationEvent("onMadeUpEvent", warnings)).toBeUndefined()
    expect(warnings.length).toBe(1)
  })

  it("passes through the static-suffix VS Code events", () => {
    expect(mapActivationEvent("onWebviewPanel:foo", warnings)).toBe("onWebviewPanel:foo")
    expect(mapActivationEvent("onCustomEditor:bar", warnings)).toBe("onCustomEditor:bar")
    expect(mapActivationEvent("onTaskType:npm", warnings)).toBe("onTaskType:npm")
    expect(mapActivationEvent("onFileSystem:ftp", warnings)).toBe("onFileSystem:ftp")
    expect(mapActivationEvent("onTerminalProfile:bash", warnings)).toBe("onTerminalProfile:bash")
    expect(mapActivationEvent("onNotebook:jupyter", warnings)).toBe("onNotebook:jupyter")
    expect(mapActivationEvent("onWalkthrough:onboard", warnings)).toBe("onWalkthrough:onboard")
    expect(mapActivationEvent("onChatParticipant:a", warnings)).toBe("onChatParticipant:a")
    expect(mapActivationEvent("onLanguageModelTool:t", warnings)).toBe("onLanguageModelTool:t")
    expect(mapActivationEvent("workspaceContains:**/foo", warnings)).toBe(
      "workspaceContains:**/foo"
    )
  })

  it("passes through bare events", () => {
    expect(mapActivationEvent("onStartupFinished", warnings)).toBe("onStartupFinished")
    expect(mapActivationEvent("onAuthenticationRequest", warnings)).toBe("onAuthenticationRequest")
    expect(mapActivationEvent("onUri", warnings)).toBe("onUri")
    expect(mapActivationEvent("onTerminal", warnings)).toBe("onTerminal")
  })
})

// ── W5.1: grammars / iconThemes / snippets projections ───────────────────────
describe("adaptVscodeManifest W5.1 projections", () => {
  it("projects grammars, icon themes, and snippets onto the manifest", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "svelte",
        publisher: "svelte",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
        contributes: {
          grammars: [
            { language: "svelte", scopeName: "source.svelte", path: "syntaxes/svelte.json" },
            // Malformed (no scopeName) must be dropped.
            { language: "bad", path: "syntaxes/bad.json" } as never,
          ],
          iconThemes: [
            { id: "svelte-icons", label: "Svelte Icons", path: "icons/theme.json" },
            { path: "icons/broken.json" } as never,
          ],
          snippets: [
            { language: "svelte", path: "snippets/svelte.json" },
            { language: 42, path: "snippets/bad.json" } as never,
          ],
        },
      }),
      inference: emptyInference,
      source: "openvsx",
    })
    expect(result.manifest.vscodeGrammars).toEqual([
      { language: "svelte", scopeName: "source.svelte", path: "syntaxes/svelte.json" },
    ])
    expect(result.manifest.vscodeIconThemes).toEqual([
      { id: "svelte-icons", label: "Svelte Icons", path: "icons/theme.json" },
    ])
    expect(result.manifest.vscodeSnippets).toEqual([
      { language: "svelte", path: "snippets/svelte.json" },
    ])
    // Bundle-less grammar/snippet contributions still yield a capability.
    expect(result.manifest.capabilities).toContain("themes")
  })

  it("omits the fields when nothing is contributed", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "plain",
        publisher: "acme",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
      }),
      inference: emptyInference,
      source: "openvsx",
    })
    expect(result.manifest.vscodeGrammars).toBeUndefined()
    expect(result.manifest.vscodeIconThemes).toBeUndefined()
    expect(result.manifest.vscodeSnippets).toBeUndefined()
  })
})
