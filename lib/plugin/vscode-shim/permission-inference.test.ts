/**
 * Tests for `inferPermissions`. Hand-built `VsixInstallResult` fixtures —
 * no real ZIP parsing involved.
 */

import { UNAVAILABLE_VSCODE_MEMBERS } from "./engine-compat"
import { inferPermissions } from "./permission-inference"
import type { VsixInstallResult } from "./vsix-installer"
import type { VsCodeManifest } from "@/types/plugin/plugin-vscode"

function makeVsix(
  pkgJson: VsCodeManifest,
  files: Record<string, string> = {},
  overrides: Partial<VsixInstallResult> = {}
): VsixInstallResult {
  const filesMap = new Map<string, Uint8Array>()
  const encoder = new TextEncoder()
  for (const [path, content] of Object.entries(files)) {
    filesMap.set(path, encoder.encode(content))
  }
  return {
    pkgJson,
    files: filesMap,
    sha256: "0".repeat(64),
    themes: [],
    lspBinaryCandidates: [],
    bundleFormat: pkgJson.main ? "cjs" : null,
    ...overrides,
  }
}

const HEAD: VsCodeManifest = {
  name: "x",
  publisher: "cognia",
  version: "1.0.0",
  engines: { vscode: ">=1.74.0" },
}

describe("inferPermissions", () => {
  describe("theme-only path", () => {
    it("returns empty permissions for an extension with no main bundle", () => {
      const result = inferPermissions({
        vsix: makeVsix({
          ...HEAD,
          contributes: {
            themes: [{ label: "T", uiTheme: "vs-dark", path: "t.json" }],
          },
        }),
      })
      expect(result.permissions).toEqual([])
      expect(result.unparsedBundle).toBe(false)
      expect(result.confidence).toBe("high")
    })
  })

  describe("AST-based detection on un-minified bundles", () => {
    it("detects require('fs') → filesystem:read+write", () => {
      const result = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          { "out/extension.js": `const fs = require("fs"); module.exports = {}` }
        ),
      })
      expect(result.permissions).toEqual(
        expect.arrayContaining(["filesystem:read", "filesystem:write"])
      )
      expect(result.confidence).toBe("high")
    })

    it("detects require('child_process') → process:spawn + shell:execute", () => {
      const result = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          {
            "out/extension.js": `const { spawn } = require("child_process"); module.exports = {}`,
          }
        ),
      })
      expect(result.permissions).toEqual(expect.arrayContaining(["process:spawn", "shell:execute"]))
    })

    it("detects ESM import 'node:fs' → filesystem permissions", () => {
      const result = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.mjs" },
          { "out/extension.mjs": `import { readFile } from "node:fs/promises"` }
        ),
      })
      expect(result.permissions).toEqual(
        expect.arrayContaining(["filesystem:read", "filesystem:write"])
      )
    })

    it("detects http / https / node-fetch → network:fetch", () => {
      const result = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          {
            "out/extension.js":
              `const http = require("http"); const https = require("https");` +
              `const fetch = require("node-fetch");`,
          }
        ),
      })
      expect(result.permissions).toContain("network:fetch")
    })

    it("detects ws / net → network:websocket + network:fetch", () => {
      const result = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          { "out/extension.js": `const ws = require("ws"); const net = require("net");` }
        ),
      })
      expect(result.permissions).toEqual(
        expect.arrayContaining(["network:websocket", "network:fetch"])
      )
    })

    it("detects top-level fetch() calls", () => {
      const result = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          { "out/extension.js": `fetch("https://example.com")` }
        ),
      })
      expect(result.permissions).toContain("network:fetch")
    })

    const infer = (source: string) =>
      inferPermissions({
        vsix: makeVsix({ ...HEAD, main: "out/extension.js" }, { "out/extension.js": source }),
      })

    it("detects fetch reached through the global object, but not a method named fetch", () => {
      expect(infer(`globalThis.fetch("https://example.com")`).permissions).toContain(
        "network:fetch"
      )
      expect(infer(`self.fetch(url)`).permissions).toContain("network:fetch")
      expect(infer(`repo.fetch("origin")`).permissions).not.toContain("network:fetch")
    })

    it("detects new WebSocket → network:websocket + network:fetch", () => {
      for (const source of [
        `new WebSocket("wss://example.com")`,
        `new globalThis.WebSocket(url)`,
      ]) {
        const result = infer(source)
        expect(result.permissions).toEqual(
          expect.arrayContaining(["network:websocket", "network:fetch"])
        )
        expect(result.reasons).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              permission: "network:websocket",
              trigger: { kind: "websocket" },
            }),
          ])
        )
      }
      expect(infer(`new socket.WebSocketServer()`).permissions).not.toContain("network:websocket")
    })

    it("finds fetch( and new WebSocket( by text in a bundle that does not parse", () => {
      const result = infer(`fetch(u); new WebSocket(u); ((( unbalanced`)
      expect(result.unparsedBundle).toBe(true)
      expect(result.permissions).toEqual(
        expect.arrayContaining(["network:fetch", "network:websocket"])
      )
      expect(infer(`repo.fetch(u); ((( unbalanced`).permissions).not.toContain("network:fetch")
    })

    it("records the unavailable members a bundle uses, by AST and by text", () => {
      expect(UNAVAILABLE_VSCODE_MEMBERS).toContain("window.createTreeView")
      expect(
        infer(`const vscode = require("vscode"); vscode.window.createTreeView("v", {})`)
          .unsupportedApis
      ).toContain("vscode.window.createTreeView")
      expect(
        infer(`vscode . window . createTreeView("v", {}); ((( unbalanced`).unsupportedApis
      ).toContain("vscode.window.createTreeView")
      expect(
        infer(`const vscode = require("vscode"); vscode.window.showInformationMessage("hi")`)
          .unsupportedApis
      ).toEqual([])
    })

    it("detects vscode.secrets.* → secrets:read+write", () => {
      const result = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          {
            "out/extension.js": `const vscode = require("vscode"); vscode.secrets.get("token")`,
          }
        ),
      })
      expect(result.permissions).toEqual(expect.arrayContaining(["secrets:read", "secrets:write"]))
    })

    it("detects vscode.authentication.* → secrets + network", () => {
      const result = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          {
            "out/extension.js": `import * as vscode from "vscode"; vscode.authentication.getSession("github", [])`,
          }
        ),
      })
      expect(result.permissions).toEqual(
        expect.arrayContaining(["secrets:read", "secrets:write", "network:fetch"])
      )
    })

    it("detects vscode.env.clipboard.* → clipboard:read+write", () => {
      const result = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          {
            "out/extension.js": `const vscode = require("vscode"); vscode.env.clipboard.writeText("hi")`,
          }
        ),
      })
      expect(result.permissions).toEqual(
        expect.arrayContaining(["clipboard:read", "clipboard:write"])
      )
    })

    it("reads files for openTextDocument, and writes them for applyEdit", () => {
      const infer = (code: string) =>
        inferPermissions({
          vsix: makeVsix(
            { ...HEAD, main: "out/extension.js" },
            { "out/extension.js": `const vscode = require("vscode"); ${code}` }
          ),
        })
      const reading = infer(`vscode.workspace.openTextDocument("/a.ts")`)
      expect(reading.permissions).toContain("filesystem:read")
      expect(reading.permissions).not.toContain("filesystem:write")
      expect(reading.reasons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            permission: "filesystem:read",
            trigger: { kind: "vscode-api", api: "vscode.workspace.openTextDocument" },
          }),
        ])
      )
      expect(infer(`vscode.workspace.applyEdit(edit)`).permissions).toEqual(
        expect.arrayContaining(["filesystem:read", "filesystem:write"])
      )
      expect(infer(`vscode.workspace.fs.writeFile(uri, bytes)`).permissions).toContain(
        "filesystem:write"
      )
      expect(infer(`vscode.workspace.createFileSystemWatcher("**/*.ts")`).permissions).toContain(
        "filesystem:read"
      )
      // Reading the folder list touches no file.
      expect(infer(`vscode.workspace.workspaceFolders`).permissions).not.toContain(
        "filesystem:read"
      )
    })

    it("asks to open and type into terminals for createTerminal, by AST and by string scan", () => {
      const parsed = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          {
            "out/extension.js": `const vscode = require("vscode"); vscode.window.createTerminal("x").sendText("ls")`,
          }
        ),
      })
      expect(parsed.permissions).toEqual(
        expect.arrayContaining(["terminal:spawn", "terminal:write"])
      )
      expect(parsed.reasons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            permission: "terminal:spawn",
            trigger: { kind: "vscode-api", api: "vscode.window.createTerminal" },
          }),
        ])
      )
      const scanned = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          { "out/extension.js": `vscode.window.createTerminal({}); ((( unbalanced` }
        ),
      })
      expect(scanned.permissions).toEqual(
        expect.arrayContaining(["terminal:spawn", "terminal:write"])
      )
      // Running a task opens a terminal for it.
      const tasks = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          { "out/extension.js": `const vscode = require("vscode"); vscode.tasks.executeTask(task)` }
        ),
      })
      expect(tasks.permissions).toContain("terminal:spawn")
      expect(tasks.permissions).not.toContain("terminal:write")
      // Other window calls need nothing.
      const window = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          {
            "out/extension.js": `const vscode = require("vscode"); vscode.window.showInformationMessage("hi")`,
          }
        ),
      })
      expect(window.permissions).not.toContain("terminal:spawn")
    })

    it("asks to use the user's language model for lm.selectChatModels, by AST and by string scan", () => {
      const parsed = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          {
            "out/extension.js": `const vscode = require("vscode"); vscode.lm.selectChatModels({ vendor: "cognia" })`,
          }
        ),
      })
      expect(parsed.permissions).toContain("ai:chat")
      expect(parsed.reasons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            permission: "ai:chat",
            trigger: { kind: "vscode-api", api: "vscode.lm.selectChatModels" },
          }),
        ])
      )
      const scanned = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          { "out/extension.js": `vscode.lm.selectChatModels(); ((( unbalanced` }
        ),
      })
      expect(scanned.permissions).toContain("ai:chat")
      // Registering a tool reaches no model.
      const tools = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          {
            "out/extension.js": `const vscode = require("vscode"); vscode.lm.registerTool("t", {})`,
          }
        ),
      })
      expect(tools.permissions).not.toContain("ai:chat")
    })

    it("finds the file APIs by string scan when the bundle does not parse", () => {
      const result = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          { "out/extension.js": `vscode . workspace . applyEdit(edit); ((( unbalanced` }
        ),
      })
      expect(result.permissions).toEqual(
        expect.arrayContaining(["filesystem:read", "filesystem:write"])
      )
    })

    it("dedupes when the same module is referenced multiple times", () => {
      const result = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          {
            "out/extension.js": `const fs = require("fs"); const fs2 = require("fs/promises"); const fs3 = require("graceful-fs")`,
          }
        ),
      })
      const fsReads = result.permissions.filter((p) => p === "filesystem:read")
      expect(fsReads).toHaveLength(1)
    })

    it("orders permissions by the cognia bit declaration order", () => {
      const result = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          {
            "out/extension.js": `const vscode = require("vscode");
               vscode.secrets.get("a");
               const cp = require("child_process");
               const fs = require("fs");`,
          }
        ),
      })
      const fsIdx = result.permissions.indexOf("filesystem:read")
      const procIdx = result.permissions.indexOf("process:spawn")
      const secretsIdx = result.permissions.indexOf("secrets:read")
      expect(fsIdx).toBeLessThan(procIdx)
      expect(procIdx).toBeLessThan(secretsIdx)
    })
  })

  describe("manifest contribution inferences", () => {
    it("authentication[] → secrets + network", () => {
      const result = inferPermissions({
        vsix: makeVsix({
          ...HEAD,
          contributes: {
            authentication: [{ id: "x", label: "X" }],
          },
        }),
      })
      expect(result.permissions).toEqual(
        expect.arrayContaining(["secrets:read", "secrets:write", "network:fetch"])
      )
    })

    it("mcpServerDefinitionProviders → network:fetch", () => {
      const result = inferPermissions({
        vsix: makeVsix({
          ...HEAD,
          contributes: {
            mcpServerDefinitionProviders: [{ id: "x.mcp" }],
          },
        }),
      })
      expect(result.permissions).toContain("network:fetch")
    })

    it("debuggers[] → process:spawn", () => {
      const result = inferPermissions({
        vsix: makeVsix({
          ...HEAD,
          contributes: {
            debuggers: [{ type: "node", label: "Node" }],
          },
        }),
      })
      expect(result.permissions).toContain("process:spawn")
    })

    it("taskDefinitions[] → shell:execute", () => {
      const result = inferPermissions({
        vsix: makeVsix({
          ...HEAD,
          contributes: { taskDefinitions: [{ type: "npm" }] },
        }),
      })
      expect(result.permissions).toContain("shell:execute")
    })

    it("terminal.profiles → shell + spawn", () => {
      const result = inferPermissions({
        vsix: makeVsix({
          ...HEAD,
          contributes: { terminal: { profiles: [{ id: "x" }] } },
        }),
      })
      expect(result.permissions).toEqual(expect.arrayContaining(["shell:execute", "process:spawn"]))
    })

    it("onAuthenticationRequest activation event → secrets read+write", () => {
      const result = inferPermissions({
        vsix: makeVsix({
          ...HEAD,
          activationEvents: ["onAuthenticationRequest"],
        }),
      })
      expect(result.permissions).toEqual(expect.arrayContaining(["secrets:read", "secrets:write"]))
    })
  })

  describe("LSP binary candidates", () => {
    it("flags process:spawn + shell:execute when binaries exist", () => {
      const result = inferPermissions({
        vsix: makeVsix(
          { ...HEAD },
          {},
          {
            lspBinaryCandidates: [
              {
                path: "server/rust-analyzer.exe",
                size: 12345,
                sha256: "a".repeat(64),
                kind: "native-exe",
              },
            ],
          }
        ),
      })
      expect(result.permissions).toEqual(expect.arrayContaining(["process:spawn", "shell:execute"]))
      const reasons = result.reasons.filter((r) => r.trigger.kind === "binary-file")
      expect(reasons.length).toBeGreaterThan(0)
    })
  })

  describe("AST failure fallback", () => {
    it("string-scans require() calls when the bundle is unparseable", () => {
      const result = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          {
            "out/extension.js":
              'this is **not** valid JavaScript +++ but it has require("child_process") inside',
          }
        ),
      })
      expect(result.unparsedBundle).toBe(true)
      expect(result.confidence).toBe("low")
      expect(result.permissions).toContain("process:spawn")
    })

    it("string-scans for vscode.authentication when the AST is gibberish", () => {
      const result = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          {
            "out/extension.js": "!!!@@@ but it mentions vscode.authentication.getSession somewhere",
          }
        ),
      })
      expect(result.permissions).toEqual(
        expect.arrayContaining(["secrets:read", "secrets:write", "network:fetch"])
      )
    })
  })

  describe("reasons log", () => {
    it("records a reason for every detection", () => {
      const result = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          { "out/extension.js": `const fs = require("fs")` }
        ),
      })
      const fsReason = result.reasons.find(
        (r) => r.permission === "filesystem:read" && r.trigger.kind === "require"
      )
      expect(fsReason).toBeDefined()
      expect(fsReason?.evidence).toMatch(/require/)
    })
  })

  describe("confidence grading", () => {
    it("flags low confidence when the parser fails", () => {
      const result = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          { "out/extension.js": "%%% not valid JS %%% require('fs')" }
        ),
      })
      expect(result.confidence).toBe("low")
    })

    it("flags medium confidence for large minified-style bundles", () => {
      // Build a 250 KB bundle with very low identifier diversity (one-letter
      // names repeated). babel parses it, but the bundle/identifiers ratio
      // is < 0.005 so we grade medium.
      const body = "function a(){return 1}function b(){return 2}var c=a,d=b,e=c;e();".repeat(8000)
      const result = inferPermissions({
        vsix: makeVsix({ ...HEAD, main: "out/extension.js" }, { "out/extension.js": body }),
      })
      expect(result.confidence).toBe("medium")
    })

    it("flags high confidence for typical un-minified bundles", () => {
      const result = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          {
            "out/extension.js": `
              const fs = require("fs")
              function activate(context) {
                fs.readFile("/etc/hostname", "utf8", (_e, data) => console.log(data))
              }
              module.exports = { activate, deactivate() {} }
            `,
          }
        ),
      })
      expect(result.confidence).toBe("high")
    })
  })

  describe("hardening", () => {
    it("treats a main pointing to a missing file as theme-only-ish", () => {
      const result = inferPermissions({
        vsix: makeVsix({ ...HEAD, main: "out/does-not-exist.js" }),
      })
      expect(result.permissions).toEqual([])
    })

    it("does not error on import/require with non-string argument", () => {
      const result = inferPermissions({
        vsix: makeVsix(
          { ...HEAD, main: "out/extension.js" },
          {
            "out/extension.js": `const name = "fs"; const fs = require(name); module.exports = {}`,
          }
        ),
      })
      // Dynamic require — we don't infer fs.
      expect(result.permissions).not.toContain("filesystem:read")
    })
  })
})
