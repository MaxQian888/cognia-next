import { buildDefaultSystemPrompt, PLAN_MODE_PROMPT_SECTION } from "./default-system-prompt"

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
    expect(base).not.toContain(PLAN_MODE_PROMPT_SECTION)

    const planned = buildDefaultSystemPrompt({
      cwd: "/x",
      now: NOW,
      platform: "linux",
      permissionMode: "plan",
    })
    expect(planned).toContain(PLAN_MODE_PROMPT_SECTION)
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
