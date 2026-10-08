import { CheckIcon, MinusIcon, Undo2Icon } from "lucide-react"
import { HUNK_ACTION_ICON } from "./hunk-actions"

describe("HUNK_ACTION_ICON", () => {
  it("draws every hunk action with its own glyph", () => {
    expect(HUNK_ACTION_ICON).toEqual({ stage: CheckIcon, unstage: MinusIcon, discard: Undo2Icon })
  })
})
