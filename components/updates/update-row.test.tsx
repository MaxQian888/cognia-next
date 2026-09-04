/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import type { UpdateItem } from "@/lib/updates/adapter"

import { UpdateRow } from "./update-row"

function item(overrides: Partial<UpdateItem> = {}): UpdateItem {
  return {
    key: "desktop:app",
    assetId: "app",
    kind: "desktop",
    executor: "tauri",
    state: "available",
    candidate: {
      assetId: "app",
      kind: "desktop",
      executor: "tauri",
      currentVersion: "1.0.0",
      targetVersion: "1.1.0",
      channel: "stable",
      criticality: "routine",
      source: "catalog",
      provenance: "verified",
    },
    currentVersion: "1.0.0",
    action: "install-in-app",
    externallyInstalled: false,
    ...overrides,
  }
}

function renderRow(overrides: Partial<UpdateItem> = {}, props: Record<string, unknown> = {}) {
  const handlers = {
    onApply: jest.fn(),
    onSkip: jest.fn(),
    onDefer: jest.fn(),
    onClearHold: jest.fn(),
  }
  render(<UpdateRow item={item(overrides)} {...handlers} {...props} />)
  return handlers
}

describe("UpdateRow", () => {
  it("always says who performs the install", () => {
    renderRow()
    expect(screen.getByText("Installed by Cognia")).toBeInTheDocument()
  })

  it("says the store installs a store-backed asset", () => {
    renderRow({ kind: "mobile-ios", executor: "app-store", externallyInstalled: true })
    expect(screen.getByText("Installed by the App Store")).toBeInTheDocument()
  })

  it("shows the version change", () => {
    renderRow()
    expect(screen.getByText("1.0.0 to 1.1.0")).toBeInTheDocument()
  })

  it("tells an unpaired extension user what the store has, with no local claim", () => {
    const row = item({
      kind: "browser-chrome",
      executor: "browser-store",
      currentVersion: null,
      externallyInstalled: true,
    })
    row.candidate = { ...row.candidate!, currentVersion: null, targetVersion: "1.4.0" }
    render(
      <UpdateRow
        item={row}
        onApply={jest.fn()}
        onSkip={jest.fn()}
        onDefer={jest.fn()}
        onClearHold={jest.fn()}
      />
    )
    expect(screen.getByText("Not connected. The store lists version 1.4.0.")).toBeInTheDocument()
  })

  it("offers skip and defer for a routine update", () => {
    renderRow()
    expect(screen.getByTestId("update-skip-desktop:app")).toBeInTheDocument()
    expect(screen.getByTestId("update-defer-desktop:app")).toBeInTheDocument()
  })

  it("never offers to skip a critical update", () => {
    const row = item()
    row.candidate = { ...row.candidate!, criticality: "critical" }
    render(
      <UpdateRow
        item={row}
        onApply={jest.fn()}
        onSkip={jest.fn()}
        onDefer={jest.fn()}
        onClearHold={jest.fn()}
      />
    )
    expect(screen.queryByTestId("update-skip-desktop:app")).not.toBeInTheDocument()
    expect(screen.getByTestId("update-defer-desktop:app")).toBeInTheDocument()
    expect(screen.getByText(/critical update/i)).toBeInTheDocument()
  })

  it("warns when a version widens permissions", () => {
    const row = item()
    row.candidate = { ...row.candidate!, permissionsExpanded: true }
    render(
      <UpdateRow
        item={row}
        onApply={jest.fn()}
        onSkip={jest.fn()}
        onDefer={jest.fn()}
        onClearHold={jest.fn()}
      />
    )
    expect(
      screen.getByText("This version asks for more access than the one you have.")
    ).toBeInTheDocument()
  })

  it("warns when a build is not in the signed catalog", () => {
    const row = item()
    row.candidate = { ...row.candidate!, provenance: "unsigned" }
    render(
      <UpdateRow
        item={row}
        onApply={jest.fn()}
        onSkip={jest.fn()}
        onDefer={jest.fn()}
        onClearHold={jest.fn()}
      />
    )
    expect(screen.getByText(/not in the signed catalog/i)).toBeInTheDocument()
  })

  it("shows the error and never a bare code", () => {
    renderRow({
      state: "failed",
      failure: { kind: "disk", code: "insufficient_space" },
    })
    expect(screen.getByTestId("update-error-desktop:app")).toHaveTextContent(
      "There is not enough disk space to install this update."
    )
  })

  it("explains an interrupted install rather than silently offering it again", () => {
    renderRow({
      state: "failed",
      failure: { kind: "unknown", code: "install_interrupted" },
    })
    expect(screen.getByText(/did not finish/i)).toBeInTheDocument()
  })

  it("shows the exact command for a package-manager update", () => {
    renderRow({
      kind: "cli",
      executor: "package-manager",
      externallyInstalled: true,
      action: "run-package-manager",
      command: "pnpm add -g @cognia/agent-cli@0.5.0",
    })
    expect(screen.getByText("pnpm add -g @cognia/agent-cli@0.5.0")).toBeInTheDocument()
  })

  it("disables the action while work is in flight", () => {
    renderRow({ state: "installing" })
    expect(screen.getByTestId("update-apply-desktop:app")).toBeDisabled()
  })

  it("forwards each action", () => {
    const handlers = renderRow()
    fireEvent.click(screen.getByTestId("update-apply-desktop:app"))
    fireEvent.click(screen.getByTestId("update-skip-desktop:app"))
    fireEvent.click(screen.getByTestId("update-defer-desktop:app"))
    expect(handlers.onApply).toHaveBeenCalledWith("desktop:app")
    expect(handlers.onSkip).toHaveBeenCalledWith("desktop:app")
    expect(handlers.onDefer).toHaveBeenCalledWith("desktop:app")
  })

  it("offers to un-hide a skipped version", () => {
    const handlers = renderRow({ state: "current", candidate: null, skippedVersion: "1.1.0" })
    fireEvent.click(screen.getByTestId("update-clear-hold-desktop:app"))
    expect(handlers.onClearHold).toHaveBeenCalledWith("desktop:app")
  })

  it("labels the state", () => {
    renderRow({ state: "awaiting-restart" })
    expect(screen.getByText("Restart to finish")).toBeInTheDocument()
  })
})
