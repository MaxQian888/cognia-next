import type { PluginIdeManifest } from "@/types/plugin/plugin-ide"
import { IdeManifestError, normalizeIdeManifest } from "./manifest"

const base = (overrides: Partial<PluginIdeManifest> = {}): PluginIdeManifest => ({
  schemaVersion: 1,
  targets: ["monaco", "pro-ide"],
  ...overrides,
})

describe("normalizeIdeManifest", () => {
  it("namespaces global ids and derives provider permissions and engine limits", () => {
    const result = normalizeIdeManifest("acme.tools", {
      ide: base({
        contributions: {
          commands: [{ command: "refresh", title: "Refresh" }],
        },
        providers: [
          { id: "hover", kind: "hover", handler: "provideHover" },
          {
            id: "debug",
            kind: "debug-adapter",
            handler: "createDebugAdapter",
            metadata: { debugType: "node" },
          },
        ],
      }),
    })

    expect(result.manifest.requirements).toMatchObject({
      codeApiVersion: "1.128.0",
      brokerProtocol: "^1.0.0",
    })
    expect(result.manifest.contributions.commands).toEqual([
      { command: "cognia.acme.tools.refresh", title: "Refresh" },
    ])
    expect(result.manifest.providers).toEqual([
      {
        id: "cognia.acme.tools.hover",
        kind: "hover",
        handler: "provideHover",
        permission: "editor:read",
      },
      {
        id: "cognia.acme.tools.debug",
        kind: "debug-adapter",
        handler: "createDebugAdapter",
        permission: "debug:control",
        proIdeOnly: true,
        metadata: { debugType: "cognia.acme.tools.node" },
      },
    ])
  })

  it("namespaces provider registration ids and rejects missing required metadata", () => {
    const result = normalizeIdeManifest("acme", {
      ide: base({
        providers: [
          {
            id: "models",
            kind: "language-model-chat-provider",
            handler: "provideModels",
            metadata: { vendor: "models" },
          },
          {
            id: "tasks",
            kind: "task",
            handler: "provideTasks",
            metadata: { type: "build" },
          },
        ],
      }),
    }).manifest

    expect(result.providers[0]?.metadata?.vendor).toBe("cognia.acme.models")
    expect(result.providers[1]?.metadata?.type).toBe("cognia.acme.build")
    expect(() =>
      normalizeIdeManifest("acme", {
        ide: base({
          providers: [{ id: "debug", kind: "debug-adapter", handler: "debug" }],
        }),
      })
    ).toThrow(/IDE_PROVIDER_METADATA_REQUIRED/)
  })

  it("rejects proposal-gated terminal quick-fix providers with a structured compatibility code", () => {
    expect(() =>
      normalizeIdeManifest("acme", {
        ide: base({
          providers: [
            {
              id: "quick-fix",
              kind: "terminal-quick-fix",
              handler: "provideQuickFixes",
            },
          ],
        } as never),
      } as never)
    ).toThrow("IDE_PROPOSED_API_UNSUPPORTED")
  })

  it.each([
    ["viewsWelcome", { viewsWelcome: [{ view: "explorer", contents: "Hi", group: "a" }] }],
    ["terminal", { terminal: { completionProviders: [{ id: "shell" }] } }],
    [
      "chatParticipants",
      { chatParticipants: [{ id: "assistant", name: "assistant", locations: ["panel"] }] },
    ],
    [
      "customEditors",
      {
        customEditors: [
          {
            viewType: "editor",
            displayName: "Editor",
            selector: [],
            priority: { textEditor: "default", diffEditor: "option" },
          },
        ],
      },
    ],
    [
      "resourceLabelFormatters",
      {
        resourceLabelFormatters: [
          {
            scheme: "file",
            formatting: { label: "${path}", separator: "/", workspaceTooltip: "${path}" },
          },
        ],
      },
    ],
  ])("rejects proposed subfields nested inside stable %s contributions", (_name, contributions) => {
    expect(() =>
      normalizeIdeManifest("acme", {
        ide: base({ contributions: contributions as never }),
      } as never)
    ).toThrow("IDE_PROPOSED_API_UNSUPPORTED")
  })

  it("projects Cognia-owned agents into native Chat contributions and providers", () => {
    const result = normalizeIdeManifest("acme", {
      ide: {
        schemaVersion: 1,
        targets: ["pro-ide"],
        agents: [
          {
            id: "reviewer",
            agentId: "acme:reviewer",
            name: "Reviewer",
            commands: [{ name: "review", description: "Review the workspace" }],
          },
        ],
      },
    }).manifest

    expect(result.contributions).not.toHaveProperty("chatParticipants")
    expect(result.providers).toEqual([
      expect.objectContaining({
        id: "cognia.acme.reviewer",
        kind: "chat-participant",
        handler: "$agent:acme:reviewer",
        permission: "agent:control",
      }),
    ])
  })

  it("namespaces stable notebook and AI contribution registries", () => {
    const result = normalizeIdeManifest("acme", {
      ide: {
        schemaVersion: 1,
        targets: ["pro-ide"],
        contributions: {
          notebooks: [
            {
              type: "analysis",
              displayName: "Analysis",
              selector: [{ filenamePattern: "*.analysis" }],
            },
          ],
          notebookRenderer: [
            {
              id: "renderer",
              displayName: "Renderer",
              mimeTypes: ["text/plain"],
              entrypoint: "notebooks/renderer.js",
            },
          ],
          chatParticipants: [
            {
              id: "reviewer",
              name: "reviewer",
              fullName: "Reviewer",
            },
          ],
        },
      },
    }).manifest

    expect(result.contributions.notebooks?.[0].type).toBe("cognia.acme.analysis")
    expect(result.contributions.notebookRenderer?.[0].id).toBe("cognia.acme.renderer")
    expect(result.contributions.chatParticipants?.[0].id).toBe("cognia.acme.reviewer")
  })

  it.each(["notebookPreload", "terminalQuickFixes", "languageModelToolSets", "speechProviders"])(
    "rejects proposal-gated Code 1.128 contribution %s",
    (contribution) => {
      expect(() =>
        normalizeIdeManifest("acme", {
          ide: base({
            contributions: { [contribution]: [] },
          }),
        })
      ).toThrow("IDE_PROPOSED_API_UNSUPPORTED")
    }
  )

  it("namespaces stable global contribution ids and rewrites their local references", () => {
    const result = normalizeIdeManifest("acme", {
      ide: base({
        contributions: {
          commands: [{ command: "refresh", title: "Refresh" }],
          keybindings: [{ command: "refresh", key: "cmd+r" }],
          submenus: [{ id: "tools", label: "Tools" }],
          menus: {
            tools: [{ command: "refresh" }],
          },
          languages: [{ id: "acme-lang", extensions: [".acme"] }],
          grammars: [
            {
              language: "acme-lang",
              scopeName: "source.acme",
              path: "syntaxes/acme.json",
            },
          ],
          viewsContainers: {
            activitybar: [{ id: "container", title: "Acme", icon: "icon.svg" }],
            panel: [],
          },
          views: {
            container: [{ id: "results", name: "Results", icon: "icon.svg" }],
          },
          viewsWelcome: [{ view: "results", contents: "Welcome" }],
          customEditors: [
            {
              viewType: "document",
              displayName: "Document",
              selector: [{ filenamePattern: "*.acme" }],
            },
          ],
          debuggers: [{ type: "debug", label: "Debug", languages: ["acme-lang"] }],
          taskDefinitions: [{ type: "build" }],
          authentication: [{ id: "auth", label: "Acme" }],
          mcpServerDefinitionProviders: [{ id: "mcp" }],
          languageModelChatProviders: [{ vendor: "models", displayName: "Acme Models" }],
          languageModelTools: [
            {
              name: "inspect",
              displayName: "Inspect",
              modelDescription: "Inspect the active workspace",
            },
          ],
        },
      }),
    }).manifest.contributions

    expect(result.keybindings?.[0]?.command).toBe("cognia.acme.refresh")
    expect(result.menus?.["cognia.acme.tools"]?.[0]?.command).toBe("cognia.acme.refresh")
    expect(result.languages?.[0]?.id).toBe("cognia.acme.acme-lang")
    expect(result.grammars?.[0]?.language).toBe("cognia.acme.acme-lang")
    expect(result.views?.["cognia.acme.container"]?.[0]?.id).toBe("cognia.acme.results")
    expect(result.viewsWelcome?.[0]?.view).toBe("cognia.acme.results")
    expect(result.customEditors?.[0]?.viewType).toBe("cognia.acme.document")
    expect(result.debuggers?.[0]).toMatchObject({
      type: "cognia.acme.debug",
      languages: ["cognia.acme.acme-lang"],
    })
    expect(result.taskDefinitions?.[0]?.type).toBe("cognia.acme.build")
    expect(result.authentication?.[0]?.id).toBe("cognia.acme.auth")
    expect(result.mcpServerDefinitionProviders?.[0]?.id).toBe("cognia.acme.mcp")
    expect(result.languageModelChatProviders?.[0]?.vendor).toBe("cognia.acme.models")
    expect(result.languageModelTools?.[0]?.name).toBe("cognia.acme.inspect")
  })

  it("rejects an unclassified contribution instead of silently passing it through", () => {
    expect(() =>
      normalizeIdeManifest("acme.tools", {
        ide: base({ contributions: { futureUnknownPoint: [] } }),
      })
    ).toThrow(
      new IdeManifestError(
        "IDE_CONTRIBUTION_UNCLASSIFIED",
        "Unsupported or unclassified Code 1.128 contribution: futureUnknownPoint"
      )
    )
  })

  it("enforces locked Code 1.128 contribution schemas before activation", () => {
    expect(() =>
      normalizeIdeManifest("acme.tools", {
        ide: base({
          contributions: {
            commands: [{ command: "refresh" } as never],
          },
        }),
      })
    ).toThrow(
      new IdeManifestError(
        "IDE_MANIFEST_SCHEMA_INVALID",
        "ide.contributions.commands[0].title: must have required property 'title'",
        "ide.contributions.commands[0].title"
      )
    )
  })

  it("rejects executable traversal and protocol references to undeclared executables", () => {
    expect(() =>
      normalizeIdeManifest("acme.tools", {
        ide: base({
          executables: [
            {
              id: "lsp",
              source: {
                kind: "plugin-resource",
                path: "../escape",
                sha256: `sha256:${"a".repeat(64)}`,
              },
            },
          ],
        }),
      })
    ).toThrow(/IDE_EXECUTABLE_RESOURCE_INVALID/)

    expect(() =>
      normalizeIdeManifest("acme.tools", {
        ide: base({
          protocols: {
            lsp: [{ id: "ts", executable: "missing", transport: "stdio" }],
          },
        }),
      })
    ).toThrow(/IDE_EXECUTABLE_NOT_DECLARED/)
  })

  it("validates protocol transports, target coverage and executable resources", () => {
    const executable = {
      id: "server",
      source: {
        kind: "plugin-resource" as const,
        path: "bin/server",
        sha256: `sha256:${"a".repeat(64)}`,
      },
    }
    const manifest = normalizeIdeManifest("acme", {
      ide: base({
        executables: [executable],
        protocols: {
          lsp: [{ id: "language", executable: "server", transport: "stdio" }],
        },
      }),
    }).manifest
    expect(manifest.protocols.lsp[0]?.id).toBe("cognia.acme.language")

    expect(() =>
      normalizeIdeManifest("acme", {
        ide: base({
          executables: [executable],
          protocols: {
            dap: [{ id: "debug", executable: "server", transport: "http" }],
          },
        }),
      })
    ).toThrow(/IDE_PROTOCOL_TRANSPORT_UNSUPPORTED/)

    for (const endpoint of [
      "tcp://example.com:5007",
      "tcp://user:secret@127.0.0.1:5007",
      "http://127.0.0.1:5007",
      "tcp://127.0.0.1",
    ]) {
      expect(() =>
        normalizeIdeManifest("acme", {
          ide: base({
            executables: [executable],
            protocols: {
              lsp: [
                {
                  id: "language",
                  executable: "server",
                  transport: "socket",
                  endpoint,
                },
              ],
            },
          }),
        })
      ).toThrow(/IDE_PROTOCOL_ENDPOINT/)
    }

    expect(() =>
      normalizeIdeManifest("acme", {
        ide: base({
          targets: ["monaco"],
          providers: [
            {
              id: "debug",
              kind: "debug-adapter",
              handler: "debug",
              metadata: { debugType: "debug" },
            },
          ],
        }),
      })
    ).toThrow(/IDE_PROVIDER_TARGET_UNAVAILABLE/)
  })

  it("rejects dangerous inherited process environment and native dependencies", () => {
    expect(() =>
      normalizeIdeManifest("acme", {
        ide: base({
          executables: [
            {
              id: "server",
              source: { kind: "registered-tool", tool: "node" },
              allowedEnvironment: ["LD_PRELOAD"],
            },
          ],
        }),
      })
    ).toThrow(/IDE_EXECUTABLE_ENVIRONMENT_INVALID/)

    expect(() =>
      normalizeIdeManifest("acme", {
        vscodeExtension: {
          extensionDependencies: ["evil.native"],
        },
      })
    ).toThrow(/IDE_EXTENSION_DEPENDENCIES_UNSUPPORTED/)
  })

  it("normalizes legacy VS Code contribution fields for one migration cycle", () => {
    const result = normalizeIdeManifest("legacy.theme", {
      vscodeExtension: {
        contributes: {
          commands: [{ command: "pick", title: "Pick" }],
        },
      },
      vscodeLanguages: [{ id: "legacy-lang", extensions: [".legacy"] }],
      vscodeGrammars: [{ scopeName: "source.legacy", path: "syntaxes/legacy.json" }],
      vscodeSnippets: [{ language: "legacy-lang", path: "snippets/legacy.json" }],
      vscodeIconThemes: [{ id: "legacy-icons", label: "Legacy", path: "icons.json" }],
    })

    expect(result.manifest.targets).toEqual(["monaco", "pro-ide"])
    expect(result.manifest.contributions.commands?.[0]?.command).toBe("cognia.legacy.theme.pick")
    expect(result.manifest.contributions.languages).toHaveLength(1)
    expect(result.manifest.contributions.grammars).toHaveLength(1)
    expect(result.manifest.contributions.snippets).toHaveLength(1)
    expect(result.manifest.contributions.iconThemes).toHaveLength(1)
    expect(result.warnings).toContain("IDE_LEGACY_MANIFEST_DEPRECATED")
  })

  it("rejects ambiguous new and legacy declarations", () => {
    expect(() =>
      normalizeIdeManifest("acme.tools", {
        ide: base(),
        vscodeLanguages: [{ id: "legacy" }],
      })
    ).toThrow(/IDE_MANIFEST_AMBIGUOUS/)
  })

  it("rejects ids reserved by another managed plugin namespace", () => {
    expect(() =>
      normalizeIdeManifest("acme", {
        ide: base({
          contributions: {
            commands: [{ command: "cognia.other.run", title: "Run" }],
          },
        }),
      })
    ).toThrow(/IDE_CONTRIBUTION_ID_RESERVED/)
  })

  it.each([
    ["IDE_SCHEMA_VERSION_UNSUPPORTED", base({ schemaVersion: 2 as never })],
    ["IDE_TARGET_REQUIRED", base({ targets: [] })],
    ["IDE_CODE_API_INCOMPATIBLE", base({ requirements: { codeApiVersion: "1.127.0" as never } })],
  ])("rejects incompatible top-level contracts with %s", (code, ide) => {
    expect(() => normalizeIdeManifest("acme", { ide })).toThrow(code)
  })

  it("rejects duplicate provider, executable, protocol, and agent registration ids", () => {
    expect(() =>
      normalizeIdeManifest("acme", {
        ide: base({
          providers: [
            { id: "hover", kind: "hover", handler: "hover" },
            { id: "hover", kind: "definition", handler: "definition" },
          ],
        }),
      })
    ).toThrow("IDE_PROVIDER_ID_CONFLICT")

    expect(() =>
      normalizeIdeManifest("acme", {
        ide: base({
          executables: [
            { id: "server", source: { kind: "registered-tool", tool: "node" } },
            { id: "server", source: { kind: "registered-tool", tool: "node" } },
          ],
        }),
      })
    ).toThrow("IDE_EXECUTABLE_ID_CONFLICT")

    const executable = {
      id: "server",
      source: { kind: "registered-tool" as const, tool: "node" },
    }
    expect(() =>
      normalizeIdeManifest("acme", {
        ide: base({
          executables: [executable],
          protocols: {
            lsp: [
              { id: "language", executable: "server", transport: "stdio" },
              { id: "language", executable: "server", transport: "stdio" },
            ],
          },
        }),
      })
    ).toThrow("IDE_PROTOCOL_ID_CONFLICT")

    expect(() =>
      normalizeIdeManifest("acme", {
        ide: base({
          providers: [{ id: "assistant", kind: "hover", handler: "hover" }],
          agents: [{ id: "assistant", agentId: "agent", name: "Agent" }],
        }),
      })
    ).toThrow("IDE_PROVIDER_ID_CONFLICT")
  })

  it.each([
    [
      "IDE_EXECUTABLE_SOURCE_INVALID",
      { id: "server", source: { kind: "registered-tool", tool: " " } },
    ],
    [
      "IDE_EXECUTABLE_SOURCE_INVALID",
      { id: "server", source: { kind: "user-selected", setting: " " } },
    ],
    [
      "IDE_EXECUTABLE_ARGUMENT_INVALID",
      {
        id: "server",
        source: { kind: "registered-tool", tool: "node" },
        args: ["bad\0arg"],
      },
    ],
    [
      "IDE_EXECUTABLE_ENVIRONMENT_INVALID",
      {
        id: "server",
        source: { kind: "registered-tool", tool: "node" },
        allowedEnvironment: ["lowercase"],
      },
    ],
  ])("rejects unsafe executable declarations with %s", (code, executable) => {
    expect(() =>
      normalizeIdeManifest("acme", {
        ide: base({ executables: [executable as never] }),
      })
    ).toThrow(code)
  })

  it("accepts exact loopback protocol endpoints and namespaces pre-namespaced ids once", () => {
    const result = normalizeIdeManifest("acme", {
      ide: base({
        executables: [{ id: "server", source: { kind: "registered-tool", tool: "node" } }],
        protocols: {
          lsp: [
            {
              id: "cognia.acme.language",
              executable: "server",
              transport: "socket",
              endpoint: "tcp://127.0.0.1:5007",
            },
          ],
          mcp: [
            {
              id: "tools",
              executable: "server",
              transport: "sse",
              endpoint: "http://[::1]:5008/events",
            },
          ],
        },
      }),
    }).manifest

    expect(result.protocols.lsp[0]?.id).toBe("cognia.acme.language")
    expect(result.protocols.mcp[0]?.id).toBe("cognia.acme.tools")
  })

  it("namespaces the remaining stable contribution registries and their references", () => {
    const contributions = normalizeIdeManifest("acme", {
      ide: base({
        contributions: {
          commands: [
            { command: "run", title: "Run" },
            { command: "manage", title: "Manage" },
          ],
          submenus: [{ id: "tools", label: "Tools" }],
          menus: {
            tools: [
              {
                command: "run",
                alt: "manage",
              },
              { submenu: "tools" },
            ],
          },
          languages: [{ id: "lang", extensions: [".lang"] }],
          snippets: [{ language: "lang, plaintext", path: "snippets.json" }],
          semanticTokenScopes: [{ language: "lang", scopes: { type: ["entity.name.type"] } }],
          walkthroughs: [
            {
              id: "start",
              title: "Start",
              description: "Start here",
              steps: [
                {
                  id: "step",
                  title: "Run",
                  media: { markdown: "walkthrough.md" },
                  completionEvents: ["onCommand:run", "onView:elsewhere"],
                },
              ],
            },
          ],
          themes: [{ id: "dark", label: "Dark", uiTheme: "vs-dark", path: "dark.json" }],
          iconThemes: [{ id: "files", label: "Files", path: "files.json" }],
          productIconThemes: [{ id: "product", label: "Product", path: "product.json" }],
          colors: [
            {
              id: "accent",
              description: "Accent",
              defaults: { light: "#ffffff", dark: "#000000" },
            },
          ],
          breakpoints: [{ language: "lang" }],
          problemMatchers: [{ name: "matcher", pattern: "pattern" }],
          problemPatterns: [{ name: "pattern", regexp: "^(.*):(\\d+)$" }],
          terminal: { profiles: [{ id: "shell", title: "Shell" }] },
          localizations: [
            {
              languageId: "pirate",
              translations: [{ id: "acme.extension", path: "package.nls.json" }],
            },
          ],
          languageModelChatProviders: [
            {
              vendor: "models",
              displayName: "Models",
              managementCommand: "manage",
            },
          ],
        },
      }),
    }).manifest.contributions

    expect(contributions.menus?.["cognia.acme.tools"]?.[0]).toMatchObject({
      command: "cognia.acme.run",
      alt: "cognia.acme.manage",
    })
    expect(contributions.menus?.["cognia.acme.tools"]?.[1]).toMatchObject({
      submenu: "cognia.acme.tools",
    })
    expect(contributions.snippets?.[0]?.language).toBe("cognia.acme.lang,plaintext")
    expect(contributions.semanticTokenScopes?.[0]?.language).toBe("cognia.acme.lang")
    expect(contributions.walkthroughs?.[0]).toMatchObject({
      id: "cognia.acme.start",
      steps: [
        {
          id: "cognia.acme.step",
          completionEvents: ["onCommand:cognia.acme.run", "onView:elsewhere"],
        },
      ],
    })
    expect(contributions.themes?.[0]?.id).toBe("cognia.acme.dark")
    expect(contributions.iconThemes?.[0]?.id).toBe("cognia.acme.files")
    expect(contributions.productIconThemes?.[0]?.id).toBe("cognia.acme.product")
    expect(contributions.colors?.[0]?.id).toBe("cognia.acme.accent")
    expect(contributions.breakpoints?.[0]?.language).toBe("cognia.acme.lang")
    expect(contributions.problemMatchers?.[0]?.name).toBe("cognia.acme.matcher")
    expect(contributions.problemPatterns?.[0]?.name).toBe("cognia.acme.pattern")
    expect(contributions.terminal?.profiles?.[0]?.id).toBe("cognia.acme.shell")
    expect(contributions.localizations?.[0]?.languageId).toBe("cognia.acme.pirate")
    expect(contributions.languageModelChatProviders?.[0]?.managementCommand).toBe(
      "cognia.acme.manage"
    )
  })

  it("rejects invalid local contribution ids", () => {
    expect(() =>
      normalizeIdeManifest("acme", {
        ide: base({
          contributions: {
            commands: [{ command: "invalid id", title: "Invalid" }],
          },
        }),
      })
    ).toThrow("IDE_CONTRIBUTION_ID_INVALID")
  })
})
