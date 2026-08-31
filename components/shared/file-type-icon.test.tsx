/**
 * @jest-environment jsdom
 */
import { render } from "@testing-library/react"

const getActiveIconTheme = jest.fn()
const resolveFileIcon = jest.fn()
jest.mock("@/lib/plugin/bridge/icons-bridge", () => ({
  getActiveIconTheme: () => getActiveIconTheme(),
  resolveFileIcon: (...args: unknown[]) => resolveFileIcon(...args),
  subscribeIconThemes: () => () => {},
}))
jest.mock("@/lib/plugin/bridge/plugin-file-path", () => ({
  joinPluginPath: (...parts: string[]) => parts.join("/"),
}))

import { FileTypeIcon } from "./file-type-icon"

beforeEach(() => {
  getActiveIconTheme.mockReset().mockReturnValue(undefined)
  resolveFileIcon.mockReset().mockReturnValue(undefined)
})

describe("FileTypeIcon", () => {
  it("gives different file types different glyphs", () => {
    // The whole point: a `.tsx`, an image and a lockfile used to be the same
    // generic page icon everywhere a path is listed.
    const kinds = ["components/app.tsx", "assets/logo.png", "pnpm-lock.yaml"].map((path) => {
      const { container } = render(<FileTypeIcon path={path} />)
      return container.querySelector("[data-file-type]")?.getAttribute("data-file-type")
    })
    expect(kinds).toEqual(["react", "image", "lock"])
    expect(new Set(kinds).size).toBe(3)
  })

  it("renders a folder glyph when told the entry is a directory", () => {
    // `isDir` is passed, never inferred — a directory named `styles.css` is a
    // directory.
    const { container } = render(<FileTypeIcon path="components/styles.css" isDir />)
    expect(container.querySelector("[data-file-type]")).toHaveAttribute("data-file-type", "folder")
  })

  it("carries the per-type tone, and drops it when muted", () => {
    const { container: coloured } = render(<FileTypeIcon path="a.ts" />)
    expect(coloured.querySelector("[data-file-type]")?.getAttribute("class")).toContain("text-blue")

    const { container: plain } = render(<FileTypeIcon path="a.ts" muted />)
    const cls = plain.querySelector("[data-file-type]")?.getAttribute("class") ?? ""
    expect(cls).toContain("text-muted-foreground")
    expect(cls).not.toContain("text-blue")
  })

  it("stays decorative — the filename beside it is the accessible name", () => {
    const { container } = render(<FileTypeIcon path="a.ts" />)
    expect(container.querySelector("[data-file-type]")).toHaveAttribute("aria-hidden", "true")
  })

  it("takes its size from the caller", () => {
    const { container } = render(<FileTypeIcon path="a.ts" className="size-4" />)
    const cls = container.querySelector("[data-file-type]")?.getAttribute("class") ?? ""
    expect(cls).toContain("size-4")
    expect(cls).toContain("shrink-0")
  })

  it("prefers an installed VS Code icon theme over the built-in glyph", () => {
    // Someone who installed Material Icon Theme wants THOSE icons, not our
    // approximation of them.
    getActiveIconTheme.mockReturnValue({
      id: "material",
      baseDir: "/plugins/material",
      jsonPath: "dist/material-icons.json",
    })
    resolveFileIcon.mockReturnValue({ iconPath: "../icons/typescript.svg" })

    const { container } = render(<FileTypeIcon path="src/app.ts" />)
    const img = container.querySelector("img")
    expect(img).toBeTruthy()
    expect(container.querySelector("[data-file-type]")).toBeNull()
    // Only the basename is classified, and the icon path resolves relative to
    // the theme JSON's own directory.
    expect(resolveFileIcon).toHaveBeenCalledWith("material", "app.ts")
    expect(img).toHaveAttribute("alt", "")
    expect(img).toHaveAttribute("aria-hidden", "true")
  })

  it("falls back to the built-in glyph when the theme has no icon for the file", () => {
    getActiveIconTheme.mockReturnValue({
      id: "material",
      baseDir: "/plugins/material",
      jsonPath: "material-icons.json",
    })
    resolveFileIcon.mockReturnValue(undefined)

    const { container } = render(<FileTypeIcon path="src/app.ts" />)
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("[data-file-type]")).toHaveAttribute(
      "data-file-type",
      "typescript"
    )
  })

  it("keeps folders on the built-in glyph even with a theme installed", () => {
    // The bridge resolves files; letting it answer for folders too would let the
    // two sources disagree about which folder state is being shown.
    getActiveIconTheme.mockReturnValue({
      id: "material",
      baseDir: "/plugins/material",
      jsonPath: "material-icons.json",
    })
    const { container } = render(<FileTypeIcon path="lib/files" isDir />)
    expect(resolveFileIcon).not.toHaveBeenCalled()
    expect(container.querySelector("[data-file-type]")).toHaveAttribute("data-file-type", "folder")
  })
})
