/** @jest-environment jsdom */
import { renderHook, act } from "@testing-library/react"
import { useMonacoWorkbench } from "./use-monaco-workbench"
import type {
  IMonacoEditor,
  MonacoNamespace,
  MonacoWorkbenchSpec,
} from "@/lib/editor-workbench/monaco-workbench"

const mountFn = jest.fn()
const disposeFn = jest.fn()

jest.mock("@/lib/editor-workbench/monaco-workbench", () => ({
  mountMonacoWorkbench: (...args: unknown[]) => {
    mountFn(...args)
    const uri = "canvas:///s/d.ts"
    return { uri, dispose: disposeFn }
  },
}))

function makeEditor(): IMonacoEditor {
  return {
    getId: () => "ed-x",
    getModel: () => null,
    setModel: () => {},
    getPosition: () => null,
    getSelection: () => null,
    onDidFocusEditorWidget: () => ({ dispose: () => {} }),
    onDidBlurEditorWidget: () => ({ dispose: () => {} }),
    onDidChangeCursorSelection: () => ({ dispose: () => {} }),
    executeEdits: () => true,
    deltaDecorations: () => [],
  }
}

function makeMonaco(): MonacoNamespace {
  return {
    Uri: { parse: (v: string) => ({ toString: () => v }) },
    editor: {
      createModel: () =>
        ({
          uri: { toString: () => "x" },
          getLanguageId: () => "typescript",
          getValue: () => "",
          setValue: () => {},
          getLineCount: () => 0,
          getLineContent: () => "",
          isDisposed: () => false,
          onDidChangeContent: () => ({ dispose: () => {} }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
      getModel: () => null,
    },
  }
}

beforeEach(() => {
  mountFn.mockClear()
  disposeFn.mockClear()
})

describe("useMonacoWorkbench", () => {
  const spec: MonacoWorkbenchSpec = {
    surface: "canvas",
    sessionId: "s",
    documentId: "d",
    language: "typescript",
    initialContent: "",
  }

  it("returns a stable onMount and a getCurrentUri reading the handle", () => {
    const { result, rerender } = renderHook(({ s }) => useMonacoWorkbench(s), {
      initialProps: { s: spec as MonacoWorkbenchSpec | null },
    })
    const firstOnMount = result.current.onMount
    rerender({ s: { ...spec, documentId: "d2" } })
    expect(result.current.onMount).toBe(firstOnMount)
    expect(result.current.getCurrentUri()).toBeNull()
  })

  it("invokes mountMonacoWorkbench with the spec on first mount", () => {
    const { result } = renderHook(() => useMonacoWorkbench(spec))
    act(() => {
      result.current.onMount(makeEditor(), makeMonaco())
    })
    expect(mountFn).toHaveBeenCalledTimes(1)
    expect(mountFn.mock.calls[0]?.[2]).toEqual(spec)
    expect(result.current.getCurrentUri()).toBe("canvas:///s/d.ts")
  })

  it("disposes the previous handle when remounted with a fresh editor", () => {
    const { result } = renderHook(() => useMonacoWorkbench(spec))
    act(() => {
      result.current.onMount(makeEditor(), makeMonaco())
    })
    act(() => {
      result.current.onMount(makeEditor(), makeMonaco())
    })
    expect(mountFn).toHaveBeenCalledTimes(2)
    expect(disposeFn).toHaveBeenCalledTimes(1)
  })

  it("does nothing if spec is null at mount time", () => {
    const { result } = renderHook(() => useMonacoWorkbench(null))
    act(() => {
      result.current.onMount(makeEditor(), makeMonaco())
    })
    expect(mountFn).not.toHaveBeenCalled()
  })

  it("disposes the active handle on component unmount", () => {
    const { result, unmount } = renderHook(() => useMonacoWorkbench(spec))
    act(() => {
      result.current.onMount(makeEditor(), makeMonaco())
    })
    unmount()
    expect(disposeFn).toHaveBeenCalledTimes(1)
  })

  it("uses the freshest spec held in the ref when onMount fires", () => {
    const { result, rerender } = renderHook(({ s }) => useMonacoWorkbench(s), {
      initialProps: { s: spec as MonacoWorkbenchSpec | null },
    })
    const updated: MonacoWorkbenchSpec = { ...spec, documentId: "d-updated" }
    rerender({ s: updated })
    act(() => {
      result.current.onMount(makeEditor(), makeMonaco())
    })
    expect(mountFn.mock.calls[0]?.[2]).toEqual(updated)
  })
})
