/**
 * The `lsp-server` capability's ONLY first-party proof.
 *
 * This plugin had no test at all, and its `lspServers[0].command` pointed at
 * `tests/fixtures/echo-lsp.mjs` — a path that did not exist. `resolveBinaryPath`
 * anchors a relative command against the plugin install directory, and
 * `registerPluginLspServers` swallows a per-entry spawn failure with a `warn`,
 * so the fixture could never start and nothing said so. These tests pin both
 * the manifest contract and the fixture's actual LSP behavior.
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

import manifestJson from "../plugin.json"
import { activate, deactivate } from "./index"

const PLUGIN_ROOT = join(__dirname, "..")
const manifest = manifestJson as unknown as {
  id: string
  capabilities: string[]
  lspServers: Array<{
    id: string
    command: string
    args: string[]
    transport: string
    languages: string[]
  }>
}

describe("manifest", () => {
  it("declares the lsp-server capability with one server", () => {
    expect(manifest.capabilities).toContain("lsp-server")
    expect(manifest.lspServers).toHaveLength(1)
    expect(manifest.lspServers[0].transport).toBe("stdio")
  })

  it("names a command that EXISTS inside the plugin directory", () => {
    const command = manifest.lspServers[0].command
    // Must stay plugin-root-relative (the SDK path rule) AND resolve.
    expect(command.startsWith("/")).toBe(false)
    expect(command.includes("..")).toBe(false)
    expect(existsSync(join(PLUGIN_ROOT, command))).toBe(true)
  })
})

describe("lifecycle", () => {
  it("activate logs through the context and deactivate is a no-op", () => {
    const info = jest.fn()
    activate({ logger: { info } } as never)
    expect(info).toHaveBeenCalled()
    expect(() => deactivate()).not.toThrow()
  })
})

describe("echo-lsp fixture", () => {
  /** Drive the fixture over real LSP stdio framing. */
  function talk(messages: object[], timeoutMs = 4000): Promise<Array<Record<string, unknown>>> {
    return new Promise((resolve, reject) => {
      const child = spawn("node", [join(PLUGIN_ROOT, manifest.lspServers[0].command)], {
        stdio: ["pipe", "pipe", "ignore"],
      })
      const received: Array<Record<string, unknown>> = []
      let buffer = Buffer.alloc(0)

      child.stdout.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
          const headerEnd = buffer.indexOf("\r\n\r\n")
          if (headerEnd === -1) return
          const header = buffer.subarray(0, headerEnd).toString("ascii")
          const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? 0)
          if (buffer.length < headerEnd + 4 + length) return
          const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8")
          buffer = buffer.subarray(headerEnd + 4 + length)
          received.push(JSON.parse(body) as Record<string, unknown>)
        }
      })
      child.on("error", reject)

      for (const message of messages) {
        const body = Buffer.from(JSON.stringify(message), "utf8")
        child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
        child.stdin.write(body)
      }

      setTimeout(() => {
        child.kill()
        resolve(received)
      }, timeoutMs / 8)
    })
  }

  it("answers initialize with stdio capabilities", async () => {
    const out = await talk([{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }])
    const init = out.find((m) => m.id === 1) as
      { result: { capabilities: Record<string, unknown> } } | undefined
    expect(init?.result.capabilities.hoverProvider).toBe(true)
    expect(init?.result.capabilities.textDocumentSync).toBe(1)
  })

  it("pushes a diagnostic on didOpen and answers hover", async () => {
    const out = await talk([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: { textDocument: { uri: "file:///a.txt" } },
      },
      { jsonrpc: "2.0", id: 2, method: "textDocument/hover", params: {} },
    ])
    const diagnostics = out.find((m) => m.method === "textDocument/publishDiagnostics") as
      { params: { uri: string; diagnostics: unknown[] } } | undefined
    expect(diagnostics?.params.uri).toBe("file:///a.txt")
    expect(diagnostics?.params.diagnostics).toHaveLength(1)
    expect(out.find((m) => m.id === 2)).toBeDefined()
  })

  it("runs with no third-party imports (an installed plugin has no node_modules)", async () => {
    const { readFileSync } = await import("node:fs")
    const source = readFileSync(join(PLUGIN_ROOT, manifest.lspServers[0].command), "utf8")
    // The sidecar's equivalent fixture imports `vscode-jsonrpc/node`, which is
    // exactly what an installed plugin cannot resolve.
    expect(source).not.toMatch(/from\s+["']vscode-jsonrpc/)
    expect(source).not.toMatch(/^import .* from ["'][^.]/m)
  })
})
