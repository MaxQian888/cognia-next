import React from "react"
import { render } from "@testing-library/react"

import { FileCompleter } from "./FileCompleter"

describe("FileCompleter", () => {
  it("renders completions with the highlighted row", () => {
    const { container } = render(<FileCompleter completions={["@src/", "@spec/"]} index={0} />)
    const text = container.textContent ?? ""
    expect(text).toContain("@src/")
    expect(text).toContain("@spec/")
    expect(text).toContain("❯ 📁 @src/")
  })

  it("renders nothing when there are no completions", () => {
    const { container } = render(<FileCompleter completions={[]} index={0} />)
    expect(container.textContent).toBe("")
  })

  it("marks directories with a folder glyph and leaves files unmarked", () => {
    const { container } = render(<FileCompleter completions={["@src/", "@readme.md"]} index={1} />)
    const text = container.textContent ?? ""
    expect(text).toContain("📁 @src/")
    expect(text).not.toContain("📁 @readme.md")
    expect(text).toContain("❯ ") // highlighted row marker on the file
  })

  it("shows a ↓ N more footer when the list overflows 8 rows", () => {
    const completions = Array.from({ length: 11 }, (_, i) => `@file${i}.ts`)
    const { container } = render(<FileCompleter completions={completions} index={0} />)
    const text = container.textContent ?? ""
    expect(text).toContain("↓ 3 more")
    expect(text).not.toContain("@file8.ts")
  })

  it("scrolls the window so a deep selection stays visible", () => {
    const completions = Array.from({ length: 11 }, (_, i) => `@file${i}.ts`)
    const { container } = render(<FileCompleter completions={completions} index={9} />)
    const text = container.textContent ?? ""
    // The highlighted row is on-screen with its cursor marker...
    expect(text).toContain("❯ ")
    expect(text).toContain("@file9.ts")
    // ...the early rows scrolled out of view above...
    expect(text).toContain("↑ 3 more")
    expect(text).not.toContain("@file0.ts")
  })
})
