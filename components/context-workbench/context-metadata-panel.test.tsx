/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import { ContextMetadataPanel } from "./context-metadata-panel"

describe("ContextMetadataPanel", () => {
  it("renders an accessible metadata list", () => {
    render(
      <ContextMetadataPanel
        title="Properties"
        fields={[
          { label: "Language", value: "typescript" },
          { label: "Version", value: 3 },
        ]}
      />
    )

    expect(screen.getByRole("region", { name: "Properties" })).toBeInTheDocument()
    expect(screen.getByText("Language")).toBeInTheDocument()
    expect(screen.getByText("typescript")).toBeInTheDocument()
    expect(screen.getByText("3")).toBeInTheDocument()
  })
})
