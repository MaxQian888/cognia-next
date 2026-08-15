import { readFileSync } from "node:fs"
import { join } from "node:path"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { useEffect, useState } from "react"
import { NextIntlClientProvider } from "next-intl"
import type { ContextPanelDefinition, ContextResource } from "@/types/context-workbench"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  ContextWorkbench,
  ContextWorkbenchMobileDrawer,
  useContextWorkbench,
} from "./context-workbench"
import {
  clearAllMockExtensions,
  registerMockExtension,
} from "@/components/plugins/test-utils/register-mock-extension"

let mockResourceSession: { id: string } | null = null
const mockUseResourceWorkbenchSession = jest.fn(
  (_resource?: unknown, _enabled?: boolean, _instanceId?: string) => mockResourceSession
)

jest.mock("@/hooks/chat/use-resource-workbench-session", () => ({
  useResourceWorkbenchSession: (...args: unknown[]) => mockUseResourceWorkbenchSession(...args),
}))

// jsdom has no layout, so dnd-kit's collision detection never resolves an
// `over` target and a real drag ends as a no-op. Capture the `onDragEnd` the
// DndContext installs so the inline-reorder path can be tested synthetically.
let lastDragEnd: ((event: unknown) => void) | undefined
jest.mock("@dnd-kit/core", () => {
  const actual = jest.requireActual<typeof import("@dnd-kit/core")>("@dnd-kit/core")
  return {
    ...actual,
    DndContext: ({
      children,
      onDragEnd,
    }: {
      children: React.ReactNode
      onDragEnd: (event: unknown) => void
    }) => {
      lastDragEnd = onDragEnd
      return <>{children}</>
    },
  }
})

jest.mock("@/components/shell/shell-layout-dialog", () => ({
  ShellLayoutDialog: ({ open, surface }: { open: boolean; surface: string }) =>
    open ? <div data-testid={`shell-layout-dialog-${surface}`} /> : null,
}))

const resource: ContextResource = {
  kind: "canvas-document",
  documentId: "doc-1",
  revision: "1",
  capabilities: ["comments"],
}

const messages = {
  plugins: {
    surface: {
      title: "{pluginName} could not render",
      description: "{error}",
      retry: "Retry",
    },
  },
  contextWorkbench: {
    actions: {
      close: "Close",
      closeSplit: "Close split pane",
      resizeSplit: "Resize split",
      splitBelow: "Split below",
      splitBelowPanel: "Open below the current panel",
      splitNeedsWide: "Split below (switch to Wide first)",
      layoutMenu: "Layout options",
      resetLayout: "Reset layout",
      collapse: "Collapse",
      expand: "Expand",
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
      <ContextWorkbench workbenchInstanceId="window-a" resource={resource} panels={panels} />
    </NextIntlClientProvider>
  )
}

describe("ContextWorkbench", () => {
  beforeEach(() => {
    useContextWorkbenchStore.setState({ layouts: {} })
    // The rail order/hidden set now comes from settings; start every test on
    // the shipped default.
    useSettingsStore.setState({ settings: {} as never })
    mockResourceSession = null
    mockUseResourceWorkbenchSession.mockClear()
  })

  afterEach(clearAllMockExtensions)

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
    // The reconcile already put this panel in front, so the first rail click is
    // the activity-bar toggle: it shuts the body and leaves the rail.
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.comments" }))
    expect(rail).toHaveAttribute("data-rail-only", "true")
    // The bottom button flips with the surface — there is nothing left to
    // collapse once the body is already shut.
    expect(screen.getByTestId("context-workbench-collapse-toggle")).toHaveAccessibleName(
      "Expand workbench"
    )
    // Re-opening from the rail is a real remount of the body, so the panel's
    // restore hook fires exactly once and its first-activate does not repeat.
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.comments" }))

    expect(rail).not.toHaveAttribute("data-rail-only")
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
    // `comments` is the default active panel — its group tabs render without a
    // rail click (which would now toggle-collapse the workbench).
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

  it("names the group overflow with the current panel and sibling count", () => {
    const First = () => <div>first-panel</div>
    const Second = () => <div>second-panel</div>
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbench
          workbenchInstanceId="overflow-a"
          resource={resource}
          headerLeading={<div>artifact-tabs</div>}
          panels={[
            {
              id: "comments",
              activity: "comments",
              labelKey: "contextWorkbench.panels.comments",
              appliesTo: () => true,
              renderer: First,
            },
            {
              id: "comments-two",
              activity: "comments",
              labelKey: "contextWorkbench.panels.commentsTwo",
              appliesTo: () => true,
              renderer: Second,
            },
          ]}
        />
      </NextIntlClientProvider>
    )

    expect(screen.getByTestId("context-workbench-group-overflow")).toHaveAccessibleName(
      "contextWorkbench.panels.comments 1"
    )
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

    // The crash panel is the default active one; no rail click needed.
    expect(screen.getByRole("alert")).toHaveTextContent("plugin-a could not render")
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
    consoleError.mockRestore()
  })

  // Replaces "force-mounts the closed mobile sheet off-canvas while disabling
  // focus and interaction". The Sheet this drawer replaced kept itself mounted
  // and leaned on `inert` + `aria-hidden` to keep a closed surface out of reach;
  // vaul owns its own exit animation, so the surface simply goes away — which is
  // the same guarantee, arrived at without two attributes that have to agree.
  // The desktop dock already unmounts its body on collapse, so this also stops
  // mobile being the one platform that kept a closed workbench alive.
  it("unmounts the mobile drawer while it is closed", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbenchMobileDrawer
          open={false}
          onOpenChange={jest.fn()}
          workbenchInstanceId="mobile-a"
          resource={resource}
          panels={[]}
        />
      </NextIntlClientProvider>
    )
    expect(screen.queryByTestId("context-workbench-mobile-sheet")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Wide" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Focus" })).not.toBeInTheDocument()
  })

  /**
   * Regression guard for the drawer's one structural hazard.
   *
   * `handleCollapse` falls through to `setMode(scopeKey, "collapsed")` when no
   * host supplies `onCollapse`. In a drawer that hides the *body* while leaving
   * the 92dvh surface open — an empty modal — and the mode is persisted, so it
   * reopens empty too. `project-context-workbench.tsx` mounted the mobile
   * surface without an `onCollapse` and was in exactly that state.
   *
   * The fix is that `ContextWorkbenchMobileDrawer` supplies its own and the prop
   * is `Omit`ted from its public type, so no caller can reintroduce it. This
   * pins the behaviour that makes that worth doing.
   */
  it("closes the mobile drawer instead of collapsing its body", () => {
    const onOpenChange = jest.fn()
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbenchMobileDrawer
          open
          onOpenChange={onOpenChange}
          workbenchInstanceId="mobile-close"
          resource={resource}
          panels={[]}
        />
      </NextIntlClientProvider>
    )
    const toggle = screen.getByTestId("context-workbench-collapse-toggle")
    // Named and drawn for the surface it is on: a bottom drawer has no right
    // edge to fold away, so "Collapse workbench" over a right-panel glyph
    // described something else entirely.
    expect(toggle).toHaveAccessibleName("Close")
    fireEvent.click(toggle)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(
      useContextWorkbenchStore.getState().layouts["mobile-close::canvas-document:doc-1"]?.mode
    ).not.toBe("collapsed")
  })

  it("pads the horizontal rail's buttons out to the 44pt touch floor", () => {
    const panel: ContextPanelDefinition = {
      id: "comments",
      activity: "comments",
      labelKey: "contextWorkbench.panels.comments",
      appliesTo: () => true,
      retention: "stateful",
      renderer: () => <div>panel</div>,
    }
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbenchMobileDrawer
          open
          onOpenChange={jest.fn()}
          workbenchInstanceId="mobile-touch"
          resource={resource}
          panels={[panel]}
        />
      </NextIntlClientProvider>
    )
    // `icon-sm` is 32px — under the 44px floor this repo sets for itself in
    // `globals.css`, and the horizontal rail is the one placement a finger
    // ever hits.
    expect(screen.getByTestId("workbench-activity-comments")).toHaveClass("touch-target")
    expect(screen.getByTestId("context-workbench-collapse-toggle")).toHaveClass("touch-target")
  })

  /**
   * The VS Code activity-bar convention (re-click the active activity to shut
   * the surface) is a pointer idiom. In the drawer "shut" means *dismiss*, so
   * keeping it would turn a mistimed second tap on the icon already in front
   * into losing the whole surface. The drawer has three deliberate exits — the
   * Close button, the handle and the scrim — and does not need a fourth hidden
   * inside navigation.
   */
  it("does not dismiss the mobile drawer when the active activity is tapped again", () => {
    const onOpenChange = jest.fn()
    const panel: ContextPanelDefinition = {
      id: "comments",
      activity: "comments",
      labelKey: "contextWorkbench.panels.comments",
      appliesTo: () => true,
      retention: "stateful",
      renderer: () => <div>panel</div>,
    }
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbenchMobileDrawer
          open
          onOpenChange={onOpenChange}
          workbenchInstanceId="mobile-retap"
          resource={resource}
          panels={[panel]}
        />
      </NextIntlClientProvider>
    )
    const activity = screen.getByTestId("workbench-activity-comments")
    fireEvent.click(activity)
    fireEvent.click(activity)
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  /**
   * Replaces the tripwire that pinned split view as dormant (ADR-0121's third
   * axis). The feature is real now, so the menu has to offer it — but only where
   * there is room, and it still has to say why when there is not.
   */
  it("explains why it cannot split rather than hiding that split exists", () => {
    renderWorkbench([
      {
        id: "comments",
        activity: "comments",
        labelKey: "contextWorkbench.panels.comments",
        appliesTo: () => true,
        retention: "stateful",
        renderer: () => <div>panel</div>,
      },
    ])
    // Radix opens a dropdown from the keyboard path too, which is the one that
    // survives jsdom's missing PointerEvent constructor intact.
    fireEvent.keyDown(screen.getByTestId("context-workbench-layout-menu"), { key: "Enter" })
    // Narrow by default, and a lone panel has nothing to split against.
    const item = screen.getByTestId("context-workbench-split-unavailable")
    expect(item).toHaveTextContent("Split below (switch to Wide first)")
    expect(item).toHaveAttribute("aria-disabled", "true")
  })

  it("closes the mobile drawer on Android hardware back", () => {
    const onOpenChange = jest.fn()
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbenchMobileDrawer
          open
          onOpenChange={onOpenChange}
          workbenchInstanceId="mobile-back"
          resource={resource}
          panels={[]}
        />
      </NextIntlClientProvider>
    )
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("lays the mobile activity rail out horizontally and walks it with left/right", () => {
    const makePanel = (id: string, activity: string): ContextPanelDefinition => ({
      id,
      activity,
      labelKey: `contextWorkbench.panels.${id}`,
      appliesTo: () => true,
      retention: "stateful",
      renderer: () => <div>{id}</div>,
    })
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbenchMobileDrawer
          open
          onOpenChange={jest.fn()}
          workbenchInstanceId="mobile-rail"
          resource={resource}
          panels={[makePanel("comments", "comments"), makePanel("history", "review")]}
        />
      </NextIntlClientProvider>
    )

    // A phone cannot spare 48px of width for a vertical rail, so the sheet
    // stacks — which also means the arrow keys must follow the visual axis.
    const rail = screen.getByTestId("context-workbench-activity-rail")
    expect(rail.className).toContain("w-full")
    expect(rail.className).toContain("border-b")
    expect(rail.className).not.toContain("flex-col")
    expect(rail.className).not.toContain("w-12")

    const first = screen.getByRole("button", { name: "contextWorkbench.panels.comments" })
    const second = screen.getByRole("button", { name: "contextWorkbench.panels.history" })
    first.focus()
    fireEvent.keyDown(first, { key: "ArrowRight" })
    expect(document.activeElement).toBe(second)

    // The vertical binding must go quiet here, or a rail laid out horizontally
    // would still answer to Up/Down and skip two entries per press.
    fireEvent.keyDown(second, { key: "ArrowDown" })
    expect(document.activeElement).toBe(second)
  })

  it("toggle-collapses when the active activity is clicked again, from the rail only", () => {
    const onCollapse = jest.fn()
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbench
          workbenchInstanceId="toggle-a"
          resource={resource}
          onCollapse={onCollapse}
          panels={[
            {
              id: "comments",
              activity: "comments",
              labelKey: "contextWorkbench.panels.comments",
              appliesTo: () => true,
              renderer: () => <div>first-panel</div>,
            },
            {
              id: "comments-two",
              activity: "comments",
              labelKey: "contextWorkbench.panels.commentsTwo",
              appliesTo: () => true,
              renderer: () => <div>second-panel</div>,
            },
            {
              id: "review",
              activity: "review",
              labelKey: "contextWorkbench.panels.review",
              appliesTo: () => true,
              renderer: () => <div>review-panel</div>,
            },
          ]}
        />
      </NextIntlClientProvider>
    )

    // Re-clicking the CURRENT group tab stays inert (no collapse).
    fireEvent.click(screen.getByRole("tab", { name: "contextWorkbench.panels.comments" }))
    expect(onCollapse).not.toHaveBeenCalled()

    // Clicking a DIFFERENT activity switches, no collapse.
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.review" }))
    expect(onCollapse).not.toHaveBeenCalled()
    expect(screen.getByText("review-panel")).toBeInTheDocument()

    // Clicking the ACTIVE activity on the rail toggles the surface closed.
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.review" }))
    expect(onCollapse).toHaveBeenCalledTimes(1)
  })

  it("double-clicking the resize handle restores the default width", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbench
          workbenchInstanceId="dblclick-a"
          resource={resource}
          panels={[
            {
              id: "comments",
              activity: "comments",
              labelKey: "contextWorkbench.panels.comments",
              appliesTo: () => true,
              renderer: () => <div>panel</div>,
            },
          ]}
        />
      </NextIntlClientProvider>
    )

    const handle = screen.getByRole("separator", { name: "Resize workbench" })
    expect(handle).toHaveClass("w-5", "-translate-x-1/2", "z-20")
    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, clientX: 500 }))
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 300 }))
      window.dispatchEvent(new MouseEvent("pointerup"))
    })
    expect(screen.getByTestId("context-workbench")).toHaveStyle({ width: "560px" })

    fireEvent.dblClick(handle)
    expect(screen.getByTestId("context-workbench")).toHaveStyle({ width: "360px" })
  })

  it("remembers a dragged width per panel and restores it when that panel returns", () => {
    const panels: ContextPanelDefinition[] = [
      {
        id: "comments",
        activity: "comments",
        labelKey: "contextWorkbench.panels.comments",
        appliesTo: () => true,
        renderer: () => <div>comments-panel</div>,
      },
      {
        id: "review",
        activity: "review",
        labelKey: "contextWorkbench.panels.review",
        appliesTo: () => true,
        renderer: () => <div>review-panel</div>,
      },
    ]
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbench workbenchInstanceId="perpanel-a" resource={resource} panels={panels} />
      </NextIntlClientProvider>
    )

    const handle = screen.getByRole("separator", { name: "Resize workbench" })
    const drag = (from: number, to: number) => {
      fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, clientX: from }))
      act(() => {
        window.dispatchEvent(new MouseEvent("pointermove", { clientX: to }))
        window.dispatchEvent(new MouseEvent("pointerup"))
      })
    }

    // `comments` is the default panel; widen it.
    drag(500, 300)
    expect(screen.getByTestId("context-workbench")).toHaveStyle({ width: "560px" })

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.review" }))
    drag(500, 600)
    expect(screen.getByTestId("context-workbench")).toHaveStyle({ width: "460px" })

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.comments" }))
    expect(screen.getByTestId("context-workbench")).toHaveStyle({ width: "560px" })

    const layout = useContextWorkbenchStore.getState().layouts["perpanel-a::canvas:doc-1"]
    expect(layout?.panelWidths).toEqual({ comments: 560, review: 460 })
  })

  it("double-click forgets the active panel's remembered width rather than replaying it", () => {
    const panels: ContextPanelDefinition[] = [
      {
        id: "comments",
        activity: "comments",
        labelKey: "contextWorkbench.panels.comments",
        appliesTo: () => true,
        renderer: () => <div>comments-panel</div>,
      },
      {
        id: "review",
        activity: "review",
        labelKey: "contextWorkbench.panels.review",
        appliesTo: () => true,
        renderer: () => <div>review-panel</div>,
      },
    ]
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbench workbenchInstanceId="reset-a" resource={resource} panels={panels} />
      </NextIntlClientProvider>
    )

    const handle = screen.getByRole("separator", { name: "Resize workbench" })
    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, clientX: 500 }))
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 300 }))
      window.dispatchEvent(new MouseEvent("pointerup"))
    })
    fireEvent.dblClick(handle)

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.review" }))
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.comments" }))
    expect(screen.getByTestId("context-workbench")).toHaveStyle({ width: "360px" })
  })

  it("explains what pinning does instead of leaving a bare pin glyph", async () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbench workbenchInstanceId="pin-hint" resource={resource} panels={[]} />
      </NextIntlClientProvider>
    )

    const pin = screen.getByRole("button", { name: "Pin panel" })
    expect(pin).toHaveAttribute("aria-pressed", "false")
    fireEvent.click(pin)
    expect(screen.getByRole("button", { name: "Unpin panel" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
  })

  it("tears mobile panel effects down when the drawer closes", () => {
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
        <ContextWorkbenchMobileDrawer
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
        <ContextWorkbenchMobileDrawer
          open={false}
          onOpenChange={jest.fn()}
          workbenchInstanceId="mobile-effects"
          resource={resource}
          panels={[panel]}
        />
      </NextIntlClientProvider>
    )
    // The `<Activity mode="hidden">` this replaced already destroyed panel
    // effects on close — the embedded browser's process-wide webview lease was
    // never held open by a closed sheet. Unmounting keeps that invariant and
    // drops the surface with it.
    expect(screen.queryByTestId("context-workbench-mobile-sheet")).not.toBeInTheDocument()
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
    expect(screen.queryByText("scoped-ai-panel")).not.toBeInTheDocument()

    mockResourceSession = { id: "embedded-session" }
    view.rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbench workbenchInstanceId="window-a" resource={resource} panels={[panel]} />
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

    // `ai-actions` (no chat scope) is the default active panel.
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
          panelWidths: {},
          activePanelId: "resource-chat",
          userPinned: true,
          activatedPanelIds: ["resource-chat"],
          pendingPanelIds: [],
          lastUsedAt: Date.now(),
          splitPanelId: null,
          splitRatio: 50,
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

  it("filters native panels by resource capabilities and the injected permission gate", () => {
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
        // Declared for diagnostics; the gate is the closure. The host used to
        // filter on a flat `grantedPermissions` set it was never actually
        // passed, so this panel was hidden for the wrong reason.
        requiredPermissions: ["project:read"],
        hasRequiredPermissions: () => false,
        renderer: () => <div>missing-permission</div>,
      },
      {
        id: "declared-but-ungated",
        activity: "templates",
        labelKey: "contextWorkbench.panels.templates",
        appliesTo: () => true,
        requiredPermissions: ["project:read"],
        renderer: () => <div>declared-but-ungated</div>,
      },
    ])

    expect(screen.queryByRole("button", { name: "contextWorkbench.panels.gated" })).toBeNull()
    expect(screen.queryByRole("button", { name: "contextWorkbench.panels.review" })).toBeNull()
    expect(
      screen.getByRole("button", { name: "contextWorkbench.panels.templates" })
    ).toBeInTheDocument()
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

  it("orders the rail by the activity table and parks unknown activities at the end", () => {
    renderWorkbench([
      {
        id: "plugin-panel",
        // A plugin activity outside CONTEXT_ACTIVITY_RAIL_ORDER must still get
        // a rail entry — sorting it to `-1` would have put it first, and
        // dropping it would have made the panel unreachable.
        activity: "vendor-thing",
        labelKey: "contextWorkbench.panels.gated",
        appliesTo: () => true,
        renderer: () => <div>plugin-panel</div>,
        order: 1,
      },
      {
        id: "comments",
        activity: "comments",
        labelKey: "contextWorkbench.panels.comments",
        appliesTo: () => true,
        renderer: () => <div>comments-panel</div>,
        order: 2,
      },
      {
        id: "review",
        activity: "review",
        labelKey: "contextWorkbench.panels.review",
        appliesTo: () => true,
        renderer: () => <div>review-panel</div>,
        order: 3,
      },
    ])

    const railLabels = Array.from(
      screen
        .getByTestId("context-workbench-activity-rail")
        .querySelectorAll<HTMLButtonElement>("[data-workbench-activity-button]")
    ).map((button) => button.getAttribute("aria-label"))

    // `order` governs the group alone: the plugin panel sorts first among the
    // panels, yet `review` still leads the rail because the table says so.
    expect(railLabels).toEqual([
      "contextWorkbench.panels.review",
      "contextWorkbench.panels.comments",
      "contextWorkbench.panels.gated",
    ])
  })

  it("supports arrow, Home, and End keyboard navigation for activities and grouped panels", () => {
    renderWorkbench([
      {
        id: "comments",
        activity: "comments",
        labelKey: "contextWorkbench.panels.comments",
        appliesTo: () => true,
        renderer: () => <div>comments-panel</div>,
      },
      {
        id: "comments-two",
        activity: "comments",
        labelKey: "contextWorkbench.panels.commentsTwo",
        appliesTo: () => true,
        renderer: () => <div>comments-two-panel</div>,
      },
      {
        id: "review",
        activity: "review",
        labelKey: "contextWorkbench.panels.review",
        appliesTo: () => true,
        renderer: () => <div>review-panel</div>,
      },
    ])

    // The rail follows `CONTEXT_ACTIVITY_RAIL_ORDER`, so `review` sits above
    // `comments` regardless of which panel sorts first inside its group.
    const commentsActivity = screen.getByRole("button", {
      name: "contextWorkbench.panels.comments",
    })
    commentsActivity.focus()
    fireEvent.keyDown(commentsActivity, { key: "ArrowUp" })
    expect(screen.getByText("review-panel")).toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole("button", { name: "contextWorkbench.panels.review" }), {
      key: "End",
    })
    expect(screen.getByText("comments-panel")).toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole("button", { name: "contextWorkbench.panels.comments" }), {
      key: "Home",
    })
    expect(screen.getByText("review-panel")).toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole("button", { name: "contextWorkbench.panels.review" }), {
      key: "ArrowDown",
    })
    const firstTab = screen.getByRole("tab", { name: "contextWorkbench.panels.comments" })
    firstTab.focus()
    fireEvent.keyDown(firstTab, { key: "End" })
    expect(screen.getByText("comments-two-panel")).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "contextWorkbench.panels.commentsTwo" })).toHaveFocus()
  })

  it("mounts the revived right-sidebar and panel extension slots with safe resource context", () => {
    const Probe = ({
      extensionId,
      context,
    }: {
      extensionId: string
      context?: Record<string, unknown>
    }) => <span data-testid={extensionId.split(":")[0]}>{JSON.stringify(context)}</span>
    const registrations = [
      registerMockExtension("sidebar.right.top", Probe),
      registerMockExtension("sidebar.right.bottom", Probe),
      registerMockExtension("panel.header", Probe),
      registerMockExtension("panel.footer", Probe),
    ]

    renderWorkbench([
      {
        id: "comments",
        activity: "comments",
        labelKey: "contextWorkbench.panels.comments",
        appliesTo: () => true,
        renderer: () => <div>comments-panel</div>,
      },
    ])

    for (const registration of registrations) {
      const context = JSON.parse(
        screen.getByTestId(registration.pluginId).textContent ?? "{}"
      ) as Record<string, unknown>
      expect(context.resource).toEqual(resource)
      expect(context.resource).not.toHaveProperty("content")
    }
  })

  describe("motion and host-owned width", () => {
    const twoPanels: ContextPanelDefinition[] = [
      {
        id: "comments",
        activity: "comments",
        labelKey: "contextWorkbench.panels.comments",
        appliesTo: () => true,
        renderer: () => <div>comments-panel</div>,
      },
      {
        id: "review",
        activity: "review",
        labelKey: "contextWorkbench.panels.review",
        appliesTo: () => true,
        renderer: () => <div>review-panel</div>,
      },
    ]

    it("animates the incoming panel instead of hard-cutting to it", () => {
      renderWorkbench(twoPanels)

      const active = document.getElementById("context-workbench-panel-comments")
      expect(active?.className).toContain("animate-in")
      // The duration must consume the user's motion-speed preference.
      expect(active?.className).toContain("--motion-duration-scale")

      fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.review" }))

      const incoming = document.getElementById("context-workbench-panel-review")
      expect(incoming?.className).toContain("animate-in")
      // The outgoing panel is left alone — Activity keeps it mounted but hidden,
      // so a cross-fade could never paint both at once.
      expect(document.getElementById("context-workbench-panel-comments")?.className).not.toContain(
        "animate-in"
      )
    })

    it("zooms the focus takeover in rather than snapping to full screen", () => {
      renderWorkbench(twoPanels)

      fireEvent.click(screen.getByRole("button", { name: "Focus mode" }))

      const section = screen.getByTestId("context-workbench")
      expect(section).toHaveAttribute("data-mode", "focus")
      expect(section.className).toContain("zoom-in-95")
      expect(section.className).toContain("--motion-duration-scale")
    })

    it("plays the focus takeover back out instead of snapping into the rail", () => {
      jest.useFakeTimers()
      try {
        renderWorkbench(twoPanels)
        const section = screen.getByTestId("context-workbench")

        fireEvent.click(screen.getByRole("button", { name: "Focus mode" }))
        expect(section.className).toContain("zoom-in-95")

        fireEvent.click(screen.getByRole("button", { name: "Narrow mode" }))

        // The entrance zoomed and faded; leaving used to just drop the class,
        // so a full-screen surface reappeared inside a ~34% rail in one frame.
        // The takeover layout is held for exactly the mirrored exit.
        expect(section).toHaveAttribute("data-mode", "narrow")
        expect(section.className).toContain("zoom-out-95")
        expect(section.className).toContain("fixed")

        act(() => {
          jest.advanceTimersByTime(400)
        })

        expect(section.className).not.toContain("zoom-out-95")
        expect(section.className).not.toContain("fixed")
      } finally {
        jest.useRealTimers()
      }
    })

    it("leaves focus before handing collapse to the host", () => {
      const onCollapse = jest.fn()
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <ContextWorkbench
            workbenchInstanceId="window-a"
            resource={resource}
            panels={twoPanels}
            manageOwnWidth={false}
            onCollapse={onCollapse}
          />
        </NextIntlClientProvider>
      )

      fireEvent.click(screen.getByRole("button", { name: "Focus mode" }))
      fireEvent.click(screen.getByRole("button", { name: "Collapse workbench" }))

      expect(onCollapse).toHaveBeenCalledTimes(1)
      // Without this the dock shrinks to 0% while the fixed overlay stays up,
      // and the persisted mode re-opens the dock full-screen next time.
      expect(useContextWorkbenchStore.getState().layouts["window-a::canvas:doc-1"]?.mode).toBe(
        "narrow"
      )
    })

    it("keeps the wallpaper hook from beating the focus takeover's position", () => {
      // `data-bg-target` opts the workbench into the app wallpaper layer. That
      // rule sets `position: relative`, and an UNLAYERED rule wins over every
      // `@layer utilities` declaration regardless of specificity — so if it ever
      // leaves `@layer base` again, focus mode silently degrades from a
      // `fixed inset-0` takeover to a 100vw block clipped by the dock.
      const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8")
      const rule = css.indexOf("[data-bg-target] {")
      expect(rule).toBeGreaterThan(-1)
      const enclosingLayer = css.lastIndexOf("@layer base {", rule)
      expect(enclosingLayer).toBeGreaterThan(-1)
      // The rule must sit inside that block, not after it closed.
      expect(css.slice(enclosingLayer, rule).lastIndexOf("\n}")).toBe(-1)
    })

    it("reports mode changes so a host that owns the width can resize itself", () => {
      const onModeWidthHint = jest.fn()
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <ContextWorkbench
            workbenchInstanceId="window-a"
            resource={resource}
            panels={twoPanels}
            manageOwnWidth={false}
            onModeWidthHint={onModeWidthHint}
          />
        </NextIntlClientProvider>
      )

      fireEvent.click(screen.getByRole("button", { name: "Wide mode" }))
      fireEvent.click(screen.getByRole("button", { name: "Narrow mode" }))
      fireEvent.click(screen.getByRole("button", { name: "Focus mode" }))

      expect(onModeWidthHint.mock.calls.map(([mode]) => mode)).toEqual(["wide", "narrow", "focus"])
    })

    it("caps managed narrow and wide modes to the host width", () => {
      renderWorkbench(twoPanels)

      const section = screen.getByTestId("context-workbench")
      expect(section.className).toContain("max-w-full")
      expect(section.className).toContain("min-w-0")

      fireEvent.click(screen.getByRole("button", { name: "Wide mode" }))
      expect(section).toHaveStyle({ width: "clamp(640px, 50%, 960px)" })

      fireEvent.click(screen.getByRole("button", { name: "Narrow mode" }))
      expect(section).toHaveStyle({ width: "360px" })
    })
  })
})

describe("ContextWorkbench — customizable activity rail", () => {
  const PANELS: ContextPanelDefinition[] = [
    {
      id: "review",
      activity: "review",
      labelKey: "contextWorkbench.panels.review",
      appliesTo: () => true,
      renderer: () => <div>review-panel</div>,
    },
    {
      id: "comments",
      activity: "comments",
      labelKey: "contextWorkbench.panels.comments",
      appliesTo: () => true,
      renderer: () => <div>comments-panel</div>,
    },
    {
      id: "ai",
      activity: "ai",
      labelKey: "contextWorkbench.panels.ai",
      appliesTo: () => true,
      renderer: () => <div>ai-panel</div>,
    },
  ]

  const railLabels = () =>
    Array.from(
      screen
        .getByTestId("context-workbench-activity-rail")
        .querySelectorAll<HTMLButtonElement>("[data-workbench-activity-button]")
    ).map((button) => button.getAttribute("aria-label"))

  beforeEach(() => {
    useContextWorkbenchStore.setState({ layouts: {} })
    useSettingsStore.setState({ settings: {} as never })
    mockResourceSession = null
  })

  afterEach(clearAllMockExtensions)

  it("follows the shipped order when the user has not customized it", () => {
    renderWorkbench(PANELS)
    expect(railLabels()).toEqual([
      "contextWorkbench.panels.review",
      "contextWorkbench.panels.ai",
      "contextWorkbench.panels.comments",
    ])
  })

  it("follows the user's stored order", () => {
    useSettingsStore.setState({
      settings: { workbenchRail: { order: ["comments", "ai", "review"], hidden: [] } } as never,
    })
    renderWorkbench(PANELS)
    expect(railLabels()).toEqual([
      "contextWorkbench.panels.comments",
      "contextWorkbench.panels.ai",
      "contextWorkbench.panels.review",
    ])
  })

  it("drops a hidden activity's button but keeps its panel resolvable", () => {
    useSettingsStore.setState({
      settings: { workbenchRail: { order: ["review", "ai", "comments"], hidden: ["ai"] } } as never,
    })
    renderWorkbench(PANELS)
    expect(railLabels()).toEqual([
      "contextWorkbench.panels.review",
      "contextWorkbench.panels.comments",
    ])

    // The panel is still reachable — this is what the command palette and
    // `ctrl+1..7` use, and it is the whole reason hiding is safe to offer.
    act(() => {
      useContextWorkbenchStore.getState().navigatePanel("window-a::artifact:a1", "ai", "narrow")
    })
    expect(screen.getByText("ai-panel")).toBeInTheDocument()
  })

  describe("panel-level customization", () => {
    const GROUPED: ContextPanelDefinition[] = [
      {
        id: "review",
        activity: "review",
        labelKey: "contextWorkbench.panels.review",
        order: 10,
        appliesTo: () => true,
        renderer: () => <div>review-panel</div>,
      },
      {
        id: "commentsTwo",
        activity: "review",
        labelKey: "contextWorkbench.panels.commentsTwo",
        order: 20,
        appliesTo: () => true,
        renderer: () => <div>comments-two-panel</div>,
      },
    ]

    const groupTabLabels = () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("[data-workbench-group-tab]")).map(
        (tab) => tab.textContent
      )

    it("follows the panels' own order numbers when the user has not customized them", () => {
      renderWorkbench(GROUPED)
      expect(groupTabLabels()).toEqual([
        "contextWorkbench.panels.review",
        "contextWorkbench.panels.commentsTwo",
      ])
    })

    it("follows the user's stored tab order", () => {
      useSettingsStore.setState({
        settings: { workbenchPanels: { order: ["commentsTwo", "review"], hidden: [] } } as never,
      })
      renderWorkbench(GROUPED)
      expect(groupTabLabels()).toEqual([
        "contextWorkbench.panels.commentsTwo",
        "contextWorkbench.panels.review",
      ])
    })

    it("drops a hidden panel's tab but keeps the panel resolvable", () => {
      useSettingsStore.setState({
        settings: { workbenchPanels: { order: [], hidden: ["commentsTwo"] } } as never,
      })
      renderWorkbench(GROUPED)
      // Only one panel left in the group, so the strip collapses entirely.
      expect(groupTabLabels()).toEqual([])

      // Still reachable — this is what the command palette and `ctrl+1..7`
      // use, and it is the whole reason hiding a panel is safe to offer.
      act(() => {
        useContextWorkbenchStore
          .getState()
          .navigatePanel("window-a::canvas:doc-1", "commentsTwo", "narrow")
      })
      expect(screen.getByText("comments-two-panel")).toBeInTheDocument()
    })

    it("drops the rail button for an activity whose every panel is hidden", () => {
      useSettingsStore.setState({
        settings: {
          workbenchPanels: { order: [], hidden: ["review", "commentsTwo"] },
        } as never,
      })
      renderWorkbench(GROUPED)
      // An icon that opens an empty body is worse than no icon; the panels
      // themselves stay reachable by shortcut either way.
      expect(railLabels()).toEqual([])
    })
  })

  it("opens the shared Workbench customizer from the activity rail", () => {
    renderWorkbench(PANELS)

    fireEvent.click(screen.getByTestId("context-workbench-customize-rail"))

    expect(screen.getByTestId("shell-layout-dialog-workbench")).toBeInTheDocument()
  })

  it("reorders activity buttons via inline drag and persists the new order", () => {
    // Mock save to apply the patch synchronously (bypass Dexie roundtrip)
    const saveSpy = jest
      .spyOn(useSettingsStore.getState(), "save")
      .mockImplementation(async (patch) => {
        const current = useSettingsStore.getState().settings ?? ({} as never)
        useSettingsStore.setState({ settings: { ...current, ...patch } as never })
      })

    renderWorkbench(PANELS)
    // Initial order: review, ai, comments (from canonical sort)
    expect(railLabels()).toEqual([
      "contextWorkbench.panels.review",
      "contextWorkbench.panels.ai",
      "contextWorkbench.panels.comments",
    ])

    // Simulate dragging "review" to where "comments" is
    act(() => {
      lastDragEnd?.({ active: { id: "review" }, over: { id: "comments" } })
    })

    // After drag: ai, comments, review
    expect(railLabels()).toEqual([
      "contextWorkbench.panels.ai",
      "contextWorkbench.panels.comments",
      "contextWorkbench.panels.review",
    ])

    // Verify persistence: save was called with the new order
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workbenchRail: expect.objectContaining({
          order: expect.arrayContaining(["ai", "comments", "review"]),
        }),
      })
    )

    saveSpy.mockRestore()
  })

  it("does not persist when drag lands on itself", () => {
    renderWorkbench(PANELS)
    const saveSpy = jest.spyOn(useSettingsStore.getState(), "save")

    act(() => {
      lastDragEnd?.({ active: { id: "review" }, over: { id: "review" } })
    })

    expect(saveSpy).not.toHaveBeenCalled()
    saveSpy.mockRestore()
  })

  it("does not persist when drag lands outside any target", () => {
    renderWorkbench(PANELS)
    const saveSpy = jest.spyOn(useSettingsStore.getState(), "save")

    act(() => {
      lastDragEnd?.({ active: { id: "review" }, over: null })
    })

    expect(saveSpy).not.toHaveBeenCalled()
    saveSpy.mockRestore()
  })

  it("renders activity buttons with cursor-grab style for drag hint", () => {
    renderWorkbench(PANELS)
    const buttons = screen
      .getByTestId("context-workbench-activity-rail")
      .querySelectorAll<HTMLButtonElement>("[data-workbench-activity-button]")
    buttons.forEach((button) => {
      expect(button.className).toContain("cursor-grab")
    })
  })
})

describe("ContextWorkbench — host-driven rail-only (persistent minibar)", () => {
  const PANELS: ContextPanelDefinition[] = [
    {
      id: "review",
      activity: "review",
      labelKey: "contextWorkbench.panels.review",
      appliesTo: () => true,
      renderer: () => <div>review-panel</div>,
      retention: "stateful",
    },
    {
      id: "comments",
      activity: "comments",
      labelKey: "contextWorkbench.panels.comments",
      appliesTo: () => true,
      renderer: () => <div>comments-panel</div>,
      retention: "stateful",
    },
  ]

  function renderHosted(props: { railOnly: boolean; onEnsureVisible?: () => void }) {
    return render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbench
          workbenchInstanceId="window-a"
          resource={resource}
          panels={PANELS}
          manageOwnWidth={false}
          onCollapse={() => undefined}
          {...props}
        />
      </NextIntlClientProvider>
    )
  }

  beforeEach(() => {
    useContextWorkbenchStore.setState({ layouts: {} })
    useSettingsStore.setState({ settings: {} as never })
    mockResourceSession = null
  })

  afterEach(clearAllMockExtensions)

  it("keeps the rail and drops the panel body", () => {
    renderHosted({ railOnly: true })

    // The rail is the whole point of the state — it must survive.
    expect(screen.getByTestId("context-workbench-activity-rail")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "contextWorkbench.panels.review" })
    ).toBeInTheDocument()
    // The body — and every panel inside it — is unmounted, not hidden. This is
    // what releases the embedded browser's process-wide webview lease.
    expect(screen.queryByText("review-panel")).not.toBeInTheDocument()
    expect(screen.queryByText("comments-panel")).not.toBeInTheDocument()
  })

  it("does not write the host's collapse into the per-scope layout mode", () => {
    renderHosted({ railOnly: true })
    // `railOnly` is one global fact per host; routing it through the per-resource
    // layout would make the rail re-open and re-close as the user moved between
    // artifacts. The store must stay out of it.
    expect(useContextWorkbenchStore.getState().layouts["window-a::canvas:doc-1"]?.mode).not.toBe(
      "collapsed"
    )
  })

  it("asks the host to reopen when a rail activity is clicked", () => {
    const onEnsureVisible = jest.fn()
    renderHosted({ railOnly: true, onEnsureVisible })

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.comments" }))

    expect(onEnsureVisible).toHaveBeenCalledTimes(1)
    // …and it switches to the clicked panel in the same gesture, so opening the
    // rail never lands on whatever happened to be in front before.
    expect(
      useContextWorkbenchStore.getState().layouts["window-a::canvas:doc-1"]?.activePanelId
    ).toBe("comments")
  })

  it("reopens rather than collapsing when the already-active activity is clicked", () => {
    const onEnsureVisible = jest.fn()
    const onCollapse = jest.fn()
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbench
          workbenchInstanceId="window-a"
          resource={resource}
          panels={PANELS}
          manageOwnWidth={false}
          railOnly
          onCollapse={onCollapse}
          onEnsureVisible={onEnsureVisible}
        />
      </NextIntlClientProvider>
    )

    // `reconcilePanels` already put `review` in front. Clicking it from a
    // rail-only surface must open, not run the activity-bar close toggle — the
    // body is already shut, so closing again would be a dead click.
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.review" }))

    expect(onEnsureVisible).toHaveBeenCalledTimes(1)
    expect(onCollapse).not.toHaveBeenCalled()
  })

  it("marks the host's chosen activity when something arrived unseen", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbench
          workbenchInstanceId="window-a"
          resource={resource}
          panels={PANELS}
          manageOwnWidth={false}
          railOnly
          attentionActivity="comments"
          onCollapse={() => undefined}
        />
      </NextIntlClientProvider>
    )

    // The marker rides the rail button for the activity the host named, so it
    // is reachable while the body is shut — which is the only time it matters.
    const marked = screen
      .getByRole("button", { name: "contextWorkbench.panels.comments" })
      .querySelector("[data-testid=context-workbench-activity-attention]")
    expect(marked).toBeInTheDocument()
    // …and nowhere else.
    expect(screen.getAllByTestId("context-workbench-activity-attention")).toHaveLength(1)
  })

  it("yields the marker to a real badge rather than stacking two glyphs", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbench
          workbenchInstanceId="window-a"
          resource={resource}
          panels={PANELS.map((panel) =>
            panel.id === "comments" ? { ...panel, getBadge: () => 3 } : panel
          )}
          manageOwnWidth={false}
          railOnly
          attentionActivity="comments"
          onCollapse={() => undefined}
        />
      </NextIntlClientProvider>
    )

    // A 48px column has room for one glyph per button; the count says more than
    // a bare dot, so it wins.
    expect(screen.queryByTestId("context-workbench-activity-attention")).not.toBeInTheDocument()
    expect(screen.getByText("3")).toBeInTheDocument()
  })

  it("draws no marker when the host has nothing to announce", () => {
    renderHosted({ railOnly: true })
    expect(screen.queryByTestId("context-workbench-activity-attention")).not.toBeInTheDocument()
  })

  it("flips the bottom button between collapse and expand", () => {
    const onEnsureVisible = jest.fn()
    const onCollapse = jest.fn()
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbench
          workbenchInstanceId="window-a"
          resource={resource}
          panels={PANELS}
          manageOwnWidth={false}
          onCollapse={onCollapse}
          onEnsureVisible={onEnsureVisible}
        />
      </NextIntlClientProvider>
    )
    const toggle = () => screen.getByTestId("context-workbench-collapse-toggle")
    expect(toggle()).toHaveAccessibleName("Collapse workbench")
    fireEvent.click(toggle())
    expect(onCollapse).toHaveBeenCalledTimes(1)

    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbench
          workbenchInstanceId="window-a"
          resource={resource}
          panels={PANELS}
          manageOwnWidth={false}
          railOnly
          onCollapse={onCollapse}
          onEnsureVisible={onEnsureVisible}
        />
      </NextIntlClientProvider>
    )
    expect(toggle()).toHaveAccessibleName("Expand workbench")
    fireEvent.click(toggle())
    expect(onEnsureVisible).toHaveBeenCalledTimes(1)
    expect(onCollapse).toHaveBeenCalledTimes(1)
  })
})

describe("ContextWorkbench — vertical split", () => {
  const SCOPE = "window-a::canvas:doc-1"

  /**
   * Counts component *instances*, which is the question a remount test is
   * actually asking.
   *
   * Deliberately not a `useEffect(…, [])`: stateful panels live behind
   * `<Activity>`, which tears effects down when it hides a pane and revives them
   * when it shows one (pinned by "pauses stateful panel effects while hidden"
   * above). An effect counter would therefore count *visibility transitions* and
   * pass while every panel was being destroyed. A lazy state initializer runs
   * once per instance and survives Activity, so it can only change if React
   * really did build a new component.
   */
  let instanceSeq = 0
  const instances: Record<string, number> = {}
  function Counted({ id, active }: { id: string; active: boolean }) {
    const [token] = useState(() => {
      instances[id] = (instances[id] ?? 0) + 1
      return `${id}#${++instanceSeq}`
    })
    return (
      <div data-testid={`panel-${id}`} data-token={token}>
        {id}:{String(active)}
      </div>
    )
  }

  const PANELS: ContextPanelDefinition[] = [
    {
      id: "comments",
      activity: "comments",
      labelKey: "contextWorkbench.panels.comments",
      appliesTo: () => true,
      renderer: ({ active }) => <Counted id="comments" active={active} />,
      retention: "stateful",
    },
    {
      id: "review",
      activity: "review",
      labelKey: "contextWorkbench.panels.review",
      appliesTo: () => true,
      renderer: ({ active }) => <Counted id="review" active={active} />,
      retention: "stateful",
    },
  ]

  beforeEach(() => {
    useContextWorkbenchStore.setState({ layouts: {} })
    useSettingsStore.setState({ settings: {} as never })
    mockResourceSession = null
    instanceSeq = 0
    for (const key of Object.keys(instances)) delete instances[key]
  })

  function renderSplit(panels: ContextPanelDefinition[] = PANELS) {
    return render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbench workbenchInstanceId="window-a" resource={resource} panels={panels} />
      </NextIntlClientProvider>
    )
  }

  /** Drives the store directly — the menu entry point lands in a later change. */
  function openSplit(secondary = "review") {
    act(() => {
      useContextWorkbenchStore.getState().navigatePanel(SCOPE, "comments", "wide")
      useContextWorkbenchStore.getState().activateSplit(SCOPE, secondary)
    })
  }

  it("treats both panes as visible", () => {
    renderSplit()
    openSplit()

    // `active` means "in a visible pane", so both renderers see true — a second
    // pane reporting inactive would be on screen but inert and unfocusable.
    expect(screen.getByTestId("panel-comments")).toHaveTextContent("comments:true")
    expect(screen.getByTestId("panel-review")).toHaveTextContent("review:true")
    for (const id of ["comments", "review"]) {
      const pane = document.getElementById(`context-workbench-panel-${id}`)
      expect(pane).not.toHaveAttribute("inert")
      expect(pane).not.toHaveAttribute("aria-hidden", "true")
    }
  })

  it("stacks the panes into complementary lanes driven by one custom property", () => {
    const { container } = renderSplit()
    openSplit()
    act(() => useContextWorkbenchStore.getState().setSplitRatio(SCOPE, 70))

    const body = container.querySelector("[data-split]") as HTMLElement
    expect(body.style.getPropertyValue("--wb-split")).toBe("70%")
    const laneOf = (id: string) =>
      document.getElementById(`context-workbench-panel-${id}`)?.parentElement as HTMLElement
    expect(laneOf("comments").style.height).toBe("var(--wb-split)")
    expect(laneOf("review").style.top).toContain("var(--wb-split)")
  })

  it("keeps both panels mounted across opening, resizing, swapping and closing the split", () => {
    renderSplit()
    act(() => useContextWorkbenchStore.getState().navigatePanel(SCOPE, "comments", "wide"))
    const tokenOf = (id: string) =>
      screen.getByTestId(`panel-${id}`).getAttribute("data-token") ?? ""
    const before = { comments: tokenOf("comments") }

    act(() => useContextWorkbenchStore.getState().activateSplit(SCOPE, "review"))
    const reviewToken = tokenOf("review")

    act(() => useContextWorkbenchStore.getState().setSplitRatio(SCOPE, 65))
    // Swapping the panes: the panel moves lanes, not parents.
    act(() => useContextWorkbenchStore.getState().navigatePanel(SCOPE, "review", "wide"))
    act(() => useContextWorkbenchStore.getState().closeSplit(SCOPE))

    // One instance each, from first mount to last — an embedded webview or a
    // Monaco buffer in either pane survived the whole sequence.
    expect(instances).toEqual({ comments: 1, review: 1 })
    expect(tokenOf("comments")).toBe(before.comments)
    expect(tokenOf("review")).toBe(reviewToken)
  })

  it("ignores a desktop split inside the mobile drawer without writing to the store", () => {
    openSplit()
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContextWorkbenchMobileDrawer
          open
          onOpenChange={() => undefined}
          workbenchInstanceId="window-a"
          resource={resource}
          panels={PANELS}
        />
      </NextIntlClientProvider>
    )

    // The drawer projects the split away at render time only. Persisting the
    // narrowing would let a phone destroy a layout set up on a desktop.
    expect(screen.getByTestId("panel-comments")).toHaveTextContent("comments:true")
    expect(screen.getByTestId("panel-review")).toHaveTextContent("review:false")
    expect(useContextWorkbenchStore.getState().layouts[SCOPE]?.splitPanelId).toBe("review")
  })

  it("projects the split away in a container too narrow for two panes, and keeps it stored", () => {
    const widthSpy = jest
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ width: 320, height: 600 } as DOMRect)
    try {
      renderSplit()
      openSplit()

      expect(screen.getByTestId("panel-review")).toHaveTextContent("review:false")
      expect(useContextWorkbenchStore.getState().layouts[SCOPE]?.splitPanelId).toBe("review")
    } finally {
      widthSpy.mockRestore()
    }
  })

  it("fires first activation for a panel opened straight into the second pane", () => {
    const onFirstActivate = jest.fn()
    const onRestore = jest.fn()
    renderSplit([PANELS[0]!, { ...PANELS[1]!, onFirstActivate, onRestore }])

    openSplit()

    expect(onFirstActivate).toHaveBeenCalledTimes(1)
    expect(onRestore).not.toHaveBeenCalled()
  })

  it("does not re-run activation when the panes are swapped", () => {
    const onFirstActivate = jest.fn()
    const onRestore = jest.fn()
    renderSplit([PANELS[0]!, { ...PANELS[1]!, onFirstActivate, onRestore }])
    openSplit()

    // A swap changes which panel is in front, so it is a navigation — but
    // nothing entered or left the screen, so no lifecycle may fire.
    act(() => {
      useContextWorkbenchStore.getState().navigatePanel(SCOPE, "review", "wide")
    })

    expect(useContextWorkbenchStore.getState().layouts[SCOPE]).toMatchObject({
      activePanelId: "review",
      splitPanelId: "comments",
    })
    expect(onFirstActivate).toHaveBeenCalledTimes(1)
    expect(onRestore).not.toHaveBeenCalled()
  })

  it("swaps rather than collapsing when the rail names the panel in the second pane", () => {
    const onFirstActivate = jest.fn()
    const onRestore = jest.fn()
    renderSplit([PANELS[0]!, { ...PANELS[1]!, onFirstActivate, onRestore }])
    openSplit()

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.panels.review" }))

    expect(useContextWorkbenchStore.getState().layouts[SCOPE]).toMatchObject({
      activePanelId: "review",
      splitPanelId: "comments",
    })
    expect(onFirstActivate).toHaveBeenCalledTimes(1)
    expect(onRestore).not.toHaveBeenCalled()
  })

  it("fires nothing when the split is only resized", () => {
    const onFirstActivate = jest.fn()
    const onRestore = jest.fn()
    renderSplit([PANELS[0]!, { ...PANELS[1]!, onFirstActivate, onRestore }])
    openSplit()
    onFirstActivate.mockClear()

    act(() => useContextWorkbenchStore.getState().setSplitRatio(SCOPE, 65))

    expect(onFirstActivate).not.toHaveBeenCalled()
    expect(onRestore).not.toHaveBeenCalled()
  })

  it("expands a collapsed workbench back to wide when a split is waiting", () => {
    renderSplit()
    openSplit()
    act(() => useContextWorkbenchStore.getState().setMode(SCOPE, "collapsed"))

    fireEvent.click(screen.getByTestId("context-workbench-collapse-toggle"))

    // Expanding into narrow would silently destroy the split the collapse
    // deliberately preserved.
    expect(useContextWorkbenchStore.getState().layouts[SCOPE]).toMatchObject({
      mode: "wide",
      splitPanelId: "review",
    })
  })

  it("offers a split candidate in wide mode and opens it below", () => {
    renderSplit()
    act(() => useContextWorkbenchStore.getState().navigatePanel(SCOPE, "comments", "wide"))

    fireEvent.keyDown(screen.getByTestId("context-workbench-layout-menu"), { key: "Enter" })
    fireEvent.click(screen.getByTestId("context-workbench-split-below"))
    fireEvent.click(screen.getByTestId("context-workbench-split-candidate-review"))

    expect(useContextWorkbenchStore.getState().layouts[SCOPE]?.splitPanelId).toBe("review")
    expect(screen.getByTestId("panel-review")).toHaveTextContent("review:true")
  })

  it("closes the split from the pane's own header button", () => {
    renderSplit()
    openSplit()

    fireEvent.click(screen.getByTestId("context-workbench-close-split"))

    expect(useContextWorkbenchStore.getState().layouts[SCOPE]?.splitPanelId).toBeNull()
    expect(screen.getByTestId("panel-comments")).toHaveTextContent("comments:true")
  })

  it("trades the tabs pattern for two labelled regions when a second pane opens", () => {
    renderSplit()
    act(() => useContextWorkbenchStore.getState().navigatePanel(SCOPE, "comments", "wide"))
    expect(document.getElementById("context-workbench-panel-comments")).toHaveAttribute(
      "role",
      "tabpanel"
    )

    openSplit()

    // One selected tab cannot describe two visible panes, so the tabs widget
    // degrades to plain regions rather than lying about the selection.
    for (const id of ["comments", "review"]) {
      expect(document.getElementById(`context-workbench-panel-${id}`)).toHaveAttribute(
        "role",
        "region"
      )
    }
    // Labels render as their raw key in this harness, as everywhere else here.
    expect(screen.getByTestId("context-workbench-split-bar")).toHaveTextContent(
      "contextWorkbench.panels.review"
    )
  })

  it("persists the ratio on release, not during the drag", () => {
    const { container } = renderSplit()
    openSplit()
    const body = container.querySelector("[data-split]") as HTMLElement
    // jsdom reports a zero-height box, and the drag maths needs a real one.
    jest.spyOn(body, "getBoundingClientRect").mockReturnValue({ top: 0, height: 400 } as DOMRect)
    const separator = screen.getByTestId("context-workbench-split-separator")

    fireEvent.pointerDown(separator, { clientY: 200 })
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientY: 260 }))
    })

    // Mid-gesture the preview moved but the store did not: a write per move
    // would re-render a Monaco buffer and an embedded browser on every frame.
    expect(body.style.getPropertyValue("--wb-split")).toBe("65%")
    expect(useContextWorkbenchStore.getState().layouts[SCOPE]?.splitRatio).toBe(50)

    act(() => {
      window.dispatchEvent(new MouseEvent("pointerup"))
    })
    expect(useContextWorkbenchStore.getState().layouts[SCOPE]?.splitRatio).toBe(65)
  })

  it("resizes the split from the keyboard", () => {
    renderSplit()
    openSplit()
    const separator = screen.getByTestId("context-workbench-split-separator")
    const ratio = () => useContextWorkbenchStore.getState().layouts[SCOPE]?.splitRatio

    fireEvent.keyDown(separator, { key: "ArrowDown" })
    expect(ratio()).toBe(52)
    fireEvent.keyDown(separator, { key: "ArrowUp", shiftKey: true })
    expect(ratio()).toBe(42)
    fireEvent.keyDown(separator, { key: "End" })
    expect(ratio()).toBe(80)
    fireEvent.keyDown(separator, { key: "Home" })
    expect(ratio()).toBe(20)
    expect(separator).toHaveAttribute("aria-valuenow", "20")
  })

  it("keeps a crashing second pane from taking the first one down", () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined)
    const Boom = () => {
      throw new Error("boom")
    }
    renderSplit([PANELS[0]!, { ...PANELS[1]!, renderer: Boom }])
    openSplit()

    // Each pane carries its own error boundary, so the second one failing must
    // not take the first — or the whole workbench — with it.
    const primary = document.getElementById("context-workbench-panel-comments")
    const secondary = document.getElementById("context-workbench-panel-review")!
    expect(primary?.textContent).toContain("comments:true")
    // The crashed pane shows its boundary's retry affordance instead of its
    // renderer. Asserted structurally rather than by copy, which this file
    // resolves from the real message catalogue.
    expect(secondary.textContent).not.toContain("review:")
    expect(within(secondary).getByRole("button")).toBeInTheDocument()
    consoleError.mockRestore()
  })

  it("unmounts an ephemeral second pane on close but keeps a stateful one", () => {
    renderSplit([PANELS[0]!, { ...PANELS[1]!, retention: "ephemeral" }])
    openSplit()
    expect(screen.getByTestId("panel-review")).toBeInTheDocument()

    act(() => useContextWorkbenchStore.getState().closeSplit(SCOPE))

    expect(screen.queryByTestId("panel-review")).not.toBeInTheDocument()
    expect(screen.getByTestId("panel-comments")).toBeInTheDocument()
  })
})
