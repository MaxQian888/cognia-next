/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import "@testing-library/jest-dom"
import { Activity, useEffect, useState } from "react"
import { act, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { createEditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"

// The dedicated per-kind config form would mount heavy UI (Monaco for the
// raw-JSON editor, scheme-form etc.); stub it with a button that just
// forwards `onChange` so we can drive the debounce path deterministically.
// The button also fills `userPrompt` — the one required ai.prompt param — so
// a click turns an invalid node valid. Two real `Field` rows give the
// jump-to-field path something to find: a plain input, and a stand-in for
// `ExpressionField` whose editable surface mounts one tick late, the way
// CodeMirror builds `.cm-content` in an effect.
const mockConfigChanges = jest.fn()
jest.mock("./inspector/node-config-registry", () => ({
  getNodeConfigComponentForEntry: () =>
    function MockNodeConfig({
      params,
      onChange,
    }: {
      params: Record<string, unknown>
      onChange: (next: Record<string, unknown>) => void
    }) {
      mockConfigChanges(params)
      const { Field } = jest.requireActual("./inspector/forms/shared") as {
        Field: typeof import("./inspector/forms/shared").Field
      }
      return (
        <>
          <button
            type="button"
            data-testid="mock-node-config-trigger"
            onClick={() =>
              onChange({ ...params, userPrompt: "filled", hit: (Number(params.hit) || 0) + 1 })
            }
          >
            edit-config
          </button>
          <Field label="System prompt" htmlFor="mock-system" name="systemPrompt">
            <input id="mock-system" data-testid="mock-system-input" />
          </Field>
          <Field label="User prompt" htmlFor="mock-user-prompt" name="userPrompt" required>
            <MockLateExpressionField />
          </Field>
        </>
      )
    },
  hasDedicatedConfigForEntry: () => true,
}))

/** Mimics ExpressionField: marker root now, editable surface after a delay. */
function MockLateExpressionField() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 50)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div data-expression-field="true">
      <button type="button" data-testid="mock-variable-picker">
        vars
      </button>
      {mounted ? (
        <div
          className="cm-content"
          contentEditable="true"
          suppressContentEditableWarning
          tabIndex={0}
          data-testid="mock-cm-content"
        />
      ) : null}
    </div>
  )
}

// Imported after the mock so the InspectorPanel resolves to the stubbed
// registry above.
import { InspectorPanel } from "./inspector-panel"
import { addPluginCatalogEntry, __resetPluginCatalogForTesting } from "@/lib/workflow/nodes/catalog"
import { registerPluginI18n, __resetPluginI18nForTesting } from "@/lib/i18n/plugin-i18n-registry"

const MESSAGES = {
  workflows: {
    inspector: {
      empty: "Pick a node",
      closeAria: "Close inspector",
      label: "Label",
      notes: "Notes",
      notesHint: "Optional",
      disabled: "Disabled",
      disabledHint: "Skip during runs",
      deleteNode: "Delete node",
      categoryBadge: {
        trigger: "Trigger",
        action: "Action",
        ai: "AI",
        flow: "Flow",
        data: "Data",
        io: "I/O",
        annotation: "Note",
      },
      errorBadge: "{count} issue(s)",
      jumpToError: "Jump to next error",
      noConfigYet: "No config yet",
    },
    nodes: {},
  },
}

function buildWorkflow(): VisualWorkflow {
  return {
    id: "wf_test",
    schemaVersion: 1,
    name: "Sample",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "n_a",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Prompt A", params: {} },
      },
      {
        id: "n_b",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 200, y: 0 },
        data: { label: "Prompt B", params: {} },
      },
    ],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000 },
    },
  }
}

function mountInspector(store: ReturnType<typeof createEditorStore>) {
  return render(
    <NextIntlClientProvider locale="en" messages={MESSAGES as never} timeZone="UTC">
      <InspectorPanel useStore={store} />
    </NextIntlClientProvider>
  )
}

/**
 * Mount the panel the way the Context Workbench does: behind `<Activity>`,
 * which keeps the DOM + state of a panel that is not in front but tears its
 * effects down (and back up when it returns).
 */
function mountInWorkbench(store: ReturnType<typeof createEditorStore>, visible: boolean) {
  const ui = (mode: "visible" | "hidden") => (
    <NextIntlClientProvider locale="en" messages={MESSAGES as never} timeZone="UTC">
      <Activity mode={mode}>
        <InspectorPanel useStore={store} />
      </Activity>
    </NextIntlClientProvider>
  )
  const view = render(ui(visible ? "visible" : "hidden"))
  return {
    ...view,
    show: () => view.rerender(ui("visible")),
    hide: () => view.rerender(ui("hidden")),
  }
}

describe("InspectorPanel", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockConfigChanges.mockClear()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("renders the empty placeholder when no node is selected", () => {
    const store = createEditorStore(buildWorkflow())
    mountInspector(store)
    expect(screen.getByTestId("workflow-inspector-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("workflow-inspector")).toBeNull()
  })

  it("renders the form for the selected node", () => {
    const store = createEditorStore(buildWorkflow())
    act(() => {
      store.getState().setSelectedNodes(["n_a"])
    })
    mountInspector(store)
    expect(screen.getByTestId("workflow-inspector")).toBeInTheDocument()
    expect(screen.getByDisplayValue("Prompt A")).toBeInTheDocument()
  })

  it("hands off to the bulk inspector when more than one node is selected", () => {
    const store = createEditorStore(buildWorkflow())
    act(() => {
      store.getState().setSelectedNodes(["n_a", "n_b"])
    })
    mountInspector(store)
    expect(screen.getByTestId("workflow-bulk-inspector")).toBeInTheDocument()
    // The single-node form is not mounted for a multi-selection.
    expect(screen.queryByTestId("workflow-inspector")).toBeNull()
  })

  it("surfaces a clickable error badge that jumps without throwing", () => {
    const store = createEditorStore(buildWorkflow())
    act(() => {
      store.getState().setSelectedNodes(["n_a"])
      // ai.prompt with empty params → missing required userPrompt.
      store.getState().revalidateNode("n_a")
    })
    mountInspector(store)
    const badge = screen.getByTestId("inspector-error-badge")
    expect(badge.tagName).toBe("BUTTON")
    expect(badge).toHaveAttribute("aria-label", "Jump to next error")
    act(() => {
      badge.click()
    })
    // Still mounted (handler ran; no field target → top-scroll fallback).
    expect(screen.getByTestId("workflow-inspector")).toBeInTheDocument()
  })

  it("debounces revalidate across multiple keystrokes (single trailing fire)", () => {
    const store = createEditorStore(buildWorkflow())
    const revalidateSpy = jest.spyOn(store.getState(), "revalidateNode")
    act(() => {
      store.getState().setSelectedNodes(["n_a"])
    })
    mountInspector(store)

    const trigger = screen.getByTestId("mock-node-config-trigger")
    act(() => {
      trigger.click()
      trigger.click()
      trigger.click()
    })
    // Three "keystrokes" — debouncer hasn't fired yet.
    expect(revalidateSpy).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(150)
    })
    expect(revalidateSpy).toHaveBeenCalledTimes(1)
    expect(revalidateSpy).toHaveBeenCalledWith("n_a")
  })

  it("flushes the pending revalidate when the user picks a different node", () => {
    const store = createEditorStore(buildWorkflow())
    const revalidateSpy = jest.spyOn(store.getState(), "revalidateNode")
    act(() => {
      store.getState().setSelectedNodes(["n_a"])
    })
    mountInspector(store)

    const trigger = screen.getByTestId("mock-node-config-trigger")
    act(() => {
      trigger.click()
    })
    expect(revalidateSpy).not.toHaveBeenCalled()

    // Selection switches before the 150ms window closes → flush must fire
    // for the previous node so its in-flight validation isn't lost.
    act(() => {
      store.getState().setSelectedNodes(["n_b"])
    })
    expect(revalidateSpy).toHaveBeenCalledTimes(1)
    expect(revalidateSpy).toHaveBeenCalledWith("n_a")
  })

  describe("validation convergence races", () => {
    function invalidSelectedStore() {
      const store = createEditorStore(buildWorkflow())
      act(() => {
        store.getState().setSelectedNodes(["n_a"])
        // Cached error: ai.prompt with no userPrompt.
        store.getState().revalidateNode("n_a")
      })
      expect(store.getState().validationByStepId.n_a).toBeDefined()
      return store
    }

    it("settles the queued revalidation when the inspector unmounts mid-debounce", () => {
      const store = invalidSelectedStore()
      const view = mountInspector(store)
      act(() => {
        screen.getByTestId("mock-node-config-trigger").click()
      })
      // Still inside the 150ms window — nothing written yet.
      expect(store.getState().validationByStepId.n_a).toBeDefined()

      view.unmount()

      // A component-owned debounce used to die here and leave the cached
      // error behind; the node badge then read "1" until a reload.
      expect(store.getState().validationByStepId.n_a).toBeUndefined()
    })

    it("settles it when the workbench hides the inspector behind another panel", () => {
      const store = invalidSelectedStore()
      const view = mountInWorkbench(store, true)
      act(() => {
        screen.getByTestId("mock-node-config-trigger").click()
      })
      act(() => view.hide())
      expect(store.getState().validationByStepId.n_a).toBeUndefined()
    })

    it("settles it after a remount without a double revalidation", () => {
      const store = invalidSelectedStore()
      const revalidateSpy = jest.spyOn(store.getState(), "revalidateNode")
      const first = mountInspector(store)
      act(() => {
        screen.getByTestId("mock-node-config-trigger").click()
      })
      first.unmount()
      mountInspector(store)
      act(() => {
        jest.advanceTimersByTime(500)
      })
      expect(revalidateSpy).toHaveBeenCalledTimes(1)
      expect(store.getState().validationByStepId.n_a).toBeUndefined()
    })

    it("settles it when the selection changes while the inspector is hidden", () => {
      const store = invalidSelectedStore()
      const revalidateSpy = jest.spyOn(store.getState(), "revalidateNode")
      const view = mountInWorkbench(store, true)
      act(() => {
        // Edit, then another panel comes to the front before the window closes…
        screen.getByTestId("mock-node-config-trigger").click()
      })
      act(() => view.hide())
      act(() => {
        // …and the user picks another node there. Nothing may be pending or
        // re-run for the node they left.
        store.getState().setSelectedNodes(["n_b"])
        jest.advanceTimersByTime(500)
      })
      expect(revalidateSpy).toHaveBeenCalledTimes(1)
      expect(revalidateSpy).toHaveBeenCalledWith("n_a")
      expect(store.getState().validationByStepId.n_a).toBeUndefined()
    })

    it("keeps the error when the edit did not fix it", () => {
      const store = createEditorStore(buildWorkflow())
      act(() => {
        store.getState().setSelectedNodes(["n_a"])
      })
      const view = mountInspector(store)
      act(() => {
        store.getState().updateNodeData("n_a", { params: { userPrompt: "" } })
        store.getState().scheduleRevalidateNode("n_a")
      })
      view.unmount()
      expect(store.getState().validationByStepId.n_a?.fields.userPrompt).toMatchObject({
        key: "required",
      })
    })
  })

  describe("jump to field", () => {
    it("focuses the requested field once its expression editor has mounted", () => {
      const store = createEditorStore(buildWorkflow())
      mountInspector(store)
      act(() => {
        store.getState().requestFieldFocus({ nodeId: "n_a", field: "userPrompt" })
      })
      // The editable surface is not there yet — the variable picker above it
      // must not be taken as the target.
      expect(document.activeElement).not.toBe(screen.getByTestId("mock-variable-picker"))
      expect(store.getState().requestedFieldFocus).not.toBeNull()

      // The editor surface mounts at 50ms; the per-frame retry picks it up on
      // the next frame after React commits it.
      act(() => {
        jest.advanceTimersByTime(60)
      })
      act(() => {
        jest.advanceTimersByTime(50)
      })
      expect(document.activeElement).toBe(screen.getByTestId("mock-cm-content"))
      expect(store.getState().requestedFieldFocus).toBeNull()
    })

    it("marks the requested field invalid even on a node that was never validated", () => {
      const store = createEditorStore(buildWorkflow())
      mountInspector(store)
      act(() => {
        store.getState().requestFieldFocus({ nodeId: "n_a", field: "userPrompt" })
      })
      // Diagnostics are seeded on open but the per-field cache is not; the
      // request validates the node so the row it names carries the marker.
      const row = document.querySelector('[data-field="userPrompt"]')
      expect(row).toHaveAttribute("data-invalid", "true")
      expect(screen.getByTestId("field-error-userPrompt")).toBeInTheDocument()
    })

    it("cycles the header error badge onto the invalid field's editor", () => {
      const store = createEditorStore(buildWorkflow())
      act(() => {
        store.getState().setSelectedNodes(["n_a"])
        store.getState().revalidateNode("n_a")
      })
      mountInspector(store)
      act(() => {
        jest.advanceTimersByTime(100)
      })
      act(() => {
        screen.getByTestId("inspector-error-badge").click()
      })
      expect(document.activeElement).toBe(screen.getByTestId("mock-cm-content"))
    })

    it("focuses a plain input field immediately", () => {
      const store = createEditorStore(buildWorkflow())
      mountInspector(store)
      act(() => {
        store.getState().requestFieldFocus({ nodeId: "n_a", field: "systemPrompt" })
      })
      expect(document.activeElement).toBe(screen.getByTestId("mock-system-input"))
      expect(store.getState().requestedFieldFocus).toBeNull()
    })

    it("waits while the inspector is hidden and focuses once it is brought forward", () => {
      const store = createEditorStore(buildWorkflow())
      const view = mountInWorkbench(store, false)
      act(() => {
        store.getState().requestFieldFocus({ nodeId: "n_a", field: "systemPrompt" })
        jest.advanceTimersByTime(5_000)
      })
      // Hidden panels run no effects — the request survives untouched.
      expect(store.getState().requestedFieldFocus).not.toBeNull()
      expect(document.activeElement).toBe(document.body)

      act(() => view.show())
      expect(document.activeElement).toBe(screen.getByTestId("mock-system-input"))
      expect(store.getState().requestedFieldFocus).toBeNull()
    })

    it("drops a request once the user has selected a different node", () => {
      const store = createEditorStore(buildWorkflow())
      const view = mountInWorkbench(store, false)
      act(() => {
        store.getState().requestFieldFocus({ nodeId: "n_a", field: "systemPrompt" })
        store.getState().setSelectedNodes(["n_b"])
      })
      act(() => view.show())
      expect(store.getState().requestedFieldFocus).toBeNull()
      expect(document.activeElement).toBe(document.body)
    })

    it("falls back to the first invalid field for an object-level problem", () => {
      const store = createEditorStore(buildWorkflow())
      mountInspector(store)
      act(() => {
        store.getState().requestFieldFocus({ nodeId: "n_a", field: "_root" })
      })
      act(() => {
        jest.advanceTimersByTime(60)
      })
      act(() => {
        jest.advanceTimersByTime(50)
      })
      // `_root` names no row; the invalid `userPrompt` row is the target.
      expect(document.activeElement).toBe(screen.getByTestId("mock-cm-content"))
    })
  })

  it("does not re-render the memoized config form when an unrelated node is mutated", () => {
    const store = createEditorStore(buildWorkflow())
    act(() => {
      store.getState().setSelectedNodes(["n_a"])
    })
    mountInspector(store)

    // Initial mount already renders the form once.
    const initialRenderCount = mockConfigChanges.mock.calls.length
    expect(initialRenderCount).toBeGreaterThan(0)

    // Mutate the *other* node — selectedId stays "n_a", n_a's data stays
    // identical, so the InspectorPanel's narrow selectors stay shallow-
    // equal and the memoized NodeConfigFormSection must not re-render.
    act(() => {
      store.getState().updateNodeData("n_b", { label: "Renamed B" })
    })

    expect(mockConfigChanges.mock.calls.length).toBe(initialRenderCount)
  })

  it("is wrapped in React.memo so identical-prop parent renders are bailed out", () => {
    const memoMarker = Symbol.for("react.memo")
    expect((InspectorPanel as { $$typeof?: symbol }).$$typeof).toBe(memoMarker)
  })

  describe("plugin node header localization", () => {
    afterEach(() => {
      act(() => {
        __resetPluginCatalogForTesting()
        __resetPluginI18nForTesting()
      })
    })

    function buildPluginWorkflow(): VisualWorkflow {
      const wf = buildWorkflow()
      wf.nodes = [
        {
          id: "n_p",
          type: "demo.action.format" as never,
          typeVersion: 1,
          position: { x: 0, y: 0 },
          // Instance label left at the catalog default (the raw kind) so the
          // header renders the catalog/translated string, not a user rename.
          data: { label: "demo.action.format", params: {} },
        },
      ]
      return wf
    }

    function registerDemoNode() {
      act(() => {
        addPluginCatalogEntry({
          kind: "demo.action.format" as never,
          category: "plugin",
          label: "Format Rust",
          description: "Run rustfmt on a Rust source string",
          iconName: "Wand",
          keywords: [],
          pluginId: "demo",
        })
      })
    }

    it("shows the plugin author's raw label/description when untranslated", () => {
      registerDemoNode()
      const store = createEditorStore(buildPluginWorkflow())
      act(() => {
        store.getState().setSelectedNodes(["n_p"])
      })
      mountInspector(store)
      const header = screen.getByTestId("workflow-inspector")
      expect(header).toHaveTextContent("Format Rust")
      expect(header).toHaveTextContent("Run rustfmt on a Rust source string")
    })

    it("shows the translated label/description from the plugin overlay", () => {
      registerDemoNode()
      act(() => {
        registerPluginI18n({
          pluginId: "demo",
          messages: {
            en: {
              "plugin.demo.workflow.nodes.action.format.label": "格式化 Rust",
              "plugin.demo.workflow.nodes.action.format.description": "运行 rustfmt",
            },
          },
        })
      })
      const store = createEditorStore(buildPluginWorkflow())
      act(() => {
        store.getState().setSelectedNodes(["n_p"])
      })
      mountInspector(store)
      const header = screen.getByTestId("workflow-inspector")
      expect(header).toHaveTextContent("格式化 Rust")
      expect(header).toHaveTextContent("运行 rustfmt")
      expect(header).not.toHaveTextContent("Format Rust")
    })
  })
})
