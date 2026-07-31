/**
 * @jest-environment node
 */
import { inspectHandler, INSPECT_COMMANDS } from "./inspect-command"
import type { Cell } from "../state/types"
import type { CommandContext } from "./types"

function ctx(cells: Cell[]): CommandContext {
  return { args: "", state: { cells }, config: {}, version: "0" } as unknown as CommandContext
}

describe("inspectHandler", () => {
  it("notices when there is no tool output", () => {
    expect(inspectHandler(ctx([{ id: "1", kind: "user", text: "hi" } as Cell]))).toEqual({
      kind: "notice",
      message: "No tool output to inspect yet.",
    })
  })

  it("opens the inspect overlay seeded with the inspectable cells", () => {
    const cells: Cell[] = [
      {
        id: "1",
        kind: "tool",
        callKey: "1",
        toolName: "read",
        input: { file_path: "/a.ts" },
        status: "done",
        result: "code",
        collapsed: true,
      } as Cell,
    ]
    const effect = inspectHandler(ctx(cells))
    expect(effect.kind).toBe("openOverlay")
    if (effect.kind === "openOverlay" && effect.overlay.kind === "inspect") {
      expect(effect.overlay.items).toHaveLength(1)
      expect(effect.overlay.index).toBe(0)
      expect(effect.overlay.items[0].cellId).toBe("1")
    } else {
      throw new Error("expected inspect overlay")
    }
  })
})

describe("INSPECT_COMMANDS", () => {
  it("registers /inspect with a /cells alias", () => {
    expect(INSPECT_COMMANDS[0].name).toBe("inspect")
    expect(INSPECT_COMMANDS[0].aliases).toContain("cells")
  })
})
