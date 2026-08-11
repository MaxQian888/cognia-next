import fs from "node:fs"
import path from "node:path"

describe("platform host packages", () => {
  const sdk = JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")
  ) as { version: string; optionalDependencies: Record<string, string> }

  it.each([
    ["darwin-arm64", "darwin", "arm64", "cognia-agent"],
    ["linux-x64", "linux", "x64", "cognia-agent"],
    ["win32-x64", "win32", "x64", "cognia-agent.exe"],
  ])("keeps %s version-matched and platform-gated", (suffix, os, cpu, executable) => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, `../../agent-host-${suffix}/package.json`),
        "utf8"
      )
    ) as {
      name: string
      version: string
      os: string[]
      cpu: string[]
      bin: Record<string, string>
      scripts?: Record<string, string>
    }
    expect(manifest).toMatchObject({
      name: `@cognia/agent-host-${suffix}`,
      version: sdk.version,
      os: [os],
      cpu: [cpu],
      bin: { "cognia-agent": `bin/${executable}` },
    })
    expect(sdk.optionalDependencies[manifest.name]).toBe(sdk.version)
    expect(manifest.scripts).toEqual({
      prepack: `node ../../scripts/build/verify-agent-host-package.mjs ${suffix}`,
    })
  })
})
