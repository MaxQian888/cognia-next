import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  customModeToConfig,
  discoverCustomAgentModes,
  resolveAgentMode,
  listAgentModes,
  effectivePermissionMode,
  customModeFileSchema,
  CLI_BUILTIN_AGENT_MODES,
  type ModeFs,
} from "./agent-mode"
import { BUILT_IN_AGENT_MODES } from "@/types/agent/agent-mode"

describe("customModeFileSchema", () => {
  it("accepts a minimal mode and rejects unknown keys", () => {
    expect(customModeFileSchema.safeParse({ name: "X" }).success).toBe(true)
    expect(customModeFileSchema.safeParse({ name: "X", bogus: 1 }).success).toBe(false)
    expect(customModeFileSchema.safeParse({}).success).toBe(false) // name required
  })

  it("validates permissionMode against the enum", () => {
    expect(customModeFileSchema.safeParse({ name: "X", permissionMode: "plan" }).success).toBe(true)
    expect(customModeFileSchema.safeParse({ name: "X", permissionMode: "nope" }).success).toBe(
      false
    )
  })
})

describe("customModeToConfig", () => {
  it("maps file fields onto an AgentModeConfig with override props", () => {
    const cfg = customModeToConfig("reviewer", {
      name: "Reviewer",
      description: "reviews code",
      systemPrompt: "Be picky.",
      tools: ["grep", "read"],
      permissionMode: "plan",
      model: "claude-opus-4-8",
      temperature: 0.2,
      maxTokens: 4096,
    })
    expect(cfg).toMatchObject({
      id: "reviewer",
      type: "custom",
      name: "Reviewer",
      description: "reviews code",
      icon: "Bot",
      systemPrompt: "Be picky.",
      tools: ["grep", "read"],
      permissionMode: "plan",
    })
    // Override fields the shared buildAgentModeSessionUpdate reads.
    expect((cfg as unknown as Record<string, unknown>).modelOverride).toBe("claude-opus-4-8")
    expect((cfg as unknown as Record<string, unknown>).temperatureOverride).toBe(0.2)
    expect((cfg as unknown as Record<string, unknown>).maxTokensOverride).toBe(4096)
  })

  it("omits absent optional fields", () => {
    const cfg = customModeToConfig("bare", { name: "Bare" })
    expect(cfg.systemPrompt).toBeUndefined()
    expect(cfg.tools).toBeUndefined()
    expect((cfg as unknown as Record<string, unknown>).modelOverride).toBeUndefined()
  })
})

/** In-memory ModeFs over a flat `{ "dir/file": contents }` map. */
function memFs(files: Record<string, string>): ModeFs {
  return {
    async exists(p) {
      const norm = p.replace(/\\/g, "/")
      return Object.keys(files).some((k) => k.replace(/\\/g, "/").startsWith(norm + "/"))
    },
    async readDir(p) {
      const norm = p.replace(/\\/g, "/")
      return Object.keys(files)
        .map((k) => k.replace(/\\/g, "/"))
        .filter((k) => k.startsWith(norm + "/"))
        .map((k) => k.slice(norm.length + 1))
        .filter((rest) => !rest.includes("/"))
    },
    async readText(p) {
      const norm = p.replace(/\\/g, "/")
      const hit = Object.entries(files).find(([k]) => k.replace(/\\/g, "/") === norm)
      if (!hit) throw new Error("ENOENT")
      return hit[1]
    },
  }
}

describe("discoverCustomAgentModes", () => {
  it("parses *.json modes, deriving id from the filename stem", async () => {
    const fs = memFs({
      "/proj/.cognia/modes/reviewer.json": JSON.stringify({ name: "Reviewer", tools: ["grep"] }),
      "/proj/.cognia/modes/notes.txt": "ignored",
    })
    const modes = await discoverCustomAgentModes(["/proj"], fs)
    expect(modes.map((m) => m.id)).toEqual(["reviewer"])
    expect(modes[0].tools).toEqual(["grep"])
  })

  it("first root wins on an id collision (project over global)", async () => {
    const fs = memFs({
      "/proj/.cognia/modes/dup.json": JSON.stringify({ name: "Project" }),
      "/home/.cognia/modes/dup.json": JSON.stringify({ name: "Global" }),
    })
    const modes = await discoverCustomAgentModes(["/proj", "/home"], fs)
    expect(modes).toHaveLength(1)
    expect(modes[0].name).toBe("Project")
  })

  it("skips malformed JSON and schema-invalid files without throwing", async () => {
    const fs = memFs({
      "/proj/.cognia/modes/broken.json": "{ not json",
      "/proj/.cognia/modes/invalid.json": JSON.stringify({ noName: true }),
      "/proj/.cognia/modes/ok.json": JSON.stringify({ name: "OK" }),
    })
    const modes = await discoverCustomAgentModes(["/proj"], fs)
    expect(modes.map((m) => m.id)).toEqual(["ok"])
  })

  it("returns [] when no modes dir exists", async () => {
    expect(await discoverCustomAgentModes(["/empty"], memFs({}))).toEqual([])
  })

  it("works against the real filesystem", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "modes-"))
    try {
      mkdirSync(path.join(dir, ".cognia", "modes"), { recursive: true })
      writeFileSync(
        path.join(dir, ".cognia", "modes", "writer.json"),
        JSON.stringify({ name: "Writer", systemPrompt: "Write well." })
      )
      const modes = await discoverCustomAgentModes([dir])
      expect(modes.map((m) => m.id)).toEqual(["writer"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("resolveAgentMode", () => {
  const custom = [customModeToConfig("reviewer", { name: "Reviewer" })]

  it("resolves a built-in id", () => {
    expect(resolveAgentMode("plan", custom)?.type).toBe("plan")
  })

  it("resolves a custom id", () => {
    expect(resolveAgentMode("reviewer", custom)?.id).toBe("reviewer")
  })

  it("built-ins win over a custom file that shadows their id", () => {
    const shadow = [customModeToConfig("plan", { name: "Fake Plan" })]
    expect(resolveAgentMode("plan", shadow)?.name).toBe("Plan (read-only)")
  })

  it("returns undefined for an unknown or empty id", () => {
    expect(resolveAgentMode("nope", custom)).toBeUndefined()
    expect(resolveAgentMode(undefined, custom)).toBeUndefined()
    expect(resolveAgentMode(null, custom)).toBeUndefined()
  })
})

describe("CLI_BUILTIN_AGENT_MODES", () => {
  it("stays in sync with the GUI built-in mode catalog", () => {
    expect(CLI_BUILTIN_AGENT_MODES).toBe(BUILT_IN_AGENT_MODES)
    expect(CLI_BUILTIN_AGENT_MODES.map((m) => m.id)).toEqual(BUILT_IN_AGENT_MODES.map((m) => m.id))
  })
})

describe("listAgentModes", () => {
  it("lists CLI built-ins first, then custom modes", () => {
    const custom = [customModeToConfig("reviewer", { name: "Reviewer" })]
    const all = listAgentModes(custom)
    expect(all).toHaveLength(CLI_BUILTIN_AGENT_MODES.length + 1)
    expect(all[0].id).toBe(CLI_BUILTIN_AGENT_MODES[0].id)
    expect(all[all.length - 1].id).toBe("reviewer")
  })
})

describe("effectivePermissionMode", () => {
  const planMode = resolveAgentMode("plan", [])
  it("an explicit non-default permission mode always wins", () => {
    expect(effectivePermissionMode("acceptEdits", planMode)).toBe("acceptEdits")
  })
  it("a mode's permission applies when the config is the baseline default", () => {
    expect(effectivePermissionMode("default", planMode)).toBe("plan")
  })
  it("falls back to default when neither overrides", () => {
    expect(effectivePermissionMode("default", undefined)).toBe("default")
    const build = resolveAgentMode("general", [])
    expect(effectivePermissionMode("default", build)).toBe("default") // general has none
  })
})
