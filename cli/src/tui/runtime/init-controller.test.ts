import { agentsTemplate, INSTRUCTION_FILENAMES, runInit } from "./init-controller"
import type { TuiAction } from "../state/types"

describe("agentsTemplate", () => {
  it("titles the document with the project name and includes the standard sections", () => {
    const t = agentsTemplate("my-app")
    expect(t.startsWith("# my-app")).toBe(true)
    expect(t).toContain("## Project overview")
    expect(t).toContain("## Commands")
    expect(t).toContain("## Notes for the agent")
  })
})

describe("runInit", () => {
  function harness(existing: string[] = []) {
    const actions: TuiAction[] = []
    const writes: Array<{ path: string; content: string }> = []
    const norm = (p: string) => p.replace(/\\/g, "/")
    return {
      actions,
      writes,
      deps: {
        dispatch: (a: TuiAction) => actions.push(a),
        cwd: "/work/my-app",
        exists: (p: string) => existing.some((f) => norm(p).endsWith(f)),
        write: (path: string, content: string) => writes.push({ path, content }),
      },
    }
  }

  it("writes AGENTS.md named after the cwd when none exists", async () => {
    const h = harness()
    await runInit(h.deps)
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0].path.replace(/\\/g, "/")).toBe("/work/my-app/AGENTS.md")
    expect(h.writes[0].content.startsWith("# my-app")).toBe(true)
    expect(h.actions.at(-1)).toMatchObject({
      type: "NOTICE",
      message: expect.stringMatching(/Created/),
    })
  })

  it.each(INSTRUCTION_FILENAMES)("refuses to overwrite an existing %s", async (existing) => {
    const h = harness([existing])
    await runInit(h.deps)
    expect(h.writes).toHaveLength(0)
    expect(h.actions[0]).toMatchObject({
      type: "NOTICE",
      message: expect.stringContaining(`${existing} already exists`),
    })
  })

  it("surfaces a write failure as a notice", async () => {
    const h = harness()
    h.deps.write = () => {
      throw new Error("read-only fs")
    }
    await runInit(h.deps)
    expect(h.actions.at(-1)).toMatchObject({
      type: "NOTICE",
      message: expect.stringMatching(/Could not write AGENTS.md: read-only fs/),
    })
  })
})
