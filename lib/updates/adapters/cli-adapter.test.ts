/** @jest-environment jsdom */
import {
  CLI_ASSET_ID,
  cliUpgradeCommand,
  cliUpgradeCommandChoices,
  createCliAdapter,
} from "./cli-adapter"
import type { CatalogEntry } from "../catalog-types"

const CONTEXT = {
  channel: "stable" as const,
  rolloutBucket: 0,
  manual: true,
  catalog: [
    {
      assetId: CLI_ASSET_ID,
      kind: "cli" as const,
      executor: "package-manager" as const,
      version: "0.5.0",
      channel: "stable" as const,
      criticality: "routine" as const,
      releasedAt: "2026-01-01T00:00:00Z",
    },
  ] as readonly CatalogEntry[],
}

describe("cliUpgradeCommand", () => {
  it("uses each package manager's own global syntax", () => {
    expect(cliUpgradeCommand("npm", "1.0.0")).toBe(`npm install -g ${CLI_ASSET_ID}@1.0.0`)
    expect(cliUpgradeCommand("pnpm", "1.0.0")).toBe(`pnpm add -g ${CLI_ASSET_ID}@1.0.0`)
    expect(cliUpgradeCommand("yarn", "1.0.0")).toBe(`yarn global add ${CLI_ASSET_ID}@1.0.0`)
    expect(cliUpgradeCommand("bun", "1.0.0")).toBe(`bun add -g ${CLI_ASSET_ID}@1.0.0`)
  })

  it("never requests elevation", () => {
    for (const command of cliUpgradeCommandChoices("1.0.0")) {
      expect(command).not.toContain("sudo")
    }
  })

  it("offers every candidate when the source is unknown", () => {
    expect(cliUpgradeCommandChoices("1.0.0")).toHaveLength(4)
  })
})

describe("createCliAdapter", () => {
  it("reports nothing when the CLI is not installed", async () => {
    const adapter = createCliAdapter({ installedVersion: async () => null })
    expect(await adapter.check(CONTEXT)).toEqual([])
  })

  it("offers a newer published version", async () => {
    const adapter = createCliAdapter({ installedVersion: async () => "0.4.0" })
    const [candidate] = await adapter.check(CONTEXT)
    expect(candidate).toMatchObject({
      targetVersion: "0.5.0",
      executor: "package-manager",
      currentVersion: "0.4.0",
    })
  })

  it("stays quiet when the installed version is already current", async () => {
    const adapter = createCliAdapter({ installedVersion: async () => "0.5.0" })
    expect(await adapter.check(CONTEXT)).toEqual([])
  })

  it("hands back a command instead of running a global install", async () => {
    const adapter = createCliAdapter({
      installedVersion: async () => "0.4.0",
      packageManager: async () => "pnpm",
    })
    const [candidate] = await adapter.check(CONTEXT)
    const result = await adapter.apply(candidate, { consented: true })
    expect(result.state).toBe("awaiting-store")
    expect(result.command).toBe(`pnpm add -g ${CLI_ASSET_ID}@0.5.0`)
  })

  it("falls back to npm syntax when the owner is unknown", async () => {
    const adapter = createCliAdapter({
      installedVersion: async () => "0.4.0",
      packageManager: async () => "unknown",
    })
    const [candidate] = await adapter.check(CONTEXT)
    expect((await adapter.apply(candidate, { consented: true })).command).toContain(
      "npm install -g"
    )
  })
})
