import { fireEvent, render, screen } from "@testing-library/react"
import { ReferenceChips } from "./reference-chips"
import { ComposerSessionProvider } from "./composer/composer-session-context"
import { useChatStore } from "@/stores/chat"

beforeEach(() => {
  useChatStore.getState().clear()
})

function seedRefs() {
  const store = useChatStore.getState()
  store.addReferencedPath({ absolute: "/repo/src/a.ts", relative: "src/a.ts", isDir: false })
  store.addReferencedPath({ absolute: "/repo/pkg", relative: "pkg", isDir: true })
}

describe("ReferenceChips", () => {
  it("renders nothing without references", () => {
    const { container } = render(<ReferenceChips />)
    expect(container.firstChild).toBeNull()
  })

  it("renders a padded container in standalone mode", () => {
    seedRefs()
    const { container } = render(<ReferenceChips />)
    expect(screen.getByText("src/a.ts")).toBeInTheDocument()
    expect(screen.getByText("pkg")).toBeInTheDocument()
    // Standalone wraps the chips in its own padded row.
    expect((container.firstChild as HTMLElement).className).toContain("flex-wrap")
  })

  it("omits the container in bare mode for composition in a parent bar", () => {
    seedRefs()
    const { container } = render(<ReferenceChips bare />)
    // Bare returns the chips directly — first child is a chip, not a padded row.
    expect((container.firstChild as HTMLElement).className).not.toContain("px-2 pt-2")
    expect(screen.getByText("src/a.ts")).toBeInTheDocument()
  })

  it("removes a reference when its X is clicked", () => {
    seedRefs()
    render(<ReferenceChips />)
    fireEvent.click(screen.getByRole("button", { name: /src\/a\.ts/ }))
    expect(useChatStore.getState().referencedPaths.map((r) => r.relative)).toEqual(["pkg"])
  })

  it("shows the chips of the pane's OWN conversation, not the focused one", () => {
    // Split view: the unfocused pane rendered the focused conversation's chips,
    // so its own staged references were invisible and clicking × removed a chip
    // from a slice nobody was displaying.
    const store = useChatStore.getState()
    store.setActiveSession("ses_focused")
    store.addReferencedPath({ absolute: "/repo/focused.ts", relative: "focused.ts", isDir: false })
    store.addReferencedPath(
      { absolute: "/repo/background.ts", relative: "background.ts", isDir: false },
      "ses_background"
    )

    render(
      <ComposerSessionProvider value="ses_background">
        <ReferenceChips />
      </ComposerSessionProvider>
    )
    expect(screen.getByText("background.ts")).toBeInTheDocument()
    expect(screen.queryByText("focused.ts")).not.toBeInTheDocument()
  })

  it("removes from the pane's own conversation, leaving the focused one alone", () => {
    const store = useChatStore.getState()
    store.setActiveSession("ses_focused")
    store.addReferencedPath({ absolute: "/repo/focused.ts", relative: "focused.ts", isDir: false })
    store.addReferencedPath(
      { absolute: "/repo/background.ts", relative: "background.ts", isDir: false },
      "ses_background"
    )

    render(
      <ComposerSessionProvider value="ses_background">
        <ReferenceChips />
      </ComposerSessionProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: /background\.ts/ }))

    const state = useChatStore.getState()
    expect(state.sessions["ses_background"]?.referencedPaths).toEqual([])
    expect(state.referencedPaths.map((r) => r.relative)).toEqual(["focused.ts"])
  })
})
