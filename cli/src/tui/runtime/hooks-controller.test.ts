import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { BUILTIN_HOOKS } from "@/lib/claude/hooks/builtin-hooks"
import { buildHooksDocument, hooksList, readHooksPanel } from "./hooks-controller"
import type { HooksConfig } from "../../hooks/types"
import type { ResolvedConfig } from "../../config/schema"
import type { TuiAction } from "../state/types"

const HOME = "/home/.cognia"
const COGNIA = `${HOME}/config.json`
const CLAUDE = "/home/.claude/settings.json"
function config(patch: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    provider: "anthropic",
    providers: {},
    cwd: "/work",
    permissionMode: "default",
    builtinTools: {},
    ...patch,
  } as ResolvedConfig
}
function harness(files: Record<string, string> = {}, patch: Partial<ResolvedConfig> = {}) {
  const actions: TuiAction[] = []
  return {
    actions,
    deps: {
      home: HOME,
      osHome: "/home",
      config: config(patch),
      readFile: (file: string) => files[file] ?? null,
      dispatch: (action: TuiAction) => {
        actions.push(action)
      },
    },
  }
}
const command = (name: string): HooksConfig => ({
  Stop: [{ hooks: [{ type: "command", command: name }] }],
})

describe("buildHooksDocument", () => {
  it("renders a localized empty configuration guide", () => {
    expect(buildHooksDocument({})).toContain("No user hooks configured")
    expect(buildHooksDocument({}, "zh-CN")).toContain("Hook")
    expect(buildHooksDocument({}, "zh-CN")).not.toContain("No user")
  })

  it("preserves event, matcher, agent selector, handler type and options", () => {
    const hooks: HooksConfig = {
      PreToolUse: [
        {
          matcher: "Edit|Write",
          agents: "codex|claude",
          hooks: [{ type: "command", command: "./guard.sh", timeout: 5 }],
        },
      ],
      Stop: [{ hooks: [{ type: "prompt", prompt: "check completion" }] }],
    }
    const body = buildHooksDocument(hooks)
    expect(body).toContain("## PreToolUse")
    expect(body).toContain("Matcher: Edit|Write")
    expect(body).toContain("Agent selector: codex|claude")
    expect(body).toContain('"command": "./guard.sh"')
    expect(body).toContain('"timeout": 5')
    expect(body).toContain('"type": "prompt"')
    expect(body).toContain("Matcher: *")
    expect(body).not.toContain("inert")
  })

  it("omits authentication headers without mutating source handlers", () => {
    const handler = {
      type: "http" as const,
      url: "https://example.test/hook",
      headers: { Authorization: "Bearer secret-token", "X-API-Key": "secret-key" },
      timeout: 10,
    }
    const hooks: HooksConfig = { Notification: [{ hooks: [handler] }] }
    const body = buildHooksDocument(hooks)
    expect(body).toContain("https://example.test/hook")
    expect(body).not.toContain("headers")
    expect(body).not.toContain("secret-token")
    expect(body).not.toContain("secret-key")
    expect(handler.headers.Authorization).toBe("Bearer secret-token")
  })
})

describe("readHooksPanel", () => {
  it("keeps matching Cognia and Claude groups distinct and includes all builtins", () => {
    const { deps } = harness({
      [COGNIA]: JSON.stringify({ hooks: command("cognia.sh") }),
      [CLAUDE]: JSON.stringify({ hooks: command("claude.sh") }),
    })
    const panel = readHooksPanel(deps)
    const cognia = panel.rows.find((row) => row.source === "cognia")!
    const claude = panel.rows.find((row) => row.source === "claude")!
    expect(cognia).toMatchObject({ id: "cognia:Stop:0", sourcePath: COGNIA, event: "Stop" })
    expect(claude).toMatchObject({ id: "claude:Stop:0", sourcePath: CLAUDE, event: "Stop" })
    expect(cognia.detail).toContain("cognia.sh")
    expect(cognia.detail).not.toContain("claude.sh")
    expect(claude.detail).toContain("claude.sh")
    expect(panel.rows.filter((row) => row.source === "builtin")).toHaveLength(BUILTIN_HOOKS.length)
    expect(new Set(panel.rows.map((row) => row.id)).size).toBe(panel.rows.length)
    expect(panel.diagnostics.join(" ")).toContain("not execution history")
  })

  it("filters inherited fleet groups with the execution loader while preserving user groups", () => {
    const fleet = {
      hooks: [{ type: "command", command: "/home/.cognia/agent-monitor/claude-hook.sh Stop fire" }],
    }
    const hooks = { Stop: [fleet, ...command("regular.sh").Stop!] }
    const { deps } = harness({
      [CLAUDE]: JSON.stringify({ hooks }),
      [COGNIA]: JSON.stringify({ hooks: { Stop: [fleet] } }),
    })
    const panel = readHooksPanel(deps)
    expect(panel.rows.filter((row) => row.source === "claude")).toHaveLength(1)
    expect(panel.rows.find((row) => row.source === "claude")?.detail).toContain("regular.sh")
    expect(panel.rows.find((row) => row.source === "claude")?.detail).not.toContain("agent-monitor")
    expect(panel.rows.find((row) => row.source === "cognia")?.detail).toContain("agent-monitor")
  })

  it("shows builtin defaults and explicit enabled/disabled overrides", () => {
    const enabled = BUILTIN_HOOKS.find((hook) => hook.defaultEnabled)!
    const disabled = BUILTIN_HOOKS.find((hook) => !hook.defaultEnabled)!
    expect(enabled).toBeDefined()
    expect(disabled).toBeDefined()
    const defaults = readHooksPanel(harness().deps)
    expect(defaults.rows.find((row) => row.builtinId === enabled.id)?.enabled).toBe(true)
    expect(defaults.rows.find((row) => row.builtinId === disabled.id)?.enabled).toBe(false)
    const { deps } = harness(
      {},
      { builtinHookOverrides: { [enabled.id]: false, [disabled.id]: true } }
    )
    const panel = readHooksPanel(deps)
    expect(panel.rows.find((row) => row.builtinId === enabled.id)?.enabled).toBe(false)
    expect(panel.rows.find((row) => row.builtinId === disabled.id)?.enabled).toBe(true)
  })

  it.each(["{broken", "null", "[]", '{"hooks":{"Stop":"not-an-array"}}'])(
    "diagnoses invalid source %s while retaining the healthy source",
    (invalid) => {
      const { deps } = harness({
        [COGNIA]: invalid,
        [CLAUDE]: JSON.stringify({ hooks: command("healthy.sh") }),
      })
      const panel = readHooksPanel(deps)
      expect(panel.diagnostics.some((message) => message.includes(COGNIA))).toBe(true)
      expect(panel.rows.some((row) => row.source === "cognia")).toBe(false)
      expect(panel.rows.find((row) => row.source === "claude")?.detail).toContain("healthy.sh")
    }
  )

  it("reports unreadable sources and ignores missing hooks blocks", () => {
    const { deps } = harness({ [CLAUDE]: '{"theme":"dark"}' })
    const reader = deps.readFile
    const panel = readHooksPanel({
      ...deps,
      readFile: (file) => {
        if (file === COGNIA) throw new Error("EACCES")
        return reader(file)
      },
    })
    expect(panel.diagnostics.join(" ")).toContain("EACCES")
    expect(panel.rows.every((row) => row.source === "builtin")).toBe(true)
  })

  it.each(["pi-rpc", "acp", "codex"])(
    "does not claim native hook execution for external %s",
    (agentBackend) => {
      const panel = readHooksPanel(harness({}, { agentBackend }).deps)
      expect(panel.diagnostics.join(" ")).toContain(
        "External agents do not receive Cognia SDK lifecycle hooks"
      )
      expect(panel.diagnostics.join(" ")).toContain("Local CLI events can still run command hooks")
    }
  )

  it("distinguishes non-Anthropic builtin runtime support", () => {
    const panel = readHooksPanel(harness({}, { provider: "openai", agentBackend: "builtin" }).deps)
    expect(panel.diagnostics.join(" ")).toContain("non-Anthropic")
  })

  it("localizes source details, diagnostics and builtin descriptions in Chinese", () => {
    const { deps } = harness(
      { [COGNIA]: JSON.stringify({ hooks: command("guard.sh") }), [CLAUDE]: "invalid" },
      { locale: "zh-CN", agentBackend: "pi-rpc" }
    )
    const panel = readHooksPanel(deps)
    expect(panel.diagnostics.join(" ")).not.toContain("Ignored invalid source")
    expect(panel.diagnostics.join(" ")).toContain(CLAUDE)
    expect(panel.rows.find((row) => row.source === "cognia")?.detail).toContain("来源")
    expect(panel.rows.find((row) => row.source === "cognia")?.detail).toContain("guard.sh")
    expect(
      panel.rows
        .filter((row) => row.source === "builtin")
        .every((row) => !row.detail.includes("cliUiSettings."))
    ).toBe(true)
  })

  it("rereads modified source files when the panel is refreshed", () => {
    const files = { [COGNIA]: JSON.stringify({ hooks: command("before.sh") }) }
    const { deps } = harness(files)
    expect(readHooksPanel(deps).rows.find((row) => row.source === "cognia")?.detail).toContain(
      "before.sh"
    )
    files[COGNIA] = JSON.stringify({ hooks: command("after.sh") })
    expect(readHooksPanel(deps).rows.find((row) => row.source === "cognia")?.detail).toContain(
      "after.sh"
    )
  })

  it("uses the real filesystem and surfaces read failures", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-panel-"))
    try {
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ hooks: command("real.sh") }))
      const deps = { home: dir, osHome: dir }
      expect(readHooksPanel(deps).rows.find((row) => row.source === "cognia")?.detail).toContain(
        "real.sh"
      )
      fs.unlinkSync(path.join(dir, "config.json"))
      fs.mkdirSync(path.join(dir, "config.json"))
      expect(readHooksPanel(deps).diagnostics.join(" ")).toContain("EISDIR")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

it("opens the interactive hooks overlay with current inventory and diagnostics", () => {
  const { actions, deps } = harness({ [COGNIA]: JSON.stringify({ hooks: command("guard.sh") }) })
  hooksList(deps)
  expect(actions).toHaveLength(1)
  expect(actions[0]).toMatchObject({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "hooks",
      rows: expect.arrayContaining([expect.objectContaining({ source: "cognia" })]),
      diagnostics: expect.any(Array),
    },
  })
})
