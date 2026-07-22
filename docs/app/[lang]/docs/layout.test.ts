import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("docs layout chrome", () => {
  it("mounts reading progress and back-to-top", () => {
    const source = readFileSync(join(__dirname, "layout.tsx"), "utf8")
    expect(source).toContain("<ReadingProgress />")
    expect(source).toContain("<BackToTop />")
  })
})
