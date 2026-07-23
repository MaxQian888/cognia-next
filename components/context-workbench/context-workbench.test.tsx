import { readFileSync } from "node:fs"
import { join } from "node:path"
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
      <ContextWorkbench workbenchInstanceId="window-a" resource={resource} panels={panels} />
    </NextIntlClientProvider>
  )
}

describe("ContextWorkbench", () => {
  beforeEach(() => {
    useContextWorkbenchStore.setState({ layouts: {} })
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
        <ContextWorkbenchMobileSheet
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

    const commentsActivity = screen.getByRole("button", {
      name: "contextWorkbench.panels.comments",
    })
    commentsActivity.focus()
    fireEvent.keyDown(commentsActivity, { key: "ArrowDown" })
    expect(screen.getByText("review-panel")).toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole("button", { name: "contextWorkbench.panels.review" }), {
      key: "Home",
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
  })
})
