import { PROJECT_EDITOR_GOTO_EVENT, type ProjectEditorGotoDetail } from "./editor-events"

describe("editor-events", () => {
  it("exposes a stable goto event name", () => {
    expect(PROJECT_EDITOR_GOTO_EVENT).toBe("project-editor-goto")
  })

  it("types a goto detail payload", () => {
    const detail: ProjectEditorGotoDetail = { relPath: "a.ts", line: 1, column: 1 }
    expect(detail.relPath).toBe("a.ts")
  })
})
