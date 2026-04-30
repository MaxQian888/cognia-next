/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { ArtifactDesignerWrapper } from "./panel-designer-wrapper"
import type { Artifact } from "@/types"

const dummy: Artifact = {
  id: "a1",
  sessionId: "s",
  messageId: "m",
  type: "html",
  title: "Demo",
  content: "<html></html>",
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe("ArtifactDesignerWrapper", () => {
  it("renders the unsupported notice when open", () => {
    render(<ArtifactDesignerWrapper artifact={dummy} open onOpenChange={jest.fn()} />)
    // The translation mock returns the key verbatim.
    expect(screen.getByText("designerUnsupportedTitle")).toBeInTheDocument()
  })

  it("does not render the dialog when closed", () => {
    render(<ArtifactDesignerWrapper artifact={dummy} open={false} onOpenChange={jest.fn()} />)
    expect(screen.queryByText("designerUnsupportedTitle")).not.toBeInTheDocument()
  })
})
