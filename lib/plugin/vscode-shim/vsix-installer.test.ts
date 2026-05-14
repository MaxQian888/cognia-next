/**
 * Tests for `installVsix`. Fixtures are synthesised in-memory with JSZip
 * to keep the test suite hermetic — no external `.vsix` downloads.
 */

import JSZip from "jszip"
import { installVsix, MAX_FULL_VSIX_BYTES } from "./vsix-installer"
import type { VsCodeManifest } from "@/types/plugin/plugin-vscode"

interface FixtureBuilder {
  pkgJson: VsCodeManifest
  files?: Record<string, string | Uint8Array>
  /** Skip writing extension/package.json (corruption fixture). */
  omitManifest?: boolean
  /** Write something that isn't valid JSON in place of the manifest. */
  malformedManifest?: boolean
  /** Replace the otherwise-valid zip body with non-zip garbage. */
  emitGarbage?: boolean
}

async function buildVsix(input: FixtureBuilder): Promise<Uint8Array> {
  if (input.emitGarbage) {
    return new TextEncoder().encode("not a zip file at all")
  }
  const zip = new JSZip()
  if (!input.omitManifest) {
    const text = input.malformedManifest ? "{ not json" : JSON.stringify(input.pkgJson)
    zip.file("extension/package.json", text)
  }
  for (const [path, content] of Object.entries(input.files ?? {})) {
    // Pass strings directly to zip.file (canonical JSZip usage) — pre-
    // encoding to Uint8Array breaks loadAsync's lazy reader for some
    // entries. Binary fixtures pass Uint8Array unchanged.
    zip.file(`extension/${path}`, content)
  }
  return zip.generateAsync({ type: "uint8array" })
}

describe("installVsix", () => {
  describe("happy paths", () => {
    it("extracts a minimal hello-world extension", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "hello",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
          main: "./out/extension.js",
        },
        files: {
          "out/extension.js":
            "module.exports = { activate() { console.log('hi') }, deactivate() {} }",
          "README.md": "# Hello",
        },
      })
      const result = await installVsix(vsix)
      expect(result.pkgJson.name).toBe("hello")
      expect(result.pkgJson.publisher).toBe("cognia")
      expect(result.files.has("out/extension.js")).toBe(true)
      expect(result.files.has("README.md")).toBe(true)
      expect(result.files.has("package.json")).toBe(false)
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(result.themes).toEqual([])
      expect(result.bundleFormat).toBe("cjs")
    })

    it("extracts a theme-only extension and parses every theme", async () => {
      const themeJson = JSON.stringify({
        name: "Solarized Dark",
        type: "dark",
        colors: {
          "editor.background": "#002b36",
          "editor.foreground": "#839496",
        },
      })
      const vsix = await buildVsix({
        pkgJson: {
          name: "solarized",
          publisher: "ryanolsonx",
          version: "1.2.0",
          engines: { vscode: ">=1.74.0" },
          contributes: {
            themes: [
              {
                label: "Solarized Dark",
                uiTheme: "vs-dark",
                path: "./themes/solarized-dark.json",
              },
            ],
          },
        },
        files: {
          "themes/solarized-dark.json": themeJson,
        },
      })
      const result = await installVsix(vsix)
      expect(result.themes).toHaveLength(1)
      const theme = result.themes[0]!
      expect(theme.label).toBe("Solarized Dark")
      expect(theme.uiTheme).toBe("vs-dark")
      expect(theme.parsed.theme.isDark).toBe(true)
      expect(result.bundleFormat).toBeNull()
    })

    it("preserves the original VS Code manifest verbatim", async () => {
      const original: VsCodeManifest = {
        name: "verbatim",
        publisher: "cognia",
        version: "0.0.1",
        engines: { vscode: ">=1.74.0" },
        contributes: {
          commands: [{ command: "verbatim.hello", title: "Hello", category: "Verbatim" }],
          configuration: {
            type: "object",
            title: "Verbatim",
            properties: {
              "verbatim.enabled": { type: "boolean", default: true },
            },
          },
        },
        activationEvents: ["onCommand:verbatim.hello"],
      }
      const vsix = await buildVsix({ pkgJson: original })
      const result = await installVsix(vsix)
      expect(result.pkgJson).toEqual(original)
    })

    it("survives an unparseable theme JSON without dropping the install", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "broken-theme",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
          contributes: {
            themes: [
              { label: "Broken", uiTheme: "vs-dark", path: "./themes/broken.json" },
              { label: "OK", uiTheme: "vs-dark", path: "./themes/ok.json" },
            ],
          },
        },
        files: {
          "themes/broken.json": "{ not json",
          "themes/ok.json": JSON.stringify({
            colors: { "editor.background": "#000000" },
          }),
        },
      })
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      try {
        const result = await installVsix(vsix)
        expect(result.themes).toHaveLength(1)
        expect(result.themes[0]!.label).toBe("OK")
      } finally {
        warn.mockRestore()
      }
    })

    it("returns deterministic SHA-256 for identical inputs", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "det",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
        },
      })
      const a = await installVsix(vsix)
      const b = await installVsix(vsix)
      expect(a.sha256).toBe(b.sha256)
    })

    it("normalises forward / backslash separators in file paths", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "paths",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
        },
        files: {
          "src/inner/file.js": "module.exports = 1",
        },
      })
      const result = await installVsix(vsix)
      expect([...result.files.keys()]).toEqual(["src/inner/file.js"])
    })
  })

  describe("bundle format detection", () => {
    it("classifies a .mjs main as ESM", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "esm",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
          main: "./out/extension.mjs",
        },
        files: { "out/extension.mjs": "export function activate() {}" },
      })
      const result = await installVsix(vsix)
      expect(result.bundleFormat).toBe("esm")
    })

    it("classifies type:module + .js main as ESM", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "type-module",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
          main: "./out/extension.js",
          type: "module",
        },
        files: { "out/extension.js": "export const activate = () => {}" },
      })
      const result = await installVsix(vsix)
      expect(result.bundleFormat).toBe("esm")
    })

    it("classifies a bundle using both require() and export as mixed", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "mixed",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
          main: "./out/extension.js",
        },
        files: {
          "out/extension.js":
            "const x = require('fs'); export function activate() {}; module.exports = x",
        },
      })
      const result = await installVsix(vsix)
      expect(result.bundleFormat).toBe("mixed")
    })

    it("resolves a main without extension to the .js sibling", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "no-ext",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
          main: "./out/extension",
        },
        files: {
          "out/extension.js": "module.exports = { activate() {} }",
        },
      })
      const result = await installVsix(vsix)
      expect(result.bundleFormat).toBe("cjs")
    })
  })

  describe("LSP binary detection", () => {
    it("flags .exe binaries", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "lsp",
          publisher: "rust-lang",
          version: "0.4.0",
          engines: { vscode: ">=1.74.0" },
        },
        files: {
          "server/rust-analyzer.exe": new Uint8Array([0x4d, 0x5a, 0, 0, 0, 0]),
        },
      })
      const result = await installVsix(vsix)
      expect(result.lspBinaryCandidates).toHaveLength(1)
      const candidate = result.lspBinaryCandidates[0]!
      expect(candidate.path).toBe("server/rust-analyzer.exe")
      expect(candidate.kind).toBe("native-exe")
      expect(candidate.size).toBe(6)
      expect(candidate.sha256).toMatch(/^[0-9a-f]{64}$/)
    })

    it("flags .node native modules", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "native",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
        },
        files: {
          "build/Release/addon.node": new Uint8Array([0, 0, 0, 0]),
        },
      })
      const result = await installVsix(vsix)
      expect(result.lspBinaryCandidates[0]!.kind).toBe("native-exe")
    })

    it("flags shebang scripts even without a .sh extension", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "shebang",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
        },
        files: {
          "bin/server": "#!/usr/bin/env node\nconsole.log(1)",
        },
      })
      const result = await installVsix(vsix)
      expect(result.lspBinaryCandidates.find((c) => c.path === "bin/server")?.kind).toBe(
        "shell-script"
      )
    })

    it("ignores benign text files", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "benign",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
        },
        files: {
          "README.md": "# hello",
          "CHANGELOG.md": "## v1",
          LICENSE: "MIT",
        },
      })
      const result = await installVsix(vsix)
      expect(result.lspBinaryCandidates).toEqual([])
    })

    it("flags an LSP-style heuristic node script", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "node-lsp",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
        },
        files: {
          "out/server.js":
            "// generated language server\nconst LanguageServer = require('vscode-languageserver/node'); process.argv.forEach(() => {});",
        },
      })
      const result = await installVsix(vsix)
      expect(result.lspBinaryCandidates[0]?.kind).toBe("node-binary")
    })
  })

  describe("error paths", () => {
    it("rejects empty input", async () => {
      await expect(installVsix(new Uint8Array())).rejects.toThrow(/empty/i)
    })

    it("rejects payloads larger than the cap", async () => {
      const big = new Uint8Array(MAX_FULL_VSIX_BYTES + 1)
      await expect(installVsix(big)).rejects.toThrow(/exceeds size cap/i)
    })

    it("rejects non-zip payloads", async () => {
      const vsix = await buildVsix({
        pkgJson: { name: "", publisher: "", version: "", engines: { vscode: "" } },
        emitGarbage: true,
      })
      await expect(installVsix(vsix)).rejects.toThrow(/Could not unzip/i)
    })

    it("rejects archives missing extension/package.json", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "missing",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
        },
        omitManifest: true,
      })
      await expect(installVsix(vsix)).rejects.toThrow(/missing extension\/package\.json/i)
    })

    it("rejects invalid JSON in the manifest", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "broken",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
        },
        malformedManifest: true,
      })
      await expect(installVsix(vsix)).rejects.toThrow(/invalid JSON/i)
    })

    it("rejects a manifest missing the name field", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
        },
      })
      await expect(installVsix(vsix)).rejects.toThrow(/required `name`/)
    })

    it("rejects a manifest missing the publisher field", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "x",
          publisher: "",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
        },
      })
      await expect(installVsix(vsix)).rejects.toThrow(/required `publisher`/)
    })

    it("rejects a manifest that parses to null", async () => {
      // Build directly — buildVsix expects a valid pkgJson object.
      const zip = new JSZip()
      zip.file("extension/package.json", "null")
      const buf = await zip.generateAsync({ type: "uint8array" })
      await expect(installVsix(buf)).rejects.toThrow(/did not yield an object/i)
    })

    it("rejects a manifest that parses to an array", async () => {
      const zip = new JSZip()
      zip.file("extension/package.json", "[]")
      const buf = await zip.generateAsync({ type: "uint8array" })
      // Arrays pass the typeof check but fail the missing-name check.
      await expect(installVsix(buf)).rejects.toThrow(/required `name`/i)
    })
  })

  describe("additional LSP binary classifications", () => {
    it("flags .wasm components", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "wasm-tool",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
        },
        files: { "server/server.wasm": new Uint8Array([0, 0x61, 0x73, 0x6d]) },
      })
      const result = await installVsix(vsix)
      expect(result.lspBinaryCandidates[0]!.kind).toBe("wasm-component")
    })

    it("flags .sh shell scripts by extension", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "shell-tool",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
        },
        files: { "bin/run.sh": "echo hi" },
      })
      const result = await installVsix(vsix)
      expect(result.lspBinaryCandidates[0]!.kind).toBe("shell-script")
    })

    it("flags .dll/.so/.dylib via the native-exe set", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "native-libs",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
        },
        files: {
          "lib/a.dll": new Uint8Array([0x4d, 0x5a]),
          "lib/b.so": new Uint8Array([0x7f, 0x45, 0x4c, 0x46]),
          "lib/c.dylib": new Uint8Array([0xfe, 0xed, 0xfa, 0xce]),
        },
      })
      const result = await installVsix(vsix)
      expect(result.lspBinaryCandidates).toHaveLength(3)
      for (const c of result.lspBinaryCandidates) {
        expect(c.kind).toBe("native-exe")
      }
    })
  })

  describe("additional bundle-format branches", () => {
    it("respects `type: commonjs` when sniffing", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "type-commonjs",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
          main: "./out/extension.js",
          type: "commonjs",
        },
        files: {
          "out/extension.js": "// Ambiguous body, but `type: commonjs` wins\nexport const x = 1",
        },
      })
      const result = await installVsix(vsix)
      expect(result.bundleFormat).toBe("cjs")
    })

    it("returns null bundleFormat when `main` points to a missing file", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "missing-main",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
          main: "./out/missing.js",
        },
        files: {
          "README.md": "no main here",
        },
      })
      const result = await installVsix(vsix)
      expect(result.bundleFormat).toBeNull()
    })

    it("classifies a pure ESM bundle without explicit `type`", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "pure-esm",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
          main: "./out/extension.js",
        },
        files: { "out/extension.js": "import * as fs from 'fs'\nexport function activate() {}" },
      })
      const result = await installVsix(vsix)
      expect(result.bundleFormat).toBe("esm")
    })
  })

  describe("Node crypto fallback", () => {
    it("computes the same SHA-256 when subtle crypto is absent", async () => {
      const vsix = await buildVsix({
        pkgJson: {
          name: "hash",
          publisher: "cognia",
          version: "1.0.0",
          engines: { vscode: ">=1.74.0" },
        },
      })

      // Capture the hash through the subtle-crypto path first.
      const subtleResult = await installVsix(vsix)

      // Then disable subtle and re-run to exercise the node:crypto fallback.
      const originalCrypto = globalThis.crypto
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: { subtle: undefined },
      })
      try {
        const fallbackResult = await installVsix(vsix)
        expect(fallbackResult.sha256).toBe(subtleResult.sha256)
      } finally {
        Object.defineProperty(globalThis, "crypto", {
          configurable: true,
          value: originalCrypto,
        })
      }
    })
  })
})
