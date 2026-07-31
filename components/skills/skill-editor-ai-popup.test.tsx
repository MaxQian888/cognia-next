/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown-renderer">{content}</div>
  ),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
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

  it("renders an AI suggestion through the complete finalized Markdown pipeline", async () => {
    const onAccept = jest.fn()
    render(
      <SkillEditorAiPopup
        current={{ name: "X", description: "", content: "body" }}
        validationErrors={[]}
        onClose={jest.fn()}
        onAccept={onAccept}
        onAiAssist={jest.fn(async () => "$$x^2$$")}
      />
    )

    fireEvent.click(screen.getByText("optimize"))
    expect(await screen.findByTestId("markdown-renderer")).toHaveTextContent("$$x^2$$")
    fireEvent.click(screen.getByText("accept"))
    expect(onAccept).toHaveBeenCalledWith("$$x^2$$")
  })

  it("closes when the dialog is dismissed", () => {
    const onClose = jest.fn()
    render(
      <SkillEditorAiPopup
        current={{ name: "X", description: "", content: "body" }}
        validationErrors={[]}
        onClose={onClose}
        onAccept={jest.fn()}
        onAiAssist={jest.fn(async () => null)}
      />
    )
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    expect(onClose).toHaveBeenCalled()
  })

  it("passes validation errors only to the fix-errors intent", async () => {
    const validationError = { code: "invalid", message: "broken", field: "content" } as never
    const onAiAssist = jest.fn(async () => null)
    render(
      <SkillEditorAiPopup
        current={{ name: "X", description: "", content: "body" }}
        validationErrors={[validationError]}
        onClose={jest.fn()}
        onAccept={jest.fn()}
        onAiAssist={onAiAssist}
      />
    )
    fireEvent.click(screen.getByText("fixErrors"))
    await waitFor(() =>
      expect(onAiAssist).toHaveBeenCalledWith(
        "fixErrors",
        expect.objectContaining({ validationErrors: [validationError] })
      )
    )
  })
})
