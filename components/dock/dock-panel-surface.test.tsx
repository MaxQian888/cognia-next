/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

import { DockPanelSurface } from "./dock-panel-surface"
import { resolveDockPanel } from "@/lib/dock/derive-panel-metadata"
import type { ContextPanelRenderProps, ContextResource } from "@/types/context-workbench"
import type { DockPanelInstance } from "@/types/dock/instance"
import type { DockPanelDefinition } from "@/types/dock/panel"

const resource: ContextResource = { kind: "session", sessionId: "s1", capabilities: [] }

function instance(overrides: Partial<DockPanelInstance> = {}): DockPanelInstance {
  return {
    instanceId: "i1",
    panelId: "review",
    kind: "panel",
    mode: "pinned",
    dirty: false,
    activated: false,
    ...overrides,
  }
}

function panelDef(overrides: Partial<DockPanelDefinition> = {}): DockPanelDefinition {
  return {
    id: "review",
    activity: "review",
    labelKey: "dock.panels.review",
    label: "Review",
    appliesTo: () => true,
    renderer: ({ active }: ContextPanelRenderProps) => (
      <div data-testid="panel-body" data-active={String(active)} />
    ),
    ...overrides,
  }
}

const consoleError = jest.spyOn(console, "error").mockImplementation(() => {})
afterAll(() => consoleError.mockRestore())
beforeEach(() => consoleError.mockClear())

describe("DockPanelSurface", () => {
  it("renders the panel's own renderer with workbench render props", () => {
    render(
      <DockPanelSurface
        instance={instance()}
        panel={resolveDockPanel(panelDef())}
        resource={resource}
        workbenchInstanceId="wb-1"
        active
        onActivated={jest.fn()}
      />
    )
    expect(screen.getByTestId("panel-body")).toHaveAttribute("data-active", "true")
    expect(screen.getByTestId("dock-panel-i1")).toBeInTheDocument()
  })

  it("fires onFirstActivate for a brand-new instance and reports the activation", () => {
    const onFirstActivate = jest.fn()
    const onRestore = jest.fn()
    const onActivated = jest.fn()
    render(
      <DockPanelSurface
        instance={instance({ activated: false })}
        panel={resolveDockPanel(panelDef({ onFirstActivate, onRestore }))}
        resource={resource}
        workbenchInstanceId="wb-1"
        active
        onActivated={onActivated}
      />
    )
    expect(onFirstActivate).toHaveBeenCalledWith(resource)
    expect(onRestore).not.toHaveBeenCalled()
    expect(onActivated).toHaveBeenCalledWith("i1")
  })

  it("fires onRestore instead when the instance was already activated", () => {
    // Re-running one-time side effects on every reload is the bug this guards.
    const onFirstActivate = jest.fn()
    const onRestore = jest.fn()
    render(
      <DockPanelSurface
        instance={instance({ activated: true })}
        panel={resolveDockPanel(panelDef({ onFirstActivate, onRestore }))}
        resource={resource}
        workbenchInstanceId="wb-1"
        active
        onActivated={jest.fn()}
      />
    )
    expect(onRestore).toHaveBeenCalledWith(resource)
    expect(onFirstActivate).not.toHaveBeenCalled()
  })

  it("does not activate a background tab", () => {
    const onFirstActivate = jest.fn()
    const onActivated = jest.fn()
    render(
      <DockPanelSurface
        instance={instance()}
        panel={resolveDockPanel(panelDef({ onFirstActivate }))}
        resource={resource}
        workbenchInstanceId="wb-1"
        active={false}
        onActivated={onActivated}
      />
    )
    expect(onFirstActivate).not.toHaveBeenCalled()
    expect(onActivated).not.toHaveBeenCalled()
    expect(screen.getByTestId("panel-body")).toHaveAttribute("data-active", "false")
  })

  it("activates only once even as the tab re-renders", () => {
    const onActivated = jest.fn()
    const props = {
      instance: instance(),
      panel: resolveDockPanel(panelDef()),
      resource,
      workbenchInstanceId: "wb-1",
      active: true,
      onActivated,
    }
    const { rerender } = render(<DockPanelSurface {...props} />)
    rerender(<DockPanelSurface {...props} />)
    rerender(<DockPanelSurface {...props} active={false} />)
    rerender(<DockPanelSurface {...props} />)
    expect(onActivated).toHaveBeenCalledTimes(1)
  })

  it("shows a plugin placeholder rather than dropping the tab", () => {
    render(
      <DockPanelSurface
        instance={instance({ kind: "plugin-surface", panelId: "acme.notes" })}
        panel={undefined}
        resource={resource}
        workbenchInstanceId="wb-1"
        active
        onActivated={jest.fn()}
      />
    )
    expect(screen.getByTestId("dock-panel-unavailable")).toHaveAttribute("data-reason", "plugin")
  })

  it("attributes a missing first-party panel to permissions, not to a plugin", () => {
    render(
      <DockPanelSurface
        instance={instance()}
        panel={undefined}
        resource={resource}
        workbenchInstanceId="wb-1"
        active
        onActivated={jest.fn()}
      />
    )
    expect(screen.getByTestId("dock-panel-unavailable")).toHaveAttribute(
      "data-reason",
      "permission"
    )
  })

  it("contains a crashing panel to its own tab and offers a reload", () => {
    // dockview renders panels as siblings; an unguarded throw would unmount the
    // tree that owns the grid, taking every other panel with it.
    const Boom = () => {
      throw new Error("boom")
    }
    render(
      <DockPanelSurface
        instance={instance()}
        panel={resolveDockPanel(panelDef({ renderer: Boom }))}
        resource={resource}
        workbenchInstanceId="wb-1"
        active
        onActivated={jest.fn()}
      />
    )
    expect(screen.getByTestId("dock-panel-unavailable")).toHaveAttribute("data-reason", "crashed")
    expect(screen.getByRole("button", { name: "panelCrashedRetry" })).toBeInTheDocument()
  })

  it("clears a crash when the tab starts rendering a different panel", () => {
    const Boom = () => {
      throw new Error("boom")
    }
    const { rerender } = render(
      <DockPanelSurface
        instance={instance()}
        panel={resolveDockPanel(panelDef({ renderer: Boom }))}
        resource={resource}
        workbenchInstanceId="wb-1"
        active
        onActivated={jest.fn()}
      />
    )
    expect(screen.getByTestId("dock-panel-unavailable")).toBeInTheDocument()

    rerender(
      <DockPanelSurface
        instance={instance({ instanceId: "i2", panelId: "preview" })}
        panel={resolveDockPanel(panelDef({ id: "preview" }))}
        resource={resource}
        workbenchInstanceId="wb-1"
        active
        onActivated={jest.fn()}
      />
    )
    expect(screen.getByTestId("panel-body")).toBeInTheDocument()
  })

  it("falls back to the panel id when it carries no label", () => {
    const Boom = () => {
      throw new Error("boom")
    }
    render(
      <DockPanelSurface
        instance={instance()}
        panel={resolveDockPanel(panelDef({ label: undefined, renderer: Boom }))}
        resource={resource}
        workbenchInstanceId="wb-1"
        active
        onActivated={jest.fn()}
      />
    )
    expect(screen.getByText(/"name":"review"/)).toBeInTheDocument()
  })
  it("recovers the panel when the user reloads after a transient crash", () => {
    let shouldThrow = true
    const Flaky = () => {
      if (shouldThrow) throw new Error("boom")
      return <div data-testid="panel-body" data-active="true" />
    }
    render(
      <DockPanelSurface
        instance={instance()}
        panel={resolveDockPanel(panelDef({ renderer: Flaky }))}
        resource={resource}
        workbenchInstanceId="wb-1"
        active
        onActivated={jest.fn()}
      />
    )
    expect(screen.getByTestId("dock-panel-unavailable")).toBeInTheDocument()

    shouldThrow = false
    fireEvent.click(screen.getByRole("button", { name: "panelCrashedRetry" }))
    expect(screen.getByTestId("panel-body")).toBeInTheDocument()
  })
})
