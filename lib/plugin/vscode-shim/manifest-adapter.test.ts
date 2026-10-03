/**
 * Tests for `adaptVscodeManifest`. Uses minimal hand-built fixtures rather
 * than synthesising real `.vsix` archives — adapter is a pure function.
 */

import {
  adaptVscodeManifest,
  mapActivationEvent,
  UNSUPPORTED_VSCODE_ACTIVATION_PREFIXES,
  vscodeUnsupportedContributions,
} from "./manifest-adapter"
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

  it("resolves %nls% names and keeps the localized ones for the user's language", () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
    const result = adaptVscodeManifest({
      vsix: makeVsixResult(
        {
          name: "lint",
          publisher: "acme",
          version: "1.0.0",
          displayName: "%displayName%",
          description: "%description%",
          engines: { vscode: ">=1.74.0" },
          contributes: {
            configuration: {
              title: "Lint",
              properties: {
                "lint.run": { type: "string", default: "onSave", description: "%run%" },
              },
            },
          },
        },
        {
          files: new Map([
            [
              "package.nls.json",
              encode({
                displayName: "Acme Lint",
                description: "Lints",
                run: "When to lint",
                unused: "x",
              }),
            ],
            ["package.nls.zh-cn.json", encode({ displayName: "Acme 检查" })],
          ]),
        }
      ),
      inference: emptyInference,
      source: "openvsx",
    })
    expect(result.manifest).toMatchObject({
      name: "Acme Lint",
      description: "Lints",
      nameKey: "displayName",
      descriptionKey: "description",
      i18n: {
        locales: {
          en: { displayName: "Acme Lint", description: "Lints" },
          "zh-CN": { displayName: "Acme 检查" },
        },
      },
      configSchema: {
        type: "object",
        properties: {
          "lint.run": {
            type: "string",
            title: "Run",
            default: "onSave",
            description: "When to lint",
          },
        },
      },
    })
  })

  it("leaves names as written, and adds no settings, when there is nothing to resolve", () => {
    const result = adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "plain",
        publisher: "acme",
        version: "1.0.0",
        displayName: "Plain",
        engines: { vscode: ">=1.74.0" },
      }),
      inference: emptyInference,
      source: "openvsx",
    })
    expect(result.manifest.name).toBe("Plain")
    expect(result.manifest.nameKey).toBeUndefined()
    expect(result.manifest.i18n).toBeUndefined()
    expect(result.manifest.configSchema).toBeUndefined()
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

  const adaptActivation = (manifest: Partial<VsCodeManifest>) =>
    adaptVscodeManifest({
      vsix: makeVsixResult({
        name: "act",
        publisher: "cognia",
        version: "1.0.0",
        engines: { vscode: ">=1.74.0" },
        main: "./extension.js",
        ...manifest,
      }),
      inference: emptyInference,
      source: "vsix-upload",
    })

  it("keeps the events Cognia fires and starts `*`, onStartupFinished and onView at launch", () => {
    const result = adaptActivation({
      activationEvents: [
        "onCommand:act.run",
        "onLanguage:python",
        "workspaceContains:**/pyproject.toml",
        "onUri",
        "onAuthenticationRequest:github",
        "onView:act.tree",
        "onStartupFinished",
        "*",
      ],
    })
    expect(result.manifest.activationEvents).toEqual([
      "onCommand:act.run",
      "onLanguage:python",
      "workspaceContains:**/pyproject.toml",
      "onUri",
      "onAuthenticationRequest:github",
      "startup",
    ])
    expect(result.manifest.vscodeExtension?.activationPlanned).toBe(true)
    expect(result.manifest.vscodeExtension?.unsupportedActivationEvents).toBeUndefined()
    expect(result.warnings.join("\n")).toMatch(/"onView:act\.tree" starts the extension at launch/)
  })

  it("records the events Cognia never fires as unsupported", () => {
    const result = adaptActivation({
      activationEvents: ["onDebug", "onWebviewPanel:cat", "onNotebook:jupyter", "onCommand:a.b"],
    })
    expect(result.manifest.activationEvents).toEqual(["onCommand:a.b"])
    expect(result.manifest.vscodeExtension?.unsupportedActivationEvents).toEqual([
      "onDebug",
      "onWebviewPanel:cat",
      "onNotebook:jupyter",
    ])
    expect(result.warnings.join("\n")).toMatch(/"onDebug" is not supported in Cognia/)
  })

  it("does not start an extension whose only events are unsupported", () => {
    const result = adaptActivation({ activationEvents: ["onCustomEditor:x.y"] })
    expect(result.manifest.activationEvents).toEqual([])
  })

  it("adds VS Code's implicit events for contributed commands, languages and auth providers", () => {
    const result = adaptActivation({
      activationEvents: ["onCommand:act.run"],
      contributes: {
        commands: [
          { command: "act.run", title: "Run" },
          { command: "act.stop", title: "Stop" },
        ],
        languages: [{ id: "actlang" }],
        authentication: [{ id: "act-auth", label: "Act" }],
      },
    })
    expect(result.manifest.activationEvents).toEqual([
      "onCommand:act.run",
      "onCommand:act.stop",
      "onLanguage:actlang",
      "onAuthenticationRequest:act-auth",
    ])
  })

  it("starts an extension with contributed views at launch", () => {
    const result = adaptActivation({
      contributes: { views: { explorer: [{ id: "act.view", name: "Act" }] } },
    })
    expect(result.manifest.activationEvents).toEqual(["startup"])
  })

  it("starts an extension with no activation event at all at launch", () => {
    expect(adaptActivation({}).manifest.activationEvents).toEqual(["startup"])
  })

  it("lists contributed commands with resolved titles, categories and palette when clauses", () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
    const result = adaptVscodeManifest({
      vsix: makeVsixResult(
        {
          name: "act",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
          main: "./extension.js",
          contributes: {
            commands: [
              { command: "act.run", title: "%run.title%", category: "%category%" },
              { command: "act.hidden", title: "Hidden" },
              { command: "act.run", title: "Duplicate" },
            ],
            menus: {
              commandPalette: [
                { command: "act.hidden", when: "false" },
                { command: "act.run", when: "editorLangId == python" },
              ],
            },
          },
        },
        {
          files: new Map([
            ["package.nls.json", encode({ "run.title": "Run Act", category: "Act" })],
          ]),
        }
      ),
      inference: emptyInference,
      source: "vsix-upload",
    })
    expect(result.manifest.vscodeExtension?.commands).toEqual([
      { command: "act.run", title: "Run Act", category: "Act", when: "editorLangId == python" },
      { command: "act.hidden", title: "Hidden", when: "false" },
    ])
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

  it("returns undefined, with a warning, for an unknown event", () => {
    expect(mapActivationEvent("onMadeUpEvent", warnings)).toBeUndefined()
    expect(warnings).toEqual([
      'Unknown VS Code activation event "onMadeUpEvent"; the extension does not start for it.',
    ])
  })

  it.each(
    UNSUPPORTED_VSCODE_ACTIVATION_PREFIXES.map((prefix) => [
      `${prefix}${prefix.endsWith(":") ? "x" : ""}`,
    ])
  )("returns undefined for the unsupported %s", (event) => {
    expect(mapActivationEvent(event, warnings)).toBeUndefined()
    expect(warnings[0]).toMatch(/is not supported in Cognia/)
  })

  it("passes through the events Cognia fires", () => {
    for (const event of [
      "onCommand:a.b",
      "onLanguage:python",
      "workspaceContains:**/foo",
      "onUri",
      "onAuthenticationRequest",
      "onAuthenticationRequest:github",
    ]) {
      expect(mapActivationEvent(event, warnings)).toBe(event)
    }
    expect(warnings).toEqual([])
  })

  it("starts `*`, onStartupFinished and onView at launch", () => {
    expect(mapActivationEvent("*", warnings)).toBe("startup")
    expect(mapActivationEvent("onStartupFinished", warnings)).toBe("startup")
    expect(mapActivationEvent("onView:x", warnings)).toBe("startup")
  })

  it("refuses an event with an empty suffix", () => {
    expect(mapActivationEvent("onCommand:", warnings)).toBeUndefined()
    expect(mapActivationEvent("onAuthenticationRequest:", warnings)).toBeUndefined()
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

describe("vscodeUnsupportedContributions", () => {
  const manifest = (overrides: Partial<VsCodeManifest>): VsCodeManifest => ({
    name: "ext",
    publisher: "acme",
    version: "1.0.0",
    engines: { vscode: "^1.91.0" },
    ...overrides,
  })

  it("records each part Cognia does not provide, the ones that stop it working first", () => {
    const pkgJson = manifest({
      contributes: {
        debuggers: [{ type: "node", label: "Node" }] as never,
        notebooks: [{ type: "jupyter", displayName: "Jupyter", selector: [] }] as never,
        views: { explorer: [{ id: "files", name: "Files" }] },
        menus: {
          commandPalette: [{ command: "ext.run" }],
          "editor/context": [{ command: "ext.run" }],
        },
        keybindings: [{ command: "ext.run", key: "ctrl+r" }],
        grammars: [{ language: "x", scopeName: "source.x", path: "x.json" }],
      },
      extensionPack: ["acme.other"],
    })
    expect(vscodeUnsupportedContributions(pkgJson, "esm")).toEqual([
      "esm-bundle",
      "debuggers",
      "notebooks",
      "views",
      "menus",
      "keybindings",
      "editor-grammars",
      "extension-pack",
    ])
  })

  it("records nothing for what Cognia provides", () => {
    const pkgJson = manifest({
      contributes: {
        commands: [{ command: "ext.run", title: "Run" }],
        menus: { commandPalette: [{ command: "ext.run", when: "false" }] },
        // Webview views show in the extension rail.
        views: { explorer: [{ id: "chat", name: "Chat", type: "webview" }] },
        languages: [{ id: "x" }],
      },
      extensionPack: [],
    })
    expect(vscodeUnsupportedContributions(pkgJson, "cjs")).toEqual([])
    expect(vscodeUnsupportedContributions(manifest({}), null)).toEqual([])
  })

  it("counts breakpoints, notebook renderers, view containers and welcome content", () => {
    expect(
      vscodeUnsupportedContributions(
        manifest({ contributes: { breakpoints: [{ language: "x" }] } }),
        "cjs"
      )
    ).toEqual(["debuggers"])
    expect(
      vscodeUnsupportedContributions(
        manifest({ contributes: { notebookRenderer: [{ id: "r" }] as never } }),
        "cjs"
      )
    ).toEqual(["notebooks"])
    expect(
      vscodeUnsupportedContributions(
        manifest({
          contributes: {
            viewsContainers: { activitybar: [{ id: "c", title: "C", icon: "i" }], panel: [] },
          },
        }),
        "cjs"
      )
    ).toEqual(["views"])
    expect(
      vscodeUnsupportedContributions(
        manifest({ contributes: { viewsWelcome: [{ view: "v", contents: "Hi" }] as never } }),
        "cjs"
      )
    ).toEqual(["views"])
  })

  it("rides the extension block, and is absent when there is nothing to report", () => {
    const adapt = (pkgJson: VsCodeManifest, bundleFormat: "cjs" | "esm") =>
      adaptVscodeManifest({
        vsix: makeVsixResult(pkgJson, { bundleFormat }),
        inference: emptyInference,
        source: "openvsx",
      }).manifest.vscodeExtension
    expect(
      adapt(manifest({ main: "./out/extension.mjs" }), "esm")?.unsupportedContributions
    ).toEqual(["esm-bundle"])
    expect(adapt(manifest({ main: "./out/extension.js" }), "cjs")).not.toHaveProperty(
      "unsupportedContributions"
    )
  })
})
