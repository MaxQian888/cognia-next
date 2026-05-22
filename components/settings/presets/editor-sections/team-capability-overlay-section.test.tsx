/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { TeamCapabilityOverlaySection } from "./team-capability-overlay-section"
import { emptyEditorState } from "../preset-editor-state"

describe("TeamCapabilityOverlaySection", () => {
  it("renders the section title (no diffs branch keeps body empty)", () => {
    render(<TeamCapabilityOverlaySection state={emptyEditorState()} defaultOpen={true} />)
    expect(screen.getByText("title")).toBeInTheDocument()
  })

  it("classifies effective ids as inherited / added / removed against the team baseline", () => {
    const state = { ...emptyEditorState(), skillIds: ["s1", "s3"] }
    render(
      <TeamCapabilityOverlaySection
        state={state}
        teamBundle={{ skillIds: ["s1", "s2"] }}
        defaultOpen={true}
      />
    )
    expect(screen.getByText("inheritedLabel:")).toBeInTheDocument()
    expect(screen.getByText("addedLabel:")).toBeInTheDocument()
    expect(screen.getByText("removedLabel:")).toBeInTheDocument()
    expect(screen.getByText("s1")).toBeInTheDocument()
    expect(screen.getByText("+s3")).toBeInTheDocument()
    expect(screen.getByText("−s2")).toBeInTheDocument()
  })
})
