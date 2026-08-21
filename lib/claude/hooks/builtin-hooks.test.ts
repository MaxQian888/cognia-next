/** @jest-environment node */
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  BUILTIN_HOOKS,
  isBuiltinHookEnabled,
  buildBuiltinHookGroups,
  mergeBuiltinUnder,
  type BuiltinHookDef,
} from "./builtin-hooks"
import type { HooksConfig } from "@/lib/claude/hooks"

const SCRIPTS_DIR = path.join(process.cwd(), "hooks", "builtin")

describe("BUILTIN_HOOKS catalog", () => {
  it("has unique ids", () => {
    const ids = BUILTIN_HOOKS.map((h) => h.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("references only scripts that exist on disk", () => {
    for (const def of BUILTIN_HOOKS) {
      // Spawning each below also proves existence; here assert the path shape.
      expect(def.script).toMatch(/\.mjs$/)
    }
  })

  it("guards default to OFF; context loaders default ON", () => {
    const byId = Object.fromEntries(BUILTIN_HOOKS.map((h) => [h.id, h]))
    expect(byId["auto-context-loader"].defaultEnabled).toBe(true)
    expect(byId["cost-quota-guard"].defaultEnabled).toBe(false)
    expect(byId["pii-safety-guard"].defaultEnabled).toBe(false)
  })
})

describe("isBuiltinHookEnabled", () => {
  const def: BuiltinHookDef = {
    id: "x",
    event: "UserPromptSubmit",
    script: "x.mjs",
    description: "",
    defaultEnabled: false,
  }
  it("falls back to defaultEnabled", () => {
    expect(isBuiltinHookEnabled(def, {})).toBe(false)
    expect(isBuiltinHookEnabled({ ...def, defaultEnabled: true }, {})).toBe(true)
  })
  it("honors an explicit override", () => {
    expect(isBuiltinHookEnabled(def, { x: true })).toBe(true)
    expect(isBuiltinHookEnabled({ ...def, defaultEnabled: true }, { x: false })).toBe(false)
  })
})

describe("buildBuiltinHookGroups", () => {
  it("emits node command groups for enabled hooks only", () => {
    const cfg = buildBuiltinHookGroups({
      baseDir: "/base",
      overrides: { "cost-quota-guard": true },
    })
    // default-on context loaders + opted-in cost guard
    expect(cfg.SessionStart).toHaveLength(1)
    expect(cfg.UserPromptSubmit?.length).toBe(2) // auto-context-loader-prompt + cost-quota-guard
    const cmd = cfg.SessionStart![0].hooks[0]
    expect(cmd.type).toBe("command")
    if (cmd.type === "command") {
      expect(cmd.command).toContain("auto-context-loader.mjs")
      expect(cmd.command.startsWith("node ")).toBe(true)
    }
  })

  it("omits a hook disabled via override", () => {
    const cfg = buildBuiltinHookGroups({
      baseDir: "/b",
      overrides: { "auto-context-loader": false },
    })
    expect(cfg.SessionStart).toBeUndefined()
  })

  it("carries the matcher for tool-scoped hooks", () => {
    const cfg = buildBuiltinHookGroups({
      baseDir: "/b",
      overrides: { "pii-safety-guard-tool": true },
    })
    expect(cfg.PreToolUse?.[0]).toBeDefined()
  })
})

describe("mergeBuiltinUnder", () => {
  it("appends builtin groups after user groups per event", () => {
    const base: HooksConfig = {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "user" }] }],
    }
    const builtin: HooksConfig = {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "builtin" }] }],
    }
    const merged = mergeBuiltinUnder(base, builtin)
    const cmds = merged.UserPromptSubmit!.map((g) =>
      g.hooks[0].type === "command" ? g.hooks[0].command : ""
    )
    expect(cmds).toEqual(["user", "builtin"])
  })

  it("keeps events that exist only in one side", () => {
    const merged = mergeBuiltinUnder(
      { Stop: [{ hooks: [{ type: "command", command: "s" }] }] },
      { SessionStart: [{ hooks: [{ type: "command", command: "b" }] }] }
    )
    expect(merged.Stop).toHaveLength(1)
    expect(merged.SessionStart).toHaveLength(1)
  })
})

// ── End-to-end smoke: spawn each bundled script with a payload on stdin ──

function runScript(script: string, payload: object, env: Record<string, string | undefined> = {}) {
  try {
    const stdout = execFileSync(process.execPath, [path.join(SCRIPTS_DIR, script)], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, ...env },
    })
    return { code: 0, stdout }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" }
  }
}

describe("auto-context-loader.mjs", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ctx-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("emits additionalContext when .cognia/agent-context.md exists", () => {
    mkdirSync(path.join(dir, ".cognia"))
    writeFileSync(path.join(dir, ".cognia", "agent-context.md"), "Ship fast.")
    const res = runScript("auto-context-loader.mjs", {
      hook_event_name: "SessionStart",
      cwd: dir,
    })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain("Ship fast.")
    expect(res.stdout).toContain("additionalContext")
  })

  it("exits 0 with no output when the context file is absent", () => {
    const res = runScript("auto-context-loader.mjs", { hook_event_name: "SessionStart", cwd: dir })
    expect(res.code).toBe(0)
    expect(res.stdout.trim()).toBe("")
  })
})

describe("cost-quota-guard.mjs", () => {
  it("soft-allows (exit 0) when no budget is configured", () => {
    const res = runScript("cost-quota-guard.mjs", { tokensUsed: 999999, cwd: os.tmpdir() })
    expect(res.code).toBe(0)
  })

  it("blocks (exit 2) when tokensUsed exceeds COGNIA_TOKEN_BUDGET", () => {
    const res = runScript(
      "cost-quota-guard.mjs",
      { tokensUsed: 5000, cwd: os.tmpdir() },
      { COGNIA_TOKEN_BUDGET: "1000" }
    )
    expect(res.code).toBe(2)
    expect(res.stderr).toContain("budget")
  })

  it("allows (exit 0) when under budget", () => {
    const res = runScript(
      "cost-quota-guard.mjs",
      { tokensUsed: 10, cwd: os.tmpdir() },
      { COGNIA_TOKEN_BUDGET: "1000" }
    )
    expect(res.code).toBe(0)
  })
})

describe("pii-safety-guard.mjs", () => {
  it("blocks a prompt containing an AWS key", () => {
    const res = runScript("pii-safety-guard.mjs", {
      prompt: "use AKIAIOSFODNN7EXAMPLE to deploy",
    })
    expect(res.code).toBe(2)
    expect(res.stderr).toContain("AWS access key")
  })

  it("blocks a Luhn-valid credit card number", () => {
    const res = runScript("pii-safety-guard.mjs", { prompt: "card 4242 4242 4242 4242 please" })
    expect(res.code).toBe(2)
    expect(res.stderr).toContain("credit card")
  })

  it("allows a clean prompt (and a Luhn-invalid digit run)", () => {
    const res = runScript("pii-safety-guard.mjs", {
      prompt: "refactor the parser, order id 1234567890123",
    })
    expect(res.code).toBe(0)
  })

  it("scans tool_input on PreToolUse", () => {
    const res = runScript("pii-safety-guard.mjs", {
      hook_event_name: "PreToolUse",
      tool_input: { body: "ssn 123-45-6789" },
    })
    expect(res.code).toBe(2)
    expect(res.stderr).toContain("SSN")
  })
})

describe("TS ↔ Rust lockstep", () => {
  it("matches the shared registry table", () => {
    // The registry is declared twice (here and `src-tauri/src/hooks/builtin.rs`)
    // and was hand-maintained with nothing enforcing agreement. Because
    // `builtinHookOverrides` is keyed by id, a drifted id also orphans the
    // user's enable/disable choice on one shell. Both sides assert this table.
    const table = JSON.parse(
      readFileSync(path.join(SCRIPTS_DIR, "..", "builtin-hooks.lockstep.json"), "utf8")
    ) as {
      hooks: {
        id: string
        event: string
        matcher: string | null
        script: string
        defaultEnabled: boolean
      }[]
    }

    expect(
      BUILTIN_HOOKS.map((h) => ({
        id: h.id,
        event: h.event,
        matcher: h.matcher ?? null,
        script: h.script,
        defaultEnabled: h.defaultEnabled,
      }))
    ).toEqual(table.hooks)
  })

  it("keeps every entry pointed at a script that ships", () => {
    for (const hook of BUILTIN_HOOKS) {
      expect(existsSync(path.join(SCRIPTS_DIR, hook.script))).toBe(true)
    }
  })
})
