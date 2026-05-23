/**
 * Tests for the workspace header (title + mode tabs + loading badge).
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

const storeState: { surfaces: Record<string, { title?: string; ready?: boolean }> } = {
  surfaces: {},
}

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}))

import { A2UIWorkspaceProvider } from "./a2ui-workspace-context"
import { WorkspaceHeader } from "./a2ui-workspace-header"

function renderHeader(surfaceId: string) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as Record<string, unknown>}>
      <A2UIWorkspaceProvider surfaceId={surfaceId}>
        <WorkspaceHeader />
      </A2UIWorkspaceProvider>
    </NextIntlClientProvider>
  )
}

describe("WorkspaceHeader", () => {
  beforeEach(() => {
    storeState.surfaces = {}
  })

  it("renders the surface title when present", () => {
    storeState.surfaces = { sx: { title: "My Mini App", ready: true } }
    renderHeader("sx")
    expect(screen.getByText("My Mini App")).toBeInTheDocument()
  })

  it("falls back to a truncated surfaceId when the surface has no title", () => {
    storeState.surfaces = { "long-surface-id-here": { ready: true } }
    renderHeader("long-surface-id-here")
    expect(screen.getByText("long-surface")).toBeInTheDocument()
  })

  it("shows the loading badge when the surface is not ready", () => {
    storeState.surfaces = { sx: { ready: false } }
    renderHeader("sx")
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it("renders the three mode tabs", () => {
    storeState.surfaces = { sx: { ready: true } }
    renderHeader("sx")
    const a2uiMessages = (enMessages as { a2ui: Record<string, string> }).a2ui
    const editLabel = a2uiMessages.editMode
    const previewLabel = a2uiMessages.previewMode
    const dataLabel = a2uiMessages.dataMode
    expect(screen.getByText(editLabel)).toBeInTheDocument()
    expect(screen.getAllByText(previewLabel).length).toBeGreaterThan(0)
    expect(screen.getByText(dataLabel)).toBeInTheDocument()
  })

  it("renders the back-to-gallery link", () => {
    storeState.surfaces = { sx: { ready: true } }
    renderHeader("sx")
    const link = screen.getByRole("link") as HTMLAnchorElement
    expect(link.getAttribute("href")).toBe("/a2ui")
  })

  it("clicking a mode tab updates workspace mode (smoke test that handlers wire up)", () => {
    storeState.surfaces = { sx: { ready: true } }
    renderHeader("sx")
    const editLabel = (enMessages as { a2ui: Record<string, string> }).a2ui.editMode
    // The desktop tab text lives inside the TabsTrigger element.
    const editTrigger = screen.getByText(editLabel).closest("button")
    expect(editTrigger).not.toBeNull()
    fireEvent.click(editTrigger as HTMLElement)
    // No throw == handler wired. (Mode state lives in the provider; no observable here.)
  })
})
