import { defineCommand } from "./define-command"

describe("defineCommand", () => {
  it("returns the command contribution unchanged", () => {
    const def = {
      id: "plugin.run",
      name: "Run plugin action",
      aliases: ["plugin-run"],
    }

    expect(defineCommand(def)).toBe(def)
  })
})
