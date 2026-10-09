import { EDITOR_SUBTITLE_ROW_CLASS, EDITOR_TITLE_ROW_CLASS } from "./editor-chrome"

describe("editor chrome rows", () => {
  it("are fixed Tailwind heights, so content never decides where a rule falls", () => {
    expect(EDITOR_TITLE_ROW_CLASS).toMatch(/^h-\d+$/)
    expect(EDITOR_SUBTITLE_ROW_CLASS).toMatch(/^h-\d+$/)
  })

  it("keep the title row taller than the row under it, like VS Code's title and breadcrumbs", () => {
    const step = (cls: string) => Number(cls.slice(2))
    expect(step(EDITOR_TITLE_ROW_CLASS)).toBeGreaterThan(step(EDITOR_SUBTITLE_ROW_CLASS))
  })
})
