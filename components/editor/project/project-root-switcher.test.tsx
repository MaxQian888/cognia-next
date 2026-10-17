/**
 * @jest-environment jsdom
 */
import { useRef } from "react"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useRegionVisibility } from "@/hooks/browser/use-region-visibility"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { name: string }) =>
    key === "rootFollowing" ? `${values?.name} (following)` : key,
}))

import { ProjectRootSwitcher } from "./project-root-switcher"
import type { ProjectRoot } from "./use-project-editor"

const roots: ProjectRoot[] = [
  { key: "/repo", label: "main", path: "/repo", isMain: true },
  { key: "/repo-wt", label: "feature/x", path: "/repo-wt", isMain: false },
]

function EditorWithSwitcher({ onSelect }: { onSelect: (key: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const visible = useRegionVisibility(ref)
  return (
    <div>
      <ProjectRootSwitcher roots={roots} rootKey="/repo" onSelect={onSelect} />
      <div ref={ref} aria-label="editor visibility">
        {String(visible)}
      </div>
    </div>
  )
}

describe("ProjectRootSwitcher", () => {
  it("renders nothing with a single root", () => {
    const { container } = render(
      <ProjectRootSwitcher roots={[roots[0]]} rootKey="/repo" onSelect={jest.fn()} />
    )
    expect(container.firstChild).toBeNull()
  })

  it("uses the system picker and selects a root without a modal DOM portal", async () => {
    const onSelect = jest.fn()
    const user = userEvent.setup()
    const { rerender } = render(
      <ProjectRootSwitcher roots={roots} rootKey="/repo" onSelect={onSelect} />
    )
    const select = screen.getByRole("combobox", { name: "rootLabel" })
    expect(select.tagName).toBe("SELECT")
    expect(screen.getAllByRole("option")).toHaveLength(2)
    await user.selectOptions(select, "/repo-wt")
    expect(onSelect).toHaveBeenCalledWith("/repo-wt")
    rerender(<ProjectRootSwitcher roots={roots} rootKey="/repo-wt" onSelect={onSelect} />)
    expect(select).toHaveValue("/repo-wt")
    expect(document.querySelector('[data-slot="select-content"]')).toBeNull()
  })

  it("gives way in a narrow toolbar in compact density", () => {
    // The chat dock's toolbar row: 12rem when there is room, down to 6rem
    // before the switches beside it would have to wrap.
    render(<ProjectRootSwitcher roots={roots} rootKey="/repo" onSelect={jest.fn()} />)

    const select = screen.getByRole("combobox")
    expect(select).toHaveClass("h-7")
    expect(select.parentElement?.parentElement).toHaveClass("w-48", "min-w-24", "shrink")
  })

  it("uses a full-width touch target in mobile density", () => {
    render(
      <ProjectRootSwitcher roots={roots} rootKey="/repo" onSelect={jest.fn()} density="touch" />
    )

    const select = screen.getByRole("combobox")
    expect(select).toHaveClass("h-10")
    expect(select.parentElement?.parentElement).toHaveClass("w-full")
  })

  it("marks the conversation root without losing the main root label", () => {
    render(
      <ProjectRootSwitcher
        roots={roots}
        rootKey="/repo-wt"
        followedRoot="/repo-wt"
        onSelect={jest.fn()}
      />
    )
    expect(screen.getByRole("option", { name: "rootMain" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "feature/x (following)" })).toBeInTheDocument()
  })

  it("keeps the editor visible while opening, cancelling and choosing, but still hides for dialogs", async () => {
    const onSelect = jest.fn()
    const user = userEvent.setup()
    render(<EditorWithSwitcher onSelect={onSelect} />)
    const select = screen.getByRole("combobox", { name: "rootLabel" })
    expect(select.tagName).toBe("SELECT")
    await user.click(select)
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}")
    expect(screen.getByLabelText("editor visibility")).toHaveTextContent("true")
    await user.keyboard("{Escape}")
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByLabelText("editor visibility")).toHaveTextContent("true")
    await user.selectOptions(select, "/repo-wt")
    expect(onSelect).toHaveBeenCalledWith("/repo-wt")
    expect(screen.getByLabelText("editor visibility")).toHaveTextContent("true")

    const overlay = document.createElement("div")
    overlay.dataset.slot = "dialog-overlay"
    await act(async () => {
      document.body.appendChild(overlay)
    })
    expect(screen.getByLabelText("editor visibility")).toHaveTextContent("false")
    await act(async () => {
      overlay.remove()
    })
    expect(screen.getByLabelText("editor visibility")).toHaveTextContent("true")
  })
})
