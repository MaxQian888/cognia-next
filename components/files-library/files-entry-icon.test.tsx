/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { FilesEntryIcon } from "./files-entry-icon"

it("uses a per-kind glyph for artifacts, canvas documents and images", () => {
  const { rerender } = render(
    <FilesEntryIcon entry={{ kind: "artifact", subtype: "html", title: "Page" }} />
  )
  expect(screen.getByTestId("files-entry-icon-artifact")).toBeInTheDocument()
  rerender(<FilesEntryIcon entry={{ kind: "artifact", subtype: "unknown-type", title: "X" }} />)
  expect(screen.getByTestId("files-entry-icon-artifact")).toBeInTheDocument()
  rerender(<FilesEntryIcon entry={{ kind: "canvas", title: "Notes" }} />)
  expect(screen.getByTestId("files-entry-icon-canvas")).toBeInTheDocument()
  rerender(<FilesEntryIcon entry={{ kind: "image", title: "" }} />)
  expect(screen.getByTestId("files-entry-icon-image")).toBeInTheDocument()
})

it("classifies uploads by filename", () => {
  const { container } = render(<FilesEntryIcon entry={{ kind: "upload", title: "SPEC.md" }} />)
  expect(screen.queryByTestId(/files-entry-icon-/)).toBeNull()
  expect(container.firstChild).not.toBeNull()
  render(<FilesEntryIcon entry={{ kind: "session-upload", title: "" }} />)
})
