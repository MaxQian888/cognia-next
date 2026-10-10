/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { DocumentTemplateGlyph, DOCUMENT_TEMPLATE_GLYPHS } from "./document-template-glyph"

it("has a glyph for every template icon", () => {
  for (const icon of ["blank", "guide", "todo", "tracker", "update", "meeting", "saved"] as const) {
    expect(DOCUMENT_TEMPLATE_GLYPHS[icon]).toBeDefined()
  }
})

it("draws the icon decoratively", () => {
  render(<DocumentTemplateGlyph icon="meeting" className="size-6" />)
  const glyph = screen.getByTestId("document-template-glyph")
  expect(glyph).toHaveAttribute("data-icon", "meeting")
  expect(glyph).toHaveAttribute("aria-hidden", "true")
  expect(glyph).toHaveClass("size-6")
})
