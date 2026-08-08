/** @jest-environment jsdom */

jest.mock("@/lib/automation/client", () => ({
  desktop: {
    getFocus: jest.fn(),
    getAppState: jest.fn(),
  },
}))

jest.mock("@/lib/capture/capture-manager", () => ({
  detectSourceApp: jest.fn(),
}))

import {
  accessibilityMarkdown,
  buildSmartSnapshotFiles,
  captureSmartSnapshotFiles,
  SmartSnapshotError,
} from "./smart-snapshot"
import { elementRef, type UiStateRevision, type UiTreeNode } from "@/lib/automation/types"
import { desktop } from "@/lib/automation/client"
import { detectSourceApp } from "@/lib/capture/capture-manager"

const desktopMock = desktop as jest.Mocked<typeof desktop>
const detectSourceAppMock = detectSourceApp as jest.Mock

function node(
  index: number,
  parentIndex: number | null,
  name: string | null,
  controlType: string | null
): UiTreeNode {
  return {
    handle: {
      sessionId: "s",
      lineageId: "l",
      revision: 1,
      index,
      fingerprint: `n${index}`,
    },
    parentIndex,
    element: {
      elementRef: elementRef(`e${index}`),
      name,
      automationId: null,
      controlType,
      className: null,
      boundingRect: null,
      isEnabled: true,
      isFocused: false,
      processId: 10,
      processName: "Safari",
      windowTitle: "Docs",
      children: null,
    },
  }
}

function state(overrides: Partial<UiStateRevision> = {}): UiStateRevision {
  return {
    sessionId: "s",
    lineageId: "l",
    revision: 1,
    turnToken: "turn",
    app: { bundleId: "com.apple.Safari", path: null, displayName: "Safari", processId: 10 },
    surface: {
      windowId: null,
      displayId: "1",
      logicalBounds: { x: 0, y: 0, width: 640, height: 480 },
      pixelWidth: 640,
      pixelHeight: 480,
      scaleFactor: 1,
      coordinateSpace: "screenshotPixels",
    },
    screenshot: {
      bytes: btoa("png-bytes"),
      width: 640,
      height: 480,
      capturedAt: 1_700_000_000_000,
      format: "png",
    },
    projection: "model",
    tree: {
      nodes: [node(0, null, "Docs", "window"), node(1, 0, "Submit", "button")],
      totalNodes: 2,
      truncated: false,
    },
    diff: null,
    truncation: [],
    instructionPack: null,
    capturedAt: 1_700_000_000_000,
    ...overrides,
  }
}

async function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ""))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}

describe("smart snapshot attachments", () => {
  beforeEach(() => {
    desktopMock.getFocus.mockReset()
    desktopMock.getAppState.mockReset()
    detectSourceAppMock.mockReset()
  })

  it("formats the accessibility projection without duplicating repeated labels", () => {
    const s = state({
      tree: {
        nodes: [
          node(0, null, "Docs", "window"),
          node(1, 0, "Submit", "button"),
          node(2, 0, "Submit", "button"),
        ],
        totalNodes: 3,
        truncated: false,
      },
    })

    const formatted = accessibilityMarkdown(s)

    expect(formatted.markdown).toContain("- [window] Docs")
    expect(formatted.markdown).toContain("  - [button] Submit")
    expect(formatted.markdown.match(/Submit/g)).toHaveLength(1)
    expect(formatted.truncated).toBe(false)
  })

  it("builds an image attachment plus a markdown context attachment from one app-state capture", async () => {
    const result = buildSmartSnapshotFiles(state())

    expect(result.appName).toBe("Safari")
    expect(result.files).toHaveLength(2)
    expect(result.files[0].type).toBe("image/png")
    expect(result.files[0].name).toMatch(/^smart-snapshot-Safari-/)
    expect(result.files[1].type).toBe("text\/markdown")
    const markdown = await readFileText(result.files[1])
    expect(markdown).toContain("# Smart snapshot")
    expect(markdown).toContain("[button] Submit")
  })

  it("keeps text context when the backend cannot provide a screenshot", () => {
    const result = buildSmartSnapshotFiles(state({ screenshot: null }))

    expect(result.files).toHaveLength(1)
    expect(result.files[0].type).toBe("text/markdown")
  })

  it("captures the focused app through the existing desktop app-state transport", async () => {
    desktopMock.getFocus.mockResolvedValueOnce({
      ...node(0, null, "Safari", "window").element,
      processName: "Safari",
    })
    desktopMock.getAppState.mockResolvedValueOnce(state())

    const result = await captureSmartSnapshotFiles()

    expect(result.files).toHaveLength(2)
    expect(desktopMock.getAppState).toHaveBeenCalledWith(
      expect.stringMatching(/^smart-snapshot-/),
      { kind: "displayName", displayName: "Safari" },
      {
        disableDiff: true,
        maxDepth: 12,
        maxNodes: 600,
        projection: "model",
      },
      { surface: "workflow" }
    )
    expect(detectSourceAppMock).not.toHaveBeenCalled()
  })

  it("falls back to frontmost app detection when focus lacks a process name", async () => {
    desktopMock.getFocus.mockResolvedValueOnce({
      ...node(0, null, "Docs", "window").element,
      processName: null,
    })
    detectSourceAppMock.mockResolvedValueOnce("Notes")
    desktopMock.getAppState.mockResolvedValueOnce(
      state({ app: { ...state().app, displayName: "Notes" } })
    )

    const result = await captureSmartSnapshotFiles()

    expect(result.appName).toBe("Notes")
    expect(desktopMock.getAppState).toHaveBeenCalledWith(
      expect.any(String),
      { kind: "displayName", displayName: "Notes" },
      expect.any(Object),
      { surface: "workflow" }
    )
  })

  it("fails before app-state capture when no focused application can be resolved", async () => {
    desktopMock.getFocus.mockResolvedValueOnce({
      ...node(0, null, "Docs", "window").element,
      processName: null,
    })
    detectSourceAppMock.mockResolvedValueOnce(null)

    await expect(captureSmartSnapshotFiles()).rejects.toMatchObject({
      code: "no-focused-app",
    } satisfies Partial<SmartSnapshotError>)
    expect(desktopMock.getAppState).not.toHaveBeenCalled()
  })
})
