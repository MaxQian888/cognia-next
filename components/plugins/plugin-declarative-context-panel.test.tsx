/** @jest-environment jsdom */

import React from "react"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { registerPluginI18n, unregisterPluginI18n } from "@/lib/i18n/plugin-i18n-registry"
import type { ContextResource } from "@/types/context-workbench"
import type {
  PluginA2UIContextPanelDef,
  PluginChatContextPanelDef,
} from "@/types/plugin/plugin-context-panel"

const invokePluginTool = jest.fn()
jest.mock("@/lib/plugin/core/invoke-plugin-tool", () => ({
  invokePluginTool: (...args: unknown[]) => invokePluginTool(...args),
}))

jest.mock("@/components/plugins/plugin-surface", () => ({
  PluginSurface: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

jest.mock("@/components/a2ui/a2ui-surface", () => ({
  A2UISurface: ({ surfaceId, className }: { surfaceId: string; className?: string }) => (
    <div data-testid="a2ui-surface" className={className}>
      {surfaceId}
    </div>
  ),
}))

let chatPanelProps: {
  getResourceContext?: () => string | Promise<string>
  selectionHeader?: React.ReactNode
} = {}
jest.mock("@/components/context-workbench/resource-workbench-chat-panel", () => ({
  ResourceWorkbenchChatPanel: (props: {
    getResourceContext?: () => string | Promise<string>
    selectionHeader?: React.ReactNode
  }) => {
    chatPanelProps = props
    return <div data-testid="chat-panel">{props.selectionHeader}</div>
  },
}))

const appended: Array<{ text?: string; sessionId?: string }> = []
jest.mock("@/components/chat/composer", () => ({
  dispatchComposerAppend: (detail: { text?: string; sessionId?: string }) => {
    appended.push(detail)
  },
}))

let selectionText: string | null = null
jest.mock("@/components/chat/message-selection-toolbar", () => ({
  useTranscriptSelection: () =>
    selectionText === null
      ? null
      : {
          text: selectionText,
          rect: { left: 400, top: 180, right: 560, bottom: 200 },
          messageIds: [],
          context: "",
          range: null,
        },
}))

const staged: unknown[] = []
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => ({ addContextSelection: (ref: unknown) => staged.push(ref) }) },
}))

let sessions: Array<{ id: string; title?: string }> = []
jest.mock("@/stores/chat/session-store", () => ({
  useSessionStore: { getState: () => ({ sessions }) },
}))

let artifacts: Record<string, { title?: string }> = {}
let canvasDocuments: Record<string, { title?: string }> = {}
jest.mock("@/stores/artifact", () => ({
  useArtifactStore: { getState: () => ({ artifacts, canvasDocuments }) },
}))

const existingSurfaces = new Set<string>()
jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: (selector: (state: { surfaces: Record<string, unknown> }) => unknown) =>
    selector({
      surfaces: Object.fromEntries([...existingSurfaces].map((id) => [id, {}])),
    }),
}))

import {
  clampSelectionToolbar,
  createA2UIContextPanelRenderer,
  createChatContextPanelRenderer,
  declarativeFirstActivate,
  readToolText,
  resolvePanelSurfaceId,
  selectionTitleForResource,
} from "./plugin-declarative-context-panel"

/**
 * A host string by its English text or its bare key. The jest next-intl mock
 * reads the generated `en.json` aggregate and echoes a key it cannot find, so
 * a key added to the split sources reads as the key until `pnpm i18n:build`
 * regenerates the aggregate — and as the English text afterwards.
 */
function hostText(english: string, key: string): RegExp {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^(${escape(english)}|${escape(key)})$`)
}

const resource: ContextResource = {
  kind: "canvas-document",
  documentId: "doc-1",
  revision: "1",
  capabilities: [],
}

const a2uiDef: PluginA2UIContextPanelDef = {
  id: "reader",
  kind: "a2ui",
  surface: "wiki:{resourceKey}",
  activateTool: "build_surface",
  resourceKinds: ["canvas-document"],
  activity: "inspect",
  labelKey: "panels.reader",
  label: "Wiki",
}

const chatDef: PluginChatContextPanelDef = {
  id: "sidechat",
  kind: "chat",
  contextTool: "wiki_context",
  resourceKinds: ["canvas-document"],
  activity: "inspect",
  labelKey: "panels.sidechat",
  label: "Ask",
}

const renderProps = { workbenchInstanceId: "wb", resource, active: true }

beforeEach(() => {
  invokePluginTool.mockReset()
  existingSurfaces.clear()
  chatPanelProps = {}
  appended.length = 0
  staged.length = 0
  selectionText = null
  sessions = []
  artifacts = {}
  canvasDocuments = {}
})

describe("resolvePanelSurfaceId", () => {
  it("substitutes the resource key so one declaration backs one surface per resource", () => {
    expect(resolvePanelSurfaceId("wiki:{resourceKey}", resource)).toBe("wiki:canvas:doc-1")
  })

  it("leaves a fixed id alone", () => {
    expect(resolvePanelSurfaceId("wiki-overview", resource)).toBe("wiki-overview")
  })
})

describe("readToolText", () => {
  it("accepts both spellings a tool can return", () => {
    expect(readToolText("body")).toBe("body")
    expect(readToolText({ text: "body" })).toBe("body")
  })

  it("drops anything else rather than stringifying it into the prompt", () => {
    // `[object Object]` in a system prompt is worse than no context.
    expect(readToolText({ page: { body: "x" } })).toBe("")
    expect(readToolText(["body"])).toBe("")
    expect(readToolText(null)).toBe("")
    expect(readToolText(42)).toBe("")
  })
})

describe("A2UI panel renderer", () => {
  it("says the surface is pending instead of rendering an empty panel", () => {
    const Panel = createA2UIContextPanelRenderer("wiki-plugin", a2uiDef)
    render(<Panel {...renderProps} />)
    expect(screen.queryByTestId("a2ui-surface")).not.toBeInTheDocument()
    expect(screen.getByText(/waiting for the plugin/i)).toBeInTheDocument()
  })

  it("renders the resolved surface once the plugin has pushed one", () => {
    existingSurfaces.add("wiki:canvas:doc-1")
    const Panel = createA2UIContextPanelRenderer("wiki-plugin", a2uiDef)
    render(<Panel {...renderProps} />)
    expect(screen.getByTestId("a2ui-surface")).toHaveTextContent("wiki:canvas:doc-1")
  })

  it("fills the panel slot instead of the free-standing panel's width and border", () => {
    existingSurfaces.add("wiki:canvas:doc-1")
    const Panel = createA2UIContextPanelRenderer("wiki-plugin", a2uiDef)
    render(<Panel {...renderProps} />)
    const surface = screen.getByTestId("a2ui-surface")
    expect(surface).toHaveClass("h-full", "max-w-none", "border-l-0")
  })
})

describe("a failed build", () => {
  const failing: ContextResource = {
    kind: "canvas-document",
    documentId: "doc-failing",
    revision: "1",
    capabilities: [],
  }

  it("says so and retries the build tool for the same surface", async () => {
    const user = userEvent.setup()
    invokePluginTool.mockRejectedValueOnce(new Error("python host is not running"))
    await declarativeFirstActivate("wiki-plugin", a2uiDef)!(failing)

    const Panel = createA2UIContextPanelRenderer("wiki-plugin", a2uiDef)
    render(<Panel workbenchInstanceId="wb" resource={failing} active />)

    // No more "waiting for the plugin" forever: the failure is the state.
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent(/This panel couldn't be built\.|pluginPanel\.buildFailed/)
    expect(screen.queryByText(/waiting for the plugin/i)).not.toBeInTheDocument()

    invokePluginTool.mockResolvedValueOnce({ result: null })
    await user.click(screen.getByRole("button", { name: hostText("Retry", "pluginPanel.retry") }))

    expect(invokePluginTool).toHaveBeenLastCalledWith("wiki-plugin", "build_surface", {
      resource: failing,
      surfaceId: "wiki:canvas:doc-failing",
    })
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
    expect(screen.getByText(/waiting for the plugin/i)).toBeInTheDocument()
  })

  it("shows the plugin's own error text as the detail", async () => {
    invokePluginTool.mockRejectedValueOnce(new Error("boom"))
    const resource: ContextResource = { ...failing, documentId: "doc-detail" }
    await declarativeFirstActivate("wiki-plugin", a2uiDef)!(resource)

    const Panel = createA2UIContextPanelRenderer("wiki-plugin", a2uiDef)
    render(<Panel workbenchInstanceId="wb" resource={resource} active />)
    expect(
      screen.getByText(hostText("The plugin reported: boom", "pluginPanel.buildFailedDetail"))
    ).toBeInTheDocument()
  })

  it("is scoped to its own surface", async () => {
    invokePluginTool.mockRejectedValueOnce(new Error("boom"))
    await declarativeFirstActivate("wiki-plugin", a2uiDef)!({
      ...failing,
      documentId: "doc-other",
    })

    const Panel = createA2UIContextPanelRenderer("wiki-plugin", a2uiDef)
    render(<Panel {...renderProps} />)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})

describe("declarativeFirstActivate", () => {
  it("invokes the build tool with the resource and the resolved surface id", async () => {
    invokePluginTool.mockResolvedValue({ result: null })
    await declarativeFirstActivate("wiki-plugin", a2uiDef)!(resource)
    expect(invokePluginTool).toHaveBeenCalledWith("wiki-plugin", "build_surface", {
      resource,
      surfaceId: "wiki:canvas:doc-1",
    })
  })

  it("is undefined when the panel declares no build tool", () => {
    expect(
      declarativeFirstActivate("wiki-plugin", { ...a2uiDef, activateTool: undefined })
    ).toBeUndefined()
  })

  it("swallows a failing tool so one broken plugin does not break the workbench", async () => {
    invokePluginTool.mockRejectedValue(new Error("boom"))
    await expect(
      declarativeFirstActivate("wiki-plugin", a2uiDef)!(resource)
    ).resolves.toBeUndefined()
  })
})

describe("chat panel renderer", () => {
  it("resolves the grounding text through the plugin's own tool", async () => {
    invokePluginTool.mockResolvedValue({ result: "the wiki overview" })
    const Panel = createChatContextPanelRenderer("wiki-plugin", chatDef)
    render(<Panel {...renderProps} />)

    await expect(chatPanelProps.getResourceContext!()).resolves.toBe("the wiki overview")
    expect(invokePluginTool).toHaveBeenCalledWith("wiki-plugin", "wiki_context", { resource })
  })

  it("degrades to an ungrounded conversation when the tool fails", async () => {
    invokePluginTool.mockRejectedValue(new Error("boom"))
    const Panel = createChatContextPanelRenderer("wiki-plugin", chatDef)
    render(<Panel {...renderProps} />)
    await act(async () => {
      await expect(chatPanelProps.getResourceContext!()).resolves.toBe("")
    })
  })

  it("says the answer was not grounded instead of failing silently", async () => {
    const user = userEvent.setup()
    invokePluginTool.mockRejectedValueOnce(new Error("boom"))
    const Panel = createChatContextPanelRenderer("wiki-plugin", chatDef)
    render(<Panel {...renderProps} />)
    expect(screen.queryByRole("status")).not.toBeInTheDocument()

    await act(async () => {
      await chatPanelProps.getResourceContext!()
    })
    const notice = screen.getByRole("status")
    expect(notice).toHaveTextContent(
      /The plugin couldn't provide this resource's context|pluginPanel\.contextFailed/
    )

    await user.click(
      screen.getByRole("button", { name: hostText("Dismiss", "pluginPanel.dismiss") })
    )
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("clears the notice once a later send is grounded again", async () => {
    invokePluginTool.mockRejectedValueOnce(new Error("boom"))
    const Panel = createChatContextPanelRenderer("wiki-plugin", chatDef)
    render(<Panel {...renderProps} />)
    await act(async () => {
      await chatPanelProps.getResourceContext!()
    })
    expect(screen.getByRole("status")).toBeInTheDocument()

    invokePluginTool.mockResolvedValueOnce({ result: "the overview" })
    await act(async () => {
      await expect(chatPanelProps.getResourceContext!()).resolves.toBe("the overview")
    })
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("passes no resolver at all when the panel declares no tool", () => {
    const Panel = createChatContextPanelRenderer("wiki-plugin", {
      ...chatDef,
      contextTool: undefined,
    })
    render(<Panel {...renderProps} />)
    // Undefined, not a closure returning "": the chat panel branches on
    // presence to decide whether to prepend a context block at all.
    expect(chatPanelProps.getResourceContext).toBeUndefined()
  })
})

describe("panel selection", () => {
  const sessionResource: ContextResource = {
    kind: "session",
    sessionId: "s-1",
    capabilities: [],
  }

  function renderReader(over: Partial<PluginA2UIContextPanelDef> = {}) {
    existingSurfaces.add("wiki:session:s-1")
    const Panel = createA2UIContextPanelRenderer("wiki-plugin", {
      ...a2uiDef,
      resourceKinds: ["session"],
      ...over,
    })
    return render(<Panel workbenchInstanceId="wb" resource={sessionResource} active />)
  }

  it("offers nothing until there is a selection", () => {
    renderReader()
    expect(screen.queryByRole("button", { name: /Add to chat/i })).not.toBeInTheDocument()
  })

  it("stages a plugin-attributed selection into the main conversation", async () => {
    const user = userEvent.setup()
    sessions = [{ id: "s-1", title: "Design review" }]
    selectionText = "the reverse RPC channel"
    renderReader({ selectionLabel: "wiki page" })

    await user.click(screen.getByRole("button", { name: /Add to chat/i }))

    // Attribution is the host's to stamp: a plugin cannot claim another
    // plugin's name, and the chip has to say where the excerpt came from —
    // by the resource's title, not its internal address.
    expect(staged).toEqual([
      {
        kind: "plugin",
        pluginId: "wiki-plugin",
        sourceLabel: "wiki page",
        title: "Design review",
        ref: "session:s-1",
        snapshot: "the reverse RPC channel",
        comment: "",
      },
    ])
  })

  it("keeps two panels' selections distinct even when their titles match", async () => {
    // The chip shows a file name; the address that identifies the reference
    // stays the resource key, so two README.md files are two references.
    const user = userEvent.setup()
    existingSurfaces.add("wiki:project:p:r:a/README.md")
    existingSurfaces.add("wiki:project:p:r:b/README.md")
    const Panel = createA2UIContextPanelRenderer("wiki-plugin", {
      ...a2uiDef,
      resourceKinds: ["project-file"],
    })
    const file = (relPath: string): ContextResource => ({
      kind: "project-file",
      projectId: "p",
      rootId: "r",
      relPath,
      contentHash: "h",
      draftVersion: 0,
      capabilities: [],
    })
    selectionText = "install steps"
    const first = render(<Panel workbenchInstanceId="wb" resource={file("a/README.md")} active />)
    await user.click(screen.getByRole("button", { name: /Add to chat/i }))
    first.unmount()
    render(<Panel workbenchInstanceId="wb" resource={file("b/README.md")} active />)
    await user.click(screen.getByRole("button", { name: /Add to chat/i }))

    const refs = staged as Array<{ title: string; ref: string }>
    expect(refs.map((ref) => ref.title)).toEqual(["README.md", "README.md"])
    expect(refs.map((ref) => ref.ref)).toEqual([
      "project:p:r:a/README.md",
      "project:p:r:b/README.md",
    ])
  })

  it("falls back to the panel's own label when it names no selection label", async () => {
    const user = userEvent.setup()
    selectionText = "some prose"
    renderReader()
    await user.click(screen.getByRole("button", { name: /Add to chat/i }))
    expect((staged[0] as { sourceLabel: string }).sourceLabel).toBe("Wiki")
  })

  it("resolves that fallback through the plugin's labelKey", async () => {
    const user = userEvent.setup()
    registerPluginI18n({
      pluginId: "wiki-plugin",
      messages: { en: { "plugin.wiki-plugin.panels.reader": "Wiki reader (localized)" } },
    })
    try {
      selectionText = "some prose"
      renderReader()
      await user.click(screen.getByRole("button", { name: /Add to chat/i }))
      expect((staged[0] as { sourceLabel: string }).sourceLabel).toBe("Wiki reader (localized)")
    } finally {
      unregisterPluginI18n("wiki-plugin")
    }
  })

  it("is a labelled toolbar with touch-sized buttons", () => {
    selectionText = "some prose"
    renderReader()
    const toolbar = screen.getByRole("toolbar", {
      name: hostText("Selection actions", "pluginPanel.selectionToolbar"),
    })
    for (const button of Array.from(toolbar.querySelectorAll("button"))) {
      // 36px on touch, compact from `sm` up.
      expect(button).toHaveClass("h-9", "sm:h-7")
    }
  })

  it("is dismissed by Escape for the current selection", async () => {
    const user = userEvent.setup()
    const removeAllRanges = jest.fn()
    const getSelection = jest
      .spyOn(window, "getSelection")
      .mockReturnValue({ removeAllRanges } as unknown as Selection)
    try {
      selectionText = "some prose"
      renderReader()
      expect(screen.getByRole("toolbar")).toBeInTheDocument()

      await user.keyboard("{Escape}")

      expect(screen.queryByRole("toolbar")).not.toBeInTheDocument()
      expect(removeAllRanges).toHaveBeenCalled()
    } finally {
      getSelection.mockRestore()
    }
  })

  it("quotes the selection into the resource's own side chat, un-sent", async () => {
    const user = userEvent.setup()
    selectionText = "first line\nsecond line"
    renderReader()

    await user.click(screen.getByRole("button", { name: /Ask here/i }))

    // Quoted, and left in the composer: the selection is the subject, not yet
    // the question. Addressed to the resource's workbench session so it lands
    // in the side chat rather than in whatever conversation happens to be
    // focused.
    expect(appended).toEqual([
      { text: "> first line\n> second line\n\n", sessionId: "resource-workbench:session:s-1" },
    ])
    expect(staged).toEqual([])
  })
})

describe("selectionTitleForResource", () => {
  it("names a project file by its file name", () => {
    expect(
      selectionTitleForResource({
        kind: "project-file",
        projectId: "p",
        rootId: "r",
        relPath: "src/lib/engine.py",
        contentHash: "h",
        draftVersion: 0,
        capabilities: [],
      })
    ).toBe("engine.py")
  })

  it("names a conversation, artifact or canvas document by its title", () => {
    sessions = [{ id: "s-1", title: "Design review" }]
    artifacts = { a1: { title: "Launch plan" } }
    canvasDocuments = { doc: { title: "Spec draft" } }
    expect(selectionTitleForResource({ kind: "session", sessionId: "s-1", capabilities: [] })).toBe(
      "Design review"
    )
    expect(
      selectionTitleForResource({
        kind: "artifact",
        artifactId: "a1",
        version: "1",
        capabilities: [],
      })
    ).toBe("Launch plan")
    expect(
      selectionTitleForResource({
        kind: "canvas-document",
        documentId: "doc",
        revision: "1",
        capabilities: [],
      })
    ).toBe("Spec draft")
  })

  it("falls back to the resource key only when the host has no name for it", () => {
    expect(
      selectionTitleForResource({ kind: "session", sessionId: "gone", capabilities: [] })
    ).toBe("session:gone")
  })
})

describe("clampSelectionToolbar", () => {
  const bounds = { left: 100, top: 0, right: 500, bottom: 400 }
  const size = { width: 120, height: 36 }

  it("centres under the selection when there is room", () => {
    expect(
      clampSelectionToolbar({ left: 250, top: 100, right: 350, bottom: 120 }, size, bounds)
    ).toEqual({ left: 240, top: 128 })
  })

  it("keeps the right edge inside the panel", () => {
    const { left } = clampSelectionToolbar(
      { left: 470, top: 100, right: 499, bottom: 120 },
      size,
      bounds
    )
    expect(left + size.width).toBeLessThanOrEqual(bounds.right - 8)
  })

  it("keeps the left edge inside the panel", () => {
    const { left } = clampSelectionToolbar(
      { left: 100, top: 100, right: 110, bottom: 120 },
      size,
      bounds
    )
    expect(left).toBe(bounds.left + 8)
  })

  it("flips above the selection when there is no room below", () => {
    const { top } = clampSelectionToolbar(
      { left: 250, top: 370, right: 350, bottom: 390 },
      size,
      bounds
    )
    expect(top).toBe(370 - 8 - size.height)
  })

  it("stays inside the bottom edge when it can go neither above nor below", () => {
    const { top } = clampSelectionToolbar({ left: 250, top: 10, right: 350, bottom: 390 }, size, {
      ...bounds,
      bottom: 420,
    })
    expect(top + size.height).toBeLessThanOrEqual(420 - 8)
    expect(top).toBeGreaterThanOrEqual(8)
  })

  it("pins to the start edge when the panel is narrower than the toolbar", () => {
    expect(
      clampSelectionToolbar(
        { left: 110, top: 10, right: 130, bottom: 30 },
        { width: 400, height: 36 },
        { left: 100, top: 0, right: 300, bottom: 400 }
      ).left
    ).toBe(108)
  })
})
