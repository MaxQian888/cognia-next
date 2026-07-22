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

jest.mock("./skill-editor-ai-popup", () => ({
  SkillEditorAiPopup: ({
    onClose,
    onAccept,
  }: {
    onClose: () => void
    onAccept: (suggested: string) => void
  }) => (
    <div data-testid="ai-popup">
      <button onClick={onClose}>mock-close-ai</button>
      <button onClick={() => onAccept("AI body")}>mock-accept-ai</button>
    </div>
  ),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { SkillEditor } from "./skill-editor"

describe("SkillEditor", () => {
  it("renders the name + category + content fields with localized labels", () => {
    render(<SkillEditor mode="create" onCancel={jest.fn()} onSave={jest.fn(async () => {})} />)
    expect(screen.getByText("name")).toBeInTheDocument()
    expect(screen.getByText("category")).toBeInTheDocument()
    expect(screen.getByText("content")).toBeInTheDocument()
  })

  it("calls onCancel when the cancel button is clicked", () => {
    const onCancel = jest.fn()
    render(<SkillEditor mode="create" onCancel={onCancel} onSave={jest.fn(async () => {})} />)
    fireEvent.click(screen.getByText("cancel"))
    expect(onCancel).toHaveBeenCalled()
  })

  it("shows the validation panel when required fields are empty", () => {
    render(<SkillEditor mode="create" onCancel={jest.fn()} onSave={jest.fn(async () => {})} />)
    // Validation header uses the editor namespace 'validation' key.
    expect(screen.getAllByText("validation").length).toBeGreaterThanOrEqual(1)
  })

  it("hides the content editor in metadata-only mode but keeps the metadata fields", () => {
    render(
      <SkillEditor
        mode="edit"
        hideContent
        initial={{ name: "Existing", content: "# body", source: "custom" } as never}
        onCancel={jest.fn()}
        onSave={jest.fn(async () => {})}
      />
    )
    // Metadata fields remain…
    expect(screen.getByText("name")).toBeInTheDocument()
    expect(screen.getByText("category")).toBeInTheDocument()
    expect(screen.getByText("tags")).toBeInTheDocument()
    // …but the markdown-content field is gone.
    expect(screen.queryByText("content")).not.toBeInTheDocument()
    // With a non-empty carried-through body, content validation must not fire.
    expect(screen.queryByText("validation")).not.toBeInTheDocument()
  })

  it("renders the preview through the complete finalized Markdown pipeline", () => {
    render(
      <SkillEditor
        mode="edit"
        initial={
          { name: "Example", content: "```mermaid\ngraph TD\n```", source: "custom" } as never
        }
        onCancel={jest.fn()}
        onSave={jest.fn(async () => {})}
      />
    )

    fireEvent.mouseDown(screen.getByRole("tab", { name: "tabPreview" }), {
      button: 0,
      ctrlKey: false,
    })
    expect(screen.getByTestId("markdown-renderer")).toHaveTextContent("## Example")
    expect(screen.getByTestId("markdown-renderer")).toHaveTextContent("```mermaid")
  })

  it("uses localized preview fallbacks for empty content and an unnamed draft", () => {
    const { container } = render(
      <SkillEditor mode="create" onCancel={jest.fn()} onSave={jest.fn(async () => {})} />
    )
    fireEvent.mouseDown(screen.getByRole("tab", { name: "tabPreview" }), {
      button: 0,
      ctrlKey: false,
    })
    expect(screen.getByText("contentPlaceholder")).toBeInTheDocument()

    fireEvent.mouseDown(screen.getByRole("tab", { name: "tabEdit" }), {
      button: 0,
      ctrlKey: false,
    })
    fireEvent.change(container.querySelector("textarea")!, { target: { value: "Body" } })
    fireEvent.mouseDown(screen.getByRole("tab", { name: "tabPreview" }), {
      button: 0,
      ctrlKey: false,
    })
    expect(screen.getByTestId("markdown-renderer")).toHaveTextContent("## unnamedPreview")
  })

  it("saves a valid minimal draft with optional metadata omitted", async () => {
    const onSave = jest.fn(async () => {})
    const { container } = render(<SkillEditor mode="create" onCancel={jest.fn()} onSave={onSave} />)
    const inputs = container.querySelectorAll("input")
    fireEvent.change(inputs[0], { target: { value: "Minimal" } })
    fireEvent.change(container.querySelector("textarea")!, { target: { value: "Body" } })
    fireEvent.click(screen.getByText("create"))

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        name: "Minimal",
        description: undefined,
        content: "Body",
        allowedTools: undefined,
        tags: undefined,
        category: "custom",
        version: undefined,
        author: undefined,
        license: undefined,
      })
    )
  })

  it("edits, accepts AI content, parses chips, and saves the complete draft", async () => {
    const onSave = jest.fn(async () => {})
    const { container } = render(
      <SkillEditor
        mode="create"
        onCancel={jest.fn()}
        onSave={onSave}
        onAiAssist={jest.fn(async () => null)}
      />
    )
    const inputs = container.querySelectorAll("input")
    fireEvent.change(inputs[0], { target: { value: "  Example  " } })
    fireEvent.change(inputs[1], { target: { value: "  Description  " } })
    fireEvent.change(inputs[2], { target: { value: "1.2.3" } })
    fireEvent.change(inputs[3], { target: { value: "  Author  " } })
    fireEvent.change(inputs[4], { target: { value: "  MIT  " } })
    fireEvent.change(inputs[5], { target: { value: "alpha, beta, gamma" } })
    fireEvent.change(container.querySelector("textarea")!, { target: { value: "Initial body" } })
    fireEvent.change(inputs[6], { target: { value: "Read, Write, Execute" } })

    fireEvent.click(screen.getByText("ai.buttonLabel"))
    fireEvent.click(screen.getByText("mock-close-ai"))
    fireEvent.click(screen.getByText("ai.buttonLabel"))
    fireEvent.click(screen.getByText("mock-accept-ai"))
    fireEvent.click(screen.getByText("create"))

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        name: "Example",
        description: "Description",
        content: "AI body",
        allowedTools: ["Read", "Write", "Execute"],
        tags: ["alpha", "beta", "gamma"],
        category: "custom",
        version: "1.2.3",
        author: "Author",
        license: "MIT",
      })
    )
  })
})
