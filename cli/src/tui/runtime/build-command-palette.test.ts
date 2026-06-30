/**
 * @jest-environment node
 */
import { buildCommandPalette } from "./build-command-palette"
import { __resetForTesting } from "../commands/registry"
import type { ResolvedConfig } from "../config/schema"

function config(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    provider: "anthropic",
    providers: {},
    permissionMode: "default",
    cwd: "/repo",
    ...over,
  } as ResolvedConfig
}

beforeEach(() => __resetForTesting())

describe("buildCommandPalette", () => {
  it("leads with the curated quick actions carrying live hints", () => {
    const rows = buildCommandPalette(config({ permissionMode: "plan" }))
    expect(rows[0]?.id).toBe("mode")
    expect(rows.find((r) => r.id === "mode")?.hint).toBe("plan")
  })

  it("appends visible registry commands not already curated", () => {
    const rows = buildCommandPalette(config())
    // `/sessions` is a core command with no curated row → it is appended.
    expect(rows.some((r) => r.command === "/sessions")).toBe(true)
  })

  it("does not duplicate a command already fronted by a curated row", () => {
    const rows = buildCommandPalette(config())
    expect(rows.filter((r) => r.command === "/model")).toHaveLength(1)
  })

  it("gives every row an id, label and slash command", () => {
    for (const r of buildCommandPalette(config())) {
      expect(r.id).toBeTruthy()
      expect(r.label).toBeTruthy()
      expect(r.command.startsWith("/")).toBe(true)
    }
  })
})
