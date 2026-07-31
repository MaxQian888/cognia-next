/**
 * Canonical app-session Inspector behavior.
 */

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))

jest.mock("@/lib/automation/client", () => ({
  desktop: {
    capabilities: jest.fn(),
    listApps: jest.fn(),
    getAppState: jest.fn(),
    queryElements: jest.fn(),
    expandElement: jest.fn(),
    performAction: jest.fn(),
  },
}))

import "@testing-library/jest-dom"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { desktop } from "@/lib/automation/client"
import type { UiStateRevision, UiTreeNode } from "@/lib/automation/types"
import { InspectorTab } from "./inspector-tab"

const mockedDesktop = desktop as jest.Mocked<typeof desktop>

const app = {
  bundleId: "com.apple.TextEdit",
  path: "/System/Applications/TextEdit.app",
  displayName: "TextEdit",
  processId: 42,
}

const node: UiTreeNode = {
  handle: {
    sessionId: "settings:automation-inspector",
    lineageId: "lineage-1",
    revision: 1,
    index: 0,
    fingerprint: "button:save",
  },
  parentIndex: null,
  element: {
    elementRef: ["ax:save"] as never,
    name: "Save",
    automationId: "save",
    controlType: "AXButton",
    className: "NSButton",
    boundingRect: { x: 110, y: 220, width: 80, height: 30 },
    isEnabled: true,
    isFocused: false,
    processId: 42,
    processName: "TextEdit",
    windowTitle: "Document",
    children: null,
  },
}

function state(revision = 1): UiStateRevision {
  return {
    sessionId: "settings:automation-inspector",
    lineageId: "lineage-1",
    revision,
    turnToken: `turn-${revision}`,
    app,
    surface: {
      windowId: 7,
      displayId: "main",
      logicalBounds: { x: 100, y: 200, width: 800, height: 600 },
      pixelWidth: 1600,
      pixelHeight: 1200,
      scaleFactor: 2,
      coordinateSpace: "screenshotPixels",
    },
    screenshot: {
      bytes: "AA==",
      width: 1600,
      height: 1200,
      capturedAt: 1,
      format: "png",
    },
    projection: "inspector",
    tree: {
      nodes: revision === 1 ? [node] : [],
      totalNodes: revision === 1 ? 1 : 0,
      truncated: false,
    },
    diff:
      revision === 1
        ? null
        : {
            fromRevision: 1,
            toRevision: 2,
            added: [],
            removed: ["button:save"],
            updated: [],
          },
    truncation: [],
    instructionPack: null,
    capturedAt: revision,
  }
}

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={{}} timeZone="UTC">
      <InspectorTab />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockedDesktop.capabilities.mockResolvedValue({
    platform: "macos",
    hasUia: false,
    hasInputSim: true,
    hasScreenshot: true,
    hasEvents: true,
    hasA11yTree: true,
    monitors: [],
  })
  mockedDesktop.listApps.mockResolvedValue([app])
})

describe("InspectorTab canonical app sessions", () => {
  it("lists applications and requests the inspector projection", async () => {
    mockedDesktop.getAppState.mockResolvedValue(state())
    mount()
    const user = userEvent.setup()

    await user.click(await screen.findByRole("button", { name: /capture state/i }))

    expect(mockedDesktop.getAppState).toHaveBeenCalledWith(
      "settings:automation-inspector",
      { kind: "bundleId", bundleId: "com.apple.TextEdit" },
      { projection: "inspector", maxNodes: 25_000 },
      expect.objectContaining({
        surface: "workflow",
        sessionKey: "settings:automation-inspector",
      })
    )
    expect(await screen.findByText("Save")).toBeInTheDocument()
    expect(screen.getByRole("img", { name: /captured application window/i })).toHaveAttribute(
      "src",
      "data:image/png;base64,AA=="
    )
  })

  it("queries the current revision through the canonical query API", async () => {
    mockedDesktop.getAppState.mockResolvedValue(state())
    mockedDesktop.queryElements.mockResolvedValue([node])
    mount()
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: /capture state/i }))

    await user.type(screen.getByPlaceholderText(/query element name/i), "Save")
    await user.click(screen.getByRole("button", { name: /query elements/i }))

    await waitFor(() =>
      expect(mockedDesktop.queryElements).toHaveBeenCalledWith(
        {
          sessionId: "settings:automation-inspector",
          lineageId: "lineage-1",
          revision: 1,
        },
        { nameContains: "Save" },
        1000,
        expect.any(Object)
      )
    )
  })

  it("binds semantic actions to the selected handle and reads a fresh revision afterward", async () => {
    mockedDesktop.getAppState.mockResolvedValueOnce(state(1)).mockResolvedValueOnce(state(2))
    mockedDesktop.performAction.mockResolvedValue({
      status: "delivered",
      method: "ax",
      beforeRevision: 1,
      afterRevision: 2,
      evidence: [{ kind: "treeChanged", message: "button removed", revision: 2 }],
      policyDecision: { allowed: true, reason: null },
      durationMs: 12,
    })
    mount()
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: /capture state/i }))
    await user.click(await screen.findByText("Save"))
    await user.click(screen.getByRole("button", { name: /test semantic click/i }))

    await waitFor(() =>
      expect(mockedDesktop.performAction).toHaveBeenCalledWith(
        {
          turnToken: "turn-1",
          target: { kind: "element", handle: node.handle },
          action: { kind: "click" },
          strategy: "semantic",
        },
        expect.any(Object)
      )
    )
    await waitFor(() => expect(mockedDesktop.getAppState).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/stale handle/i)).toBeInTheDocument()
  })
})
