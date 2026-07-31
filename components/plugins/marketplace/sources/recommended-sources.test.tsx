import { render, screen, fireEvent } from "@testing-library/react"

import { PluginRecommendedSources } from "./recommended-sources"
import type { RecommendedMarketplaceSource } from "./types"

const SOURCES: RecommendedMarketplaceSource[] = [
  { repoRef: "acme/plugins", name: "Acme Plugins", description: "First-party plugins." },
  { repoRef: "beta/labs", name: "Beta Labs", description: "Community picks." },
]

function renderList(props: Partial<React.ComponentProps<typeof PluginRecommendedSources>> = {}) {
  const onAdd = jest.fn()
  render(
    <PluginRecommendedSources
      sources={SOURCES}
      addedIds={new Set()}
      busyRepoRef={null}
      onAdd={onAdd}
      {...props}
    />
  )
  return { onAdd }
}

describe("PluginRecommendedSources", () => {
  it("lists each curated marketplace with its reference", () => {
    renderList()
    expect(screen.getByText("Acme Plugins")).toBeInTheDocument()
    expect(screen.getByText("beta/labs")).toBeInTheDocument()
    expect(screen.getByText("Or paste any GitHub repository above.")).toBeInTheDocument()
  })

  it("adds a source by its reference", () => {
    const { onAdd } = renderList()
    const card = screen.getByTestId("marketplace-recommended-acme/plugins")
    fireEvent.click(card.querySelector("button")!)
    expect(onAdd).toHaveBeenCalledWith("acme/plugins")
  })

  it("marks an already-added source instead of offering it again", () => {
    const { onAdd } = renderList({ addedIds: new Set(["acme/plugins"]) })
    const card = screen.getByTestId("marketplace-recommended-acme/plugins")
    const button = card.querySelector("button")!
    expect(button).toHaveTextContent("Already added")
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onAdd).not.toHaveBeenCalled()
  })

  it("disables only the entry being added", () => {
    renderList({ busyRepoRef: "beta/labs" })
    expect(
      screen.getByTestId("marketplace-recommended-beta/labs").querySelector("button")
    ).toBeDisabled()
    expect(
      screen.getByTestId("marketplace-recommended-acme/plugins").querySelector("button")
    ).toBeEnabled()
  })

  // Nothing curated → the caller's own empty state should show instead of an
  // empty heading with a dangling hint under it.
  it("renders nothing when the curated list is empty", () => {
    renderList({ sources: [] })
    expect(screen.queryByTestId("marketplace-recommended-sources")).not.toBeInTheDocument()
  })
})
