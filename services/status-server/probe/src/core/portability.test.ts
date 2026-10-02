import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { build } from "esbuild"
import { describe, expect, it } from "vitest"

const coreDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * The core is bundled into the Cloudflare status Worker as well as the Node
 * runner. Prove it builds for a runtime with no Node built-ins at all
 * (`platform: "neutral"` fails on any `node:` import) and that its source
 * reaches for nothing Node- or DOM-specific.
 */
describe("portable core", () => {
  it("bundles for a neutral (Worker-like) platform without Node built-ins", async () => {
    const result = await build({
      entryPoints: [path.join(coreDir, "index.ts")],
      bundle: true,
      platform: "neutral",
      format: "esm",
      target: "es2022",
      write: false,
      logLevel: "silent",
    })
    expect(result.errors).toEqual([])
    const output = result.outputFiles[0]?.text ?? ""
    expect(output).not.toMatch(/from\s*["']node:/)
    expect(output).not.toMatch(/\brequire\(/)
    // The shared contract, validator, health parser and room helpers are inside.
    expect(output).toContain("cognia-status-probe")
    expect(output).toContain("relayDataLane")
    expect(output).toContain("deriveRoomId")
  })

  it("uses no Node-only or DOM-only globals in source", async () => {
    const files = (await readdir(coreDir)).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")
    )
    expect(files.length).toBeGreaterThan(4)
    for (const name of files) {
      const source = await readFile(path.join(coreDir, name), "utf8")
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
      expect(code, name).not.toMatch(/\bBuffer\b/)
      expect(code, name).not.toMatch(/\bprocess\./)
      expect(code, name).not.toMatch(/from\s+["']node:/)
      expect(code, name).not.toMatch(/\b(document|window|localStorage)\./)
    }
  })
})
