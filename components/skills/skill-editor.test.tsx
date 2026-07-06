/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Streamdown leans on browser DOM bits that jsdom doesn't model fully; stub it
// to a thin div so the editor renders predictably.
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

import { fireEvent, render, screen } from "@testing-library/react"
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
})
