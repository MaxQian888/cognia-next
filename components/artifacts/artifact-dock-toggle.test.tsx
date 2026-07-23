/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { ArtifactDockToggle } from "./artifact-dock-toggle"

const messages = {
  chat: {
    header: {
      showArtifacts: "Show artifacts panel",
      hideArtifacts: "Hide artifacts panel",
      unreadArtifacts: "New artifacts — open panel",
    },
  },
}

function renderToggle() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ArtifactDockToggle />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(true))
  act(() => useArtifactDockLayoutStore.setState({ unreadArtifact: false }))
})

describe("ArtifactDockToggle", () => {
  it("opens the collapsed dock and reports its state", () => {
    renderToggle()
    const button = screen.getByTestId("chat-artifact-dock-toggle")
    expect(button).toHaveAttribute("aria-pressed", "false")
    expect(button).toHaveAccessibleName("Show artifacts panel")

    fireEvent.click(button)

    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
    expect(button).toHaveAttribute("aria-pressed", "true")
    expect(button).toHaveAccessibleName("Hide artifacts panel")
  })

  it("marks an artifact that arrived while the dock was dismissed", () => {
    // The dot exists so a new artifact does not force the panel open.
    act(() => useArtifactDockLayoutStore.setState({ unreadArtifact: true }))
    renderToggle()

    expect(screen.getByTestId("chat-artifact-dock-unread")).toBeInTheDocument()
    expect(screen.getByTestId("chat-artifact-dock-toggle")).toHaveAccessibleName(
      "New artifacts — open panel"
    )
  })

  it("hides the unread mark once the dock is open", () => {
    act(() => useArtifactDockLayoutStore.setState({ unreadArtifact: true }))
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    renderToggle()

    expect(screen.queryByTestId("chat-artifact-dock-unread")).toBeNull()
  })
})
