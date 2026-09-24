import {
  armProjectEditorGoto,
  consumeProjectEditorGoto,
  PROJECT_EDITOR_GOTO_EVENT,
  type ProjectEditorGotoDetail,
} from "./editor-events"

describe("editor-events", () => {
  it("exposes a stable goto event name", () => {
    expect(PROJECT_EDITOR_GOTO_EVENT).toBe("project-editor-goto")
  })

  it("types a goto detail payload", () => {
    const detail: ProjectEditorGotoDetail = { relPath: "a.ts", line: 1, column: 1 }
    expect(detail.relPath).toBe("a.ts")
  })

  describe("pending goto store", () => {
    it("returns an armed goto exactly once", () => {
      armProjectEditorGoto({ relPath: "src/x.ts", line: 12, column: 3 })
      expect(consumeProjectEditorGoto("src/x.ts")).toEqual({
        relPath: "src/x.ts",
        line: 12,
        column: 3,
      })
      expect(consumeProjectEditorGoto("src/x.ts")).toBeNull()
    })

    it("the latest arm wins for the same path", () => {
      armProjectEditorGoto({ relPath: "src/x.ts", line: 1, column: 1 })
      armProjectEditorGoto({ relPath: "src/x.ts", line: 40, column: 2 })
      expect(consumeProjectEditorGoto("src/x.ts")?.line).toBe(40)
    })

    it("is keyed per path", () => {
      armProjectEditorGoto({ relPath: "a.ts", line: 1, column: 1 })
      armProjectEditorGoto({ relPath: "b.ts", line: 2, column: 1 })
      expect(consumeProjectEditorGoto("c.ts")).toBeNull()
      expect(consumeProjectEditorGoto("b.ts")?.line).toBe(2)
      expect(consumeProjectEditorGoto("a.ts")?.line).toBe(1)
    })

    it("expires an arm whose target never opened", () => {
      jest.useFakeTimers()
      try {
        armProjectEditorGoto({ relPath: "gone.ts", line: 9, column: 1 })
        jest.advanceTimersByTime(16_000)
        // A much-later open of the same path must not jump to a stale line.
        expect(consumeProjectEditorGoto("gone.ts")).toBeNull()
      } finally {
        jest.useRealTimers()
      }
    })
  })
})
