/**
 * @jest-environment jsdom
 */
import { act, render } from "@testing-library/react"

const getActiveIconTheme = jest.fn()
const resolveFileIcon = jest.fn()
jest.mock("@/lib/plugin/bridge/icons-bridge", () => ({
  getActiveIconTheme: () => getActiveIconTheme(),
  resolveFileIcon: (...args: unknown[]) => resolveFileIcon(...args),
  subscribeIconThemes: () => () => {},
}))
jest.mock("@/lib/plugin/bridge/plugin-file-path", () => ({
  joinPluginPath: jest.fn((...parts: string[]) => parts.join("/")),
  publicBuiltinAssetUrl: (pluginId: string, relative: string) => `/plugins/${pluginId}/${relative}`,
}))

let mockResolvedTheme: string | undefined = "dark"
jest.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: mockResolvedTheme }) }))

import { FileTypeIcon } from "./file-type-icon"
import {
  __resetIconThemeHighContrastForTesting,
  setIconThemeHighContrast,
} from "@/lib/plugin/bridge/icon-theme-high-contrast"

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
    expect(resolveFileIcon).toHaveBeenCalledWith("material", "app.ts", undefined, "dark")
    expect(img).toHaveAttribute("alt", "")
    expect(img).toHaveAttribute("aria-hidden", "true")
  })

  it("collapses '../' inside the theme dir before touching the plugin path guard", () => {
    // Real VSIX themes (Material Icon Theme) reference `../icons/x.svg`
    // from `dist/theme.json` — the join guard hard-rejects `..` segments,
    // so the collapse must happen first. Escapes above the root fall back.
    const joinPluginPath = jest.requireMock<typeof import("@/lib/plugin/bridge/plugin-file-path")>(
      "@/lib/plugin/bridge/plugin-file-path"
    ).joinPluginPath as jest.Mock
    joinPluginPath.mockClear()
    getActiveIconTheme.mockReturnValue({
      id: "material",
      baseDir: "/plugins/material",
      jsonPath: "dist/material-icons.json",
    })
    resolveFileIcon.mockReturnValue({ iconPath: "./../icons/typescript.svg" })

    const { container } = render(<FileTypeIcon path="src/app.ts" />)
    expect(joinPluginPath).toHaveBeenCalledWith("/plugins/material", "icons/typescript.svg")
    expect(container.querySelector("img")).toBeTruthy()

    resolveFileIcon.mockReturnValue({ iconPath: "../../outside.svg" })
    const { container: escaped } = render(<FileTypeIcon path="src/app.ts" />)
    expect(escaped.querySelector("img")).toBeNull()
    expect(escaped.querySelector("[data-file-type]")).toBeTruthy()
  })

  it("serves bundled theme icons through the public plugin mirror", () => {
    // `builtin://` roots have no on-disk path for `convertFileSrc` — the
    // browser resolves them through `/plugins/<id>/` like every other
    // bundled-asset consumer.
    getActiveIconTheme.mockReturnValue({
      id: "material",
      baseDir: "builtin://material-icon-theme",
      jsonPath: "dist/material-icons.json",
    })
    resolveFileIcon.mockReturnValue({ iconPath: "../icons/react.svg" })

    const { container } = render(<FileTypeIcon path="src/app.tsx" />)
    const img = container.querySelector("img")
    expect(img).toHaveAttribute("src", "/plugins/material-icon-theme/icons/react.svg")
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

describe("FileTypeIcon colour scheme", () => {
  const theme = {
    id: "material",
    baseDir: "/plugins/material",
    jsonPath: "dist/material-icons.json",
  }
  afterEach(() => {
    mockResolvedTheme = "dark"
    __resetIconThemeHighContrastForTesting()
  })

  it("asks the theme for its light associations under a light app theme", () => {
    mockResolvedTheme = "light"
    getActiveIconTheme.mockReturnValue(theme)
    resolveFileIcon.mockReturnValue({ iconPath: "../icons/readme_light.svg" })

    render(<FileTypeIcon path="README.md" />)
    expect(resolveFileIcon).toHaveBeenCalledWith("material", "README.md", undefined, "light")
  })

  it("asks for the high-contrast associations while a high-contrast palette is painted", () => {
    mockResolvedTheme = "light"
    // What the theme applier publishes while it paints a high-contrast palette.
    setIconThemeHighContrast(true)
    getActiveIconTheme.mockReturnValue(theme)
    resolveFileIcon.mockReturnValue({ iconPath: "../icons/readme.svg" })

    render(<FileTypeIcon path="README.md" />)
    expect(resolveFileIcon).toHaveBeenCalledWith("material", "README.md", undefined, "highContrast")
  })

  it("repaints when the palette switches into high contrast after it rendered", () => {
    getActiveIconTheme.mockReturnValue(theme)
    resolveFileIcon.mockReturnValue({ iconPath: "../icons/readme.svg" })
    render(<FileTypeIcon path="README.md" />)
    expect(resolveFileIcon).toHaveBeenLastCalledWith("material", "README.md", undefined, "dark")

    act(() => setIconThemeHighContrast(true))
    expect(resolveFileIcon).toHaveBeenLastCalledWith(
      "material",
      "README.md",
      undefined,
      "highContrast"
    )
  })
})
