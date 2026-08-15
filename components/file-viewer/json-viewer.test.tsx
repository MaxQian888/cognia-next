import { render, screen } from "@testing-library/react"
import JsonViewer from "./json-viewer"
import type { FileViewerRenderProps } from "@/lib/file-viewer/types"

function props(text: string): FileViewerRenderProps {
  return {
    text,
    displayName: "data.json",
    relPath: "data.json",
    line: null,
    column: null,
    source: "project-preview",
  }
}

describe("JsonViewer", () => {
  it("pretty-prints valid JSON", () => {
    render(<JsonViewer {...props('{"a":1}')} />)
    expect(screen.getByTestId("project-json-preview")).toHaveTextContent('{ "a": 1 }')
  })

  it("shows the raw text when it does not parse", () => {
    // An unparseable file is still worth reading — showing nothing would be a
    // worse answer than showing what is actually there.
    render(<JsonViewer {...props("{not json")} />)
    expect(screen.getByTestId("project-json-preview")).toHaveTextContent("{not json")
  })
})
