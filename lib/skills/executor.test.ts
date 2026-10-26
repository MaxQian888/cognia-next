import { executeSkill, skillsExecutor } from "./executor"

describe("executeSkill", () => {
  it("returns an empty execution result", async () => {
    const out = await executeSkill({ skillId: "x" })
    expect(out).toEqual({ output: "" })
  })
})

describe("skillsExecutor", () => {
  it("aliases executeSkill", async () => {
    const out = await skillsExecutor.execute({ skillId: "y" })
    expect(out.output).toBe("")
  })
})
