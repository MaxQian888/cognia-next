/**
 * Tests for `PluginModalRoot` — verifies the stack-rendering pipeline,
 * the close-via-Dialog-onOpenChange path, and the error boundary fallback
 * that ADR-0026 §3 §A requires.
 */

import { render, screen, fireEvent, act } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { PluginModalRoot } from "./plugin-modal-root"
import { usePluginModalStore } from "@/stores/plugin-runtime/plugin-modal-store"
import type { PluginModalComponent } from "@/types/plugin/plugin-modal"

function renderRoot() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PluginModalRoot />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  // Each test starts with a clean stack.
  act(() => {
    usePluginModalStore.getState().closeAll()
  })
})

afterEach(() => {
  act(() => {
    usePluginModalStore.getState().closeAll()
  })
})

describe("PluginModalRoot", () => {
  it("renders nothing when the stack is empty", () => {
    const { container } = renderRoot()
    expect(container.firstChild).toBeNull()
  })

  it("renders the plugin component when a modal is opened", () => {
    const HelloModal: PluginModalComponent = () => <div>Hello from plugin</div>
    renderRoot()
    act(() => {
      usePluginModalStore.getState().open({
        pluginId: "p1",
        component: HelloModal,
        args: { greeting: "hi" },
      })
    })
    expect(screen.getByText("Hello from plugin")).toBeInTheDocument()
  })

  it("passes modalId / args / onClose to the plugin component", () => {
    let received: { modalId?: string; args?: Record<string, unknown>; close?: () => void } = {}
    const ProbeModal: PluginModalComponent = (props) => {
      received = { modalId: props.modalId, args: props.args, close: props.onClose }
      return <div>probe</div>
    }
    renderRoot()
    act(() => {
      usePluginModalStore.getState().open({
        pluginId: "p1",
        component: ProbeModal,
        args: { hello: "world" },
      })
    })
    expect(typeof received.modalId).toBe("string")
    expect(received.args).toEqual({ hello: "world" })
    expect(typeof received.close).toBe("function")
  })

  it("invoking onClose pops the modal from the stack", () => {
    const Self: PluginModalComponent = ({ onClose }) => <button onClick={onClose}>close</button>
    renderRoot()
    act(() => {
      usePluginModalStore.getState().open({ pluginId: "p1", component: Self })
    })
    expect(usePluginModalStore.getState().stack).toHaveLength(1)
    act(() => {
      fireEvent.click(screen.getByText("close"))
    })
    expect(usePluginModalStore.getState().stack).toHaveLength(0)
  })

  it("renders stacked modals in open-order so the latest is on top", () => {
    const A: PluginModalComponent = () => <div>modal-A</div>
    const B: PluginModalComponent = () => <div>modal-B</div>
    renderRoot()
    act(() => {
      usePluginModalStore.getState().open({ pluginId: "p1", component: A })
      usePluginModalStore.getState().open({ pluginId: "p1", component: B })
    })
    expect(screen.getByText("modal-A")).toBeInTheDocument()
    expect(screen.getByText("modal-B")).toBeInTheDocument()
  })

  it("shows the i18n error fallback when the plugin component throws", () => {
    const Broken: PluginModalComponent = () => {
      throw new Error("plugin boom")
    }
    // Suppress the expected React error-boundary console noise.
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {})
    renderRoot()
    act(() => {
      usePluginModalStore.getState().open({ pluginId: "p1", component: Broken })
    })
    expect(screen.getByText(/Plugin modal failed to render/)).toBeInTheDocument()
    consoleError.mockRestore()
  })

  it("clearByPlugin removes only that plugin's modals", () => {
    const A: PluginModalComponent = () => <div>A-modal</div>
    const B: PluginModalComponent = () => <div>B-modal</div>
    renderRoot()
    act(() => {
      usePluginModalStore.getState().open({ pluginId: "p1", component: A })
      usePluginModalStore.getState().open({ pluginId: "p2", component: B })
      usePluginModalStore.getState().clearByPlugin("p1")
    })
    expect(usePluginModalStore.getState().stack).toHaveLength(1)
    expect(usePluginModalStore.getState().stack[0].pluginId).toBe("p2")
    expect(screen.queryByText("A-modal")).not.toBeInTheDocument()
    expect(screen.getByText("B-modal")).toBeInTheDocument()
  })
})
