import { fireEvent, render, screen } from "@testing-library/react"
import { PROJECT_EDITOR_GOTO_EVENT } from "./editor-events"
import { ProjectFileOutlinePanel } from "./project-file-outline-panel"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

it("parses the current draft and navigates Monaco from an outline symbol", () => {
  const listener = jest.fn()
  window.addEventListener(PROJECT_EDITOR_GOTO_EVENT, listener)
  render(
    <ProjectFileOutlinePanel
      relPath="src/a.ts"
      language="typescript"
      content="export function greet() { return 'hi' }"
    />
  )
  fireEvent.click(screen.getByRole("treeitem", { name: /greet/ }))
  expect(listener).toHaveBeenCalledWith(
    expect.objectContaining({ detail: expect.objectContaining({ relPath: "src/a.ts" }) })
  )
  window.removeEventListener(PROJECT_EDITOR_GOTO_EVENT, listener)
})

it("shows an explicit empty outline for unsupported files", () => {
  render(<ProjectFileOutlinePanel relPath="notes.txt" language="plaintext" content="hello" />)
  expect(screen.getByText("outlineEmpty")).toBeInTheDocument()
})
