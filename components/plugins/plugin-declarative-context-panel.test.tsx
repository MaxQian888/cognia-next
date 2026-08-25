/** @jest-environment jsdom */

import React from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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
  A2UISurface: ({ surfaceId }: { surfaceId: string }) => (
    <div data-testid="a2ui-surface">{surfaceId}</div>
  ),
}))

let chatPanelProps: { getResourceContext?: () => string | Promise<string> } = {}
jest.mock("@/components/context-workbench/resource-workbench-chat-panel", () => ({
  ResourceWorkbenchChatPanel: (props: { getResourceContext?: () => string | Promise<string> }) => {
    chatPanelProps = props
    return <div data-testid="chat-panel" />
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
    selectionText === null ? null : { text: selectionText, x: 400, y: 200 },
}))

const staged: unknown[] = []
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => ({ addContextSelection: (ref: unknown) => staged.push(ref) }) },
}))

const existingSurfaces = new Set<string>()
jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: (selector: (state: { surfaces: Record<string, unknown> }) => unknown) =>
    selector({
      surfaces: Object.fromEntries([...existingSurfaces].map((id) => [id, {}])),
    }),
}))

import {
  createA2UIContextPanelRenderer,
  createChatContextPanelRenderer,
  declarativeFirstActivate,
  readToolText,
  resolvePanelSurfaceId,
} from "./plugin-declarative-context-panel"

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
    await expect(chatPanelProps.getResourceContext!()).resolves.toBe("")
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
    selectionText = "the reverse RPC channel"
    renderReader({ selectionLabel: "wiki page" })

    await user.click(screen.getByRole("button", { name: /Add to chat/i }))

    // Attribution is the host's to stamp: a plugin cannot claim another
    // plugin's name, and the chip has to say where the excerpt came from.
    expect(staged).toEqual([
      {
        kind: "plugin",
        pluginId: "wiki-plugin",
        sourceLabel: "wiki page",
        title: "session:s-1",
        snapshot: "the reverse RPC channel",
        comment: "",
      },
    ])
  })

  it("falls back to the panel's own label when it names no selection label", async () => {
    const user = userEvent.setup()
    selectionText = "some prose"
    renderReader()
    await user.click(screen.getByRole("button", { name: /Add to chat/i }))
    expect((staged[0] as { sourceLabel: string }).sourceLabel).toBe("Wiki")
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
