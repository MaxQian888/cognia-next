/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock(
  "streamdown",
  () => ({
    __esModule: true,
    Streamdown: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="streamdown">{children}</div>
    ),
  }),
  { virtual: true }
)

import { render, screen } from "@testing-library/react"
import { SkillEditorAiPopup } from "./skill-editor-ai-popup"

describe("SkillEditorAiPopup", () => {
  it("falls back to the localized unnamed-preview label when the draft has no name", () => {
    render(
      <SkillEditorAiPopup
        current={{ name: "", description: "", content: "body" }}
        validationErrors={[]}
        onClose={jest.fn()}
        onAccept={jest.fn()}
        onAiAssist={jest.fn(async () => null)}
      />
    )
    // The mock echoes keys; the editor namespace key is "unnamedPreview".
    expect(screen.getByText(/unnamedPreview/)).toBeInTheDocument()
    expect(screen.queryByText(/\(unnamed skill\)/)).not.toBeInTheDocument()
  })

  it("renders the four intent triggers", () => {
    render(
      <SkillEditorAiPopup
        current={{ name: "X", description: "", content: "body" }}
        validationErrors={[]}
        onClose={jest.fn()}
        onAccept={jest.fn()}
        onAiAssist={jest.fn(async () => null)}
      />
    )
    expect(screen.getByText("optimize")).toBeInTheDocument()
    expect(screen.getByText("simplify")).toBeInTheDocument()
    expect(screen.getByText("expand")).toBeInTheDocument()
    expect(screen.getByText("fixErrors")).toBeInTheDocument()
  })
})
