import { buildCliOperatingRules, buildDefaultSystemPrompt } from "./default-system-prompt"
import { CLI_BASE_IDENTITY_PROMPT } from "@/lib/agent/prompts/cli-base"
import { PLAN_MODE_PROMPT } from "@/lib/agent/prompts/plan-mode"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"

describe("buildDefaultSystemPrompt", () => {
  const NOW = Date.UTC(2026, 5, 30, 12, 0, 0) // 2026-06-30

  it("embeds the working directory in the env block", () => {
    const out = buildDefaultSystemPrompt({ cwd: "/home/me/project", now: NOW, platform: "linux" })
    expect(out).toContain("<env>")
    expect(out).toContain("Working directory: /home/me/project")
    expect(out).toContain("Platform: linux")
    expect(out).toContain("</env>")
  })

  it("renders the date as an ISO day derived from `now`", () => {
    const out = buildDefaultSystemPrompt({ cwd: "/x", now: NOW, platform: "win32" })
    expect(out).toContain("Today's date: 2026-06-30")
  })

  it("instructs the model to prefer edit over write", () => {
    const out = buildDefaultSystemPrompt({ cwd: "/x", now: NOW, platform: "darwin" })
    expect(out).toMatch(/prefer the `edit` tool/i)
    expect(out).toMatch(/Use `write` ONLY/)
    expect(out).toMatch(/Read a file before you edit/i)
  })

  it("points a sandboxed session at the edit tools it actually has", () => {
    const out = buildDefaultSystemPrompt({ cwd: "/x", now: NOW, platform: "darwin" })
    expect(out).toMatch(/Only call tools that are in your tool list/)
    expect(out).toContain("`sandbox_edit`/`sandbox_write`")
  })

  it("warns against writing into the home directory", () => {
    const out = buildDefaultSystemPrompt({ cwd: "/x", now: NOW, platform: "linux" })
    expect(out).toMatch(/Never write files into the user's home directory/i)
  })

  it("defaults the platform to process.platform when omitted", () => {
    const out = buildDefaultSystemPrompt({ cwd: "/x", now: NOW })
    expect(out).toContain(`Platform: ${process.platform}`)
  })

  it("steers tool usage toward the dedicated search tools over bash", () => {
    const out = buildDefaultSystemPrompt({ cwd: "/x", now: NOW, platform: "linux" })
    expect(out).toMatch(/use `grep` for content search/i)
    expect(out).toMatch(/`glob` for finding files/i)
    expect(out).toMatch(/independent.*one step/i)
  })

  it("instructs the model to follow project conventions and keep changes surgical", () => {
    const out = buildDefaultSystemPrompt({ cwd: "/x", now: NOW, platform: "linux" })
    expect(out).toMatch(/confirm it's already a dependency/i)
    expect(out).toMatch(/smallest change/i)
    expect(out).toMatch(/comments that merely narrate/i)
  })

  it("requires verification before claiming work is done", () => {
    const out = buildDefaultSystemPrompt({ cwd: "/x", now: NOW, platform: "linux" })
    expect(out).toMatch(/run the project's tests/i)
    expect(out).toMatch(/without checking/i)
    expect(out).toMatch(/report the failure/i)
  })

  it("asks for concise, terminal-appropriate output", () => {
    const out = buildDefaultSystemPrompt({ cwd: "/x", now: NOW, platform: "linux" })
    expect(out).toMatch(/concise and direct/i)
    expect(out).toMatch(/`path:line`/)
  })

  it("appends the explore→plan workflow section only in plan mode", () => {
    const base = buildDefaultSystemPrompt({ cwd: "/x", now: NOW, platform: "linux" })
    expect(base).not.toContain(PLAN_MODE_PROMPT.defaultBody)

    const planned = buildDefaultSystemPrompt({
      cwd: "/x",
      now: NOW,
      platform: "linux",
      permissionMode: "plan",
    })
    expect(planned).toContain(PLAN_MODE_PROMPT.defaultBody)
    // Names the read-only subagents and the plan-ready signal.
    expect(planned).toMatch(/`Explore` subagent/)
    expect(planned).toMatch(/`Plan` subagent/)
    expect(planned).toMatch(/exit_plan_mode/)
    expect(planned).toMatch(/READ-ONLY/)
  })

  it("leaves the prompt unchanged for non-plan permission modes", () => {
    const base = buildDefaultSystemPrompt({ cwd: "/x", now: NOW, platform: "linux" })
    for (const mode of ["default", "acceptEdits", "bypassPermissions", "auto"]) {
      const out = buildDefaultSystemPrompt({
        cwd: "/x",
        now: NOW,
        platform: "linux",
        permissionMode: mode,
      })
      expect(out).toBe(base)
    }
  })
})

describe("buildCliOperatingRules", () => {
  it("is exactly the rules tail of the default prompt, so parent and child cannot drift", () => {
    const full = buildDefaultSystemPrompt({
      cwd: "/repo",
      now: 0,
      platform: "linux",
      shell: "/bin/zsh",
    })
    const rules = buildCliOperatingRules({ platform: "linux", shell: "/bin/zsh" })
    expect(full.endsWith(rules)).toBe(true)
    expect(rules.startsWith("Tool usage:")).toBe(true)
    expect(rules).not.toContain("<env>")
    expect(rules).not.toContain("You are Cognia's command-line coding agent")
    expect(rules).toContain("Verifying your work:")
  })
})

describe("customizable base identity (ADR-0236)", () => {
  const NOW = Date.UTC(2026, 5, 30, 12, 0, 0)
  afterEach(() => __setPromptOverrideSnapshotForTests(null))

  it("keeps the shipped layout byte-for-byte with no override", () => {
    const out = buildDefaultSystemPrompt({
      cwd: "/x",
      now: NOW,
      platform: "linux",
      shell: "/bin/zsh",
    })
    const [identity, tone] = CLI_BASE_IDENTITY_PROMPT.defaultBody.split("\n\n")
    expect(out.startsWith(`${identity}\n\n<env>\nWorking directory: /x\n`)).toBe(true)
    expect(out).toContain(`</env>\n\n${tone}\n\n`)
  })

  it("swaps the identity and tone but keeps the host env block and operating rules", () => {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("cli-db", [
        {
          bindingId: "pob",
          promptId: CLI_BASE_IDENTITY_PROMPT.id,
          scope: "workspace",
          targetId: "ws1",
          revisionId: "por",
          body: "You are a terse Rust reviewer.",
          contractVersion: CLI_BASE_IDENTITY_PROMPT.contractVersion,
        },
      ])
    )
    const out = buildDefaultSystemPrompt({
      cwd: "/x",
      now: NOW,
      platform: "linux",
      workspaceId: "ws1",
    })
    expect(out.startsWith("You are a terse Rust reviewer.\n\n<env>\nWorking directory: /x")).toBe(
      true
    )
    expect(out).not.toContain("command-line coding agent")
    expect(out).toContain("File-editing rules:")
    // A session outside that workspace keeps the shipped identity.
    expect(buildDefaultSystemPrompt({ cwd: "/x", now: NOW, platform: "linux" })).toContain(
      "command-line coding agent"
    )
  })
})
