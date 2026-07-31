import { ALL_SPECS, getSpec } from "./index"
import type { CliOption, CliSubcommand } from "./types"

describe("spec registry", () => {
  it("resolves by head word, case-insensitively, with Windows suffixes", () => {
    expect(getSpec("git")?.name).toBe("git")
    expect(getSpec("Git")?.name).toBe("git")
    expect(getSpec("git.exe")?.name).toBe("git")
    expect(getSpec("kubectl")?.name).toBe("kubectl")
    expect(getSpec("no-such-cli")).toBeNull()
  })

  it("covers the planned CLI set", () => {
    const names = ALL_SPECS.map((s) => s.name)
    for (const expected of [
      "git",
      "npm",
      "pnpm",
      "yarn",
      "cargo",
      "node",
      "deno",
      "bun",
      "go",
      "docker",
      "kubectl",
      "terraform",
      "gh",
      "pip",
      "make",
      "brew",
    ]) {
      expect(names).toContain(expected)
    }
    expect(new Set(names).size).toBe(names.length)
  })
})

describe("spec schema validation (every registered spec)", () => {
  function checkOption(opt: CliOption, path: string) {
    expect(typeof opt.name).toBe("string")
    expect(opt.name.startsWith("-")).toBe(true)
    for (const alias of opt.aliases ?? []) {
      expect(alias.startsWith("-")).toBe(true)
    }
    if (opt.description !== undefined) {
      expect(opt.description.length).toBeGreaterThan(0)
    }
    void path
  }

  function checkSubcommand(sub: CliSubcommand, path: string, depth: number) {
    expect(sub.name.length).toBeGreaterThan(0)
    expect(sub.name.startsWith("-")).toBe(false)
    expect(depth).toBeLessThanOrEqual(4)
    const siblingsSeen = new Set<string>()
    for (const opt of sub.options ?? []) checkOption(opt, `${path}.${sub.name}`)
    for (const child of sub.subcommands ?? []) {
      expect(siblingsSeen.has(child.name)).toBe(false)
      siblingsSeen.add(child.name)
      checkSubcommand(child, `${path}.${sub.name}`, depth + 1)
    }
  }

  it.each(ALL_SPECS.map((s) => [s.name, s] as const))("%s spec is well-formed", (_name, spec) => {
    expect(spec.name.length).toBeGreaterThan(0)
    const seen = new Set<string>()
    for (const opt of spec.options ?? []) checkOption(opt, spec.name)
    for (const sub of spec.subcommands ?? []) {
      expect(seen.has(sub.name)).toBe(false)
      seen.add(sub.name)
      checkSubcommand(sub, spec.name, 1)
    }
  })
})
