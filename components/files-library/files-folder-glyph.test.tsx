/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { LIBRARY_FOLDER_COLORS, LIBRARY_FOLDER_ICONS } from "@/lib/db/files-library-types"
import {
  FilesFolderGlyph,
  FOLDER_COLOR_CLASSES,
  FOLDER_ICON_GLYPHS,
  FOLDER_SWATCH_CLASSES,
} from "./files-folder-glyph"

it("has a glyph for every icon and a tint and swatch for every color", () => {
  for (const icon of LIBRARY_FOLDER_ICONS) expect(FOLDER_ICON_GLYPHS[icon]).toBeDefined()
  for (const color of LIBRARY_FOLDER_COLORS) {
    expect(FOLDER_COLOR_CLASSES[color]).toMatch(/^text-/)
    expect(FOLDER_SWATCH_CLASSES[color]).toMatch(/^bg-/)
  }
})

it("draws the default folder, open while in view", () => {
  const { rerender } = render(<FilesFolderGlyph folder={{}} />)
  const glyph = screen.getByTestId("files-folder-glyph")
  expect(glyph).toHaveAttribute("data-color", "default")
  expect(glyph).toHaveAttribute("data-icon", "folder")
  expect(glyph).toHaveClass("text-primary", "lucide-folder")
  rerender(<FilesFolderGlyph folder={{}} open />)
  expect(screen.getByTestId("files-folder-glyph")).toHaveClass("lucide-folder-open")
})

it("draws the picked icon in the picked color", () => {
  render(<FilesFolderGlyph folder={{ color: "violet", icon: "star" }} open className="size-5" />)
  const glyph = screen.getByTestId("files-folder-glyph")
  expect(glyph).toHaveClass("text-violet-500", "lucide-star", "size-5")
  expect(glyph).toHaveAttribute("aria-hidden", "true")
})
