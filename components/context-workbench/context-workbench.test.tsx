import { act, fireEvent, render, screen } from "@testing-library/react"
import { useEffect } from "react"
import { NextIntlClientProvider } from "next-intl"
import type { ContextPanelDefinition, ContextResource } from "@/types/context-workbench"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import {
  ContextWorkbench,
  ContextWorkbenchMobileSheet,
  useContextWorkbench,
} from "./context-workbench"

let mockResourceSession: { id: string } | null = null
const mockUseResourceWorkbenchSession = jest.fn(
  (_resource?: unknown, _enabled?: boolean, _instanceId?: string) => mockResourceSession
)

jest.mock("@/hooks/chat/use-resource-workbench-session", () => ({
  useResourceWorkbenchSession: (...args: unknown[]) => mockUseResourceWorkbenchSession(...args),
}))

const resource: ContextResource = {
  kind: "canvas-document",
  documentId: "doc-1",
  revision: "1",
  capabilities: ["comments"],
}

const messages = {
  contextWorkbench: {
    actions: {
      collapse: "Collapse",
      narrow: "Narrow",
      wide: "Wide",
      focus: "Focus",
      pin: "Pin",
      resize: "Resize",
      unpin: "Unpin",
    },
    panelError: "Panel failed",
    panelErrorDescription: "The panel crashed without affecting the editor.",
    mobileTitle: "Context Workbench",
    mobileDescription: "Resource tools",
    panels: {
      comments: "Comments",
      commentsTwo: "Comments two",
      crash: "Crash",
      review: "Review",
      ai: "AI",
      gated: "Gated",
    },
    activityRailLabel: "Activities",
    aiLoading: "Loading",
  },
}

function renderWorkbench(panels: ContextPanelDefinition[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ContextWorkbench
        workbenchInstanceId="window-a"
        resource={resource}
        panels={panels}
        grantedPermissions={new Set()}
      />
    </NextIntlClientProvider>
  )
}

describe("ContextWorkbench", () => {
  beforeEach(() => {
    useContextWorkbenchStore.setState({ layouts: {} })
    mockResourceSession = null
    mockUseResourceWorkbenchSession.mockClear()
  })

  it("retains its stable resource layout across unmounts", () => {
    const Comments = ({ active }: { active: boolean }) => <div>comments:{String(active)}</div>
    const { unmount } = renderWorkbench([
      {
        id: "comments",
        activity: "comments",
        labelKey: "contextWorkbench.panels.comments",
        appliesTo: () => true,
        renderer: Comments,
        retention: "stateful",
      },
    ])
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.comments" }))
    const scopeKey = "window-a::canvas:doc-1"
    expect(useContextWorkbenchStore.getState().layouts[scopeKey]).toBeDefined()

    act(() => unmount())
    expect(useContextWorkbenchStore.getState().layouts[scopeKey]).toBeDefined()
  })

  it("uses a vertical activity rail and activates a stateful panel only once", () => {
    const onFirstActivate = jest.fn()
    const onRestore = jest.fn()
    const Comments = ({ active }: { active: boolean }) => <div>comments:{String(active)}</div>
    renderWorkbench([
      {
        id: "comments",
        activity: "comments",
        labelKey: "contextWorkbench.panels.comments",
        appliesTo: () => true,
        renderer: Comments,
        retention: "stateful",
        onFirstActivate,
        onRestore,
      },
    ])

    const rail = screen.getByTestId("context-workbench-activity-rail")
    expect(rail).toHaveClass("flex-col")
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.comments" }))
    fireEvent.click(screen.getByRole("button", { name: /Collapse/ }))
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.comments" }))

    expect(onFirstActivate).toHaveBeenCalledTimes(1)
    expect(onRestore).toHaveBeenCalledTimes(1)
    expect(screen.getByText("comments:true")).toBeInTheDocument()
  })

  it("throws when panel code reads context outside its provider", () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined)
    const Consumer = () => {
      useContextWorkbench()
      return null
    }
    expect(() => render(<Consumer />)).toThrow("useContextWorkbench")
    consoleError.mockRestore()
  })

  it("renders group tabs, aggregate badges, ephemeral lifecycle, pinning, and resizing", () => {
    const onCollapse = jest.fn()
    const First = () => <div>first-panel</div>
    const Second = () => <div>second-panel</div>
    const Review = () => <div>review-panel</div>
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbench
          workbenchInstanceId="controls-a"
          resource={resource}
          onCollapse={onCollapse}
          panels={[
            {
              id: "comments",
              activity: "comments",
              labelKey: "contextWorkbench.panels.comments",
              appliesTo: () => true,
              getBadge: () => 100,
              renderer: First,
              retention: "ephemeral",
            },
            {
              id: "comments-two",
              activity: "comments",
              labelKey: "contextWorkbench.panels.commentsTwo",
              appliesTo: () => true,
              getBadge: () => 20,
              renderer: Second,
              retention: "ephemeral",
            },
            {
              id: "review",
              activity: "review",
              labelKey: "contextWorkbench.panels.review",
              appliesTo: () => true,
              renderer: Review,
            },
          ]}
        />
      </NextIntlClientProvider>
    )

    expect(screen.getByText("99+")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.comments" }))
    const groupTabs = screen
      .getByTestId("context-workbench")
      .querySelectorAll("header button[data-workbench-group-tab]")
    expect(groupTabs).toHaveLength(2)
    expect(groupTabs[0]).toHaveClass("min-w-0", "shrink-0", "overflow-hidden")
    expect(groupTabs[1]).toHaveClass("min-w-0", "shrink", "overflow-hidden")
    expect(groupTabs[0].firstElementChild).toHaveClass("truncate")
    expect(groupTabs[1].firstElementChild).toHaveClass("truncate")
    fireEvent.click(screen.getByRole("tab", { name: "contextWorkbench.panels.commentsTwo" }))
    expect(screen.getByText("second-panel")).toBeInTheDocument()
    expect(screen.queryByText("first-panel")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.review" }))
    expect(screen.queryByText("second-panel")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Pin panel" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Pin panel" }))
    expect(screen.getByRole("button", { name: "Unpin panel" })).toBeInTheDocument()
    fireEvent(
      screen.getByRole("separator", { name: "Resize workbench" }),
      new MouseEvent("pointerdown", { bubbles: true, clientX: 500 })
    )
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 400 }))
      window.dispatchEvent(new MouseEvent("pointerup"))
    })
    expect(screen.getByTestId("context-workbench")).toHaveStyle({ width: "460px" })
    fireEvent.click(screen.getByRole("button", { name: "Collapse workbench" }))
    expect(onCollapse).toHaveBeenCalledTimes(1)
  })

  it("isolates a crashing plugin panel", () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined)
    const Crash = () => {
      throw new Error("boom")
    }
    renderWorkbench([
      {
        id: "crash",
        activity: "inspect",
        labelKey: "contextWorkbench.panels.crash",
        appliesTo: () => true,
        renderer: Crash,
        pluginId: "plugin-a",
      },
    ])

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.crash" }))
    expect(screen.getByText(/Panel (failed|unavailable)/)).toBeInTheDocument()
    consoleError.mockRestore()
  })

  it("force-mounts the closed mobile sheet while disabling focus and interaction", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbenchMobileSheet
          open={false}
          onOpenChange={jest.fn()}
          workbenchInstanceId="mobile-a"
          resource={resource}
          panels={[]}
        />
      </NextIntlClientProvider>
    )
    const sheet = screen.getByTestId("context-workbench-mobile-sheet")
    expect(sheet).toHaveAttribute("inert")
    expect(sheet).toHaveAttribute("aria-hidden", "true")
    expect(screen.queryByRole("button", { name: "Wide" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Focus" })).not.toBeInTheDocument()
  })

  it("pauses mobile panel effects while the force-mounted Sheet is closed", () => {
    const mounted = jest.fn()
    const cleanedUp = jest.fn()
    const MobilePanel = () => {
      useEffect(() => {
        mounted()
        return cleanedUp
      }, [])
      return <div>mobile-panel</div>
    }
    const panel: ContextPanelDefinition = {
      id: "comments",
      activity: "comments",
      labelKey: "contextWorkbench.panels.comments",
      appliesTo: () => true,
      retention: "stateful",
      renderer: MobilePanel,
    }
    const view = render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbenchMobileSheet
          open
          onOpenChange={jest.fn()}
          workbenchInstanceId="mobile-effects"
          resource={resource}
          panels={[panel]}
        />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.comments" }))
    expect(mounted).toHaveBeenCalledTimes(1)

    view.rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbenchMobileSheet
          open={false}
          onOpenChange={jest.fn()}
          workbenchInstanceId="mobile-effects"
          resource={resource}
          panels={[panel]}
        />
      </NextIntlClientProvider>
    )
    expect(screen.getByTestId("context-workbench-mobile-sheet")).toBeInTheDocument()
    expect(cleanedUp).toHaveBeenCalledTimes(1)
  })

  it("keeps the editor mounted but inert in Focus and restores focus on exit", () => {
    const onExitFocus = jest.fn()
    const panel: ContextPanelDefinition = {
      id: "comments",
      activity: "comments",
      labelKey: "contextWorkbench.panels.comments",
      appliesTo: () => true,
      renderer: () => <div>panel</div>,
    }
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <div>
          <button type="button">Editor</button>
          <ContextWorkbench
            workbenchInstanceId="focus-a"
            resource={resource}
            panels={[panel]}
            onExitFocus={onExitFocus}
          />
        </div>
      </NextIntlClientProvider>
    )
    const editor = screen.getByRole("button", { name: "Editor" })
    editor.focus()
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.comments" }))
    fireEvent.click(screen.getByRole("button", { name: /Focus/ }))
    expect(editor).toHaveAttribute("inert")
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true")
    fireEvent.click(screen.getByRole("button", { name: /Narrow/ }))
    expect(editor).not.toHaveAttribute("inert")
    expect(onExitFocus).toHaveBeenCalledTimes(1)
    expect(editor).toHaveFocus()
  })

  it("waits for an AI chat scope and renders it after the embedded session resolves", () => {
    const panel: ContextPanelDefinition = {
      id: "ai",
      activity: "ai",
      labelKey: "contextWorkbench.panels.ai",
      appliesTo: () => true,
      requiresChatScope: true,
      renderer: () => <div>scoped-ai-panel</div>,
    }
    const view = renderWorkbench([panel])
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.ai" }))
    expect(screen.queryByText("scoped-ai-panel")).not.toBeInTheDocument()

    mockResourceSession = { id: "embedded-session" }
    view.rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbench
          workbenchInstanceId="window-a"
          resource={resource}
          panels={[panel]}
          grantedPermissions={new Set()}
        />
      </NextIntlClientProvider>
    )
    expect(screen.getByText("scoped-ai-panel")).toBeInTheDocument()
  })

  it("creates the embedded chat session only when a scoped AI panel is activated", () => {
    renderWorkbench([
      {
        id: "ai-actions",
        activity: "ai",
        labelKey: "contextWorkbench.panels.ai",
        appliesTo: () => true,
        renderer: () => <div>AI actions</div>,
      },
      {
        id: "resource-chat",
        activity: "ai",
        labelKey: "contextWorkbench.panels.gated",
        appliesTo: () => true,
        requiresChatScope: true,
        renderer: () => <div>Resource chat</div>,
      },
    ])

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.ai" }))
    expect(mockUseResourceWorkbenchSession).toHaveBeenLastCalledWith(resource, false, "window-a")

    fireEvent.click(screen.getByRole("tab", { name: "contextWorkbench.panels.gated" }))
    expect(mockUseResourceWorkbenchSession).toHaveBeenLastCalledWith(resource, true, "window-a")
  })

  it("restores a persisted scoped AI panel together with its embedded session", () => {
    const onRestore = jest.fn()
    useContextWorkbenchStore.setState({
      layouts: {
        "window-a::canvas:doc-1": {
          mode: "narrow",
          width: 360,
          activePanelId: "resource-chat",
          userPinned: true,
          activatedPanelIds: ["resource-chat"],
          pendingPanelIds: [],
          lastUsedAt: Date.now(),
        },
      },
    })
    renderWorkbench([
      {
        id: "resource-chat",
        activity: "ai",
        labelKey: "contextWorkbench.panels.ai",
        appliesTo: () => true,
        requiresChatScope: true,
        onRestore,
        renderer: () => <div>Resource chat</div>,
      },
    ])

    expect(mockUseResourceWorkbenchSession).toHaveBeenLastCalledWith(resource, true, "window-a")
    expect(onRestore).toHaveBeenCalledWith(resource)
  })

  it("filters native panels by resource capabilities and granted permissions", () => {
    renderWorkbench([
      {
        id: "missing-capability",
        activity: "inspect",
        labelKey: "contextWorkbench.panels.gated",
        appliesTo: () => true,
        requiredCapabilities: ["run"],
        renderer: () => <div>missing-capability</div>,
      },
      {
        id: "missing-permission",
        activity: "review",
        labelKey: "contextWorkbench.panels.review",
        appliesTo: () => true,
        requiredPermissions: ["project:read"],
        renderer: () => <div>missing-permission</div>,
      },
    ])

    expect(screen.queryByRole("button", { name: "contextWorkbench.panels.gated" })).toBeNull()
    expect(screen.queryByRole("button", { name: "contextWorkbench.panels.review" })).toBeNull()
  })

  it("pauses stateful panel effects while hidden and restores them when visible", () => {
    const mounted = jest.fn()
    const cleanedUp = jest.fn()
    const StatefulPanel = () => {
      useEffect(() => {
        mounted()
        return cleanedUp
      }, [])
      return <div>stateful-panel</div>
    }
    renderWorkbench([
      {
        id: "comments",
        activity: "comments",
        labelKey: "contextWorkbench.panels.comments",
        appliesTo: () => true,
        retention: "stateful",
        renderer: StatefulPanel,
      },
      {
        id: "review",
        activity: "review",
        labelKey: "contextWorkbench.panels.review",
        appliesTo: () => true,
        retention: "stateful",
        renderer: () => <div>review-panel</div>,
      },
    ])

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.comments" }))
    expect(mounted).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.review" }))
    expect(cleanedUp).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.comments" }))
    expect(mounted).toHaveBeenCalledTimes(2)
  })
})
