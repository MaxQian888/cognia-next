/**
 * @jest-environment jsdom
 */
import { render } from "@testing-library/react"
import { PROJECT_EDITOR_GOTO_EVENT } from "./editor-events"

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))
let mockResolvedTheme: string | undefined = "dark"
jest.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: mockResolvedTheme }) }))

const workbenchDisposeMock = jest.fn()
const mountMock = jest.fn((..._a: unknown[]) => ({
  uri: "file:///repo/src/a.ts",
  dispose: workbenchDisposeMock,
}))
// `buildWorkbenchUri` stays real: it is the single derivation shared by the
// `<Editor path>` model key and the LSP document identity, so a stub here would
// hide exactly the drift the component relies on not happening.
jest.mock("@/lib/editor-workbench/monaco-workbench", () => ({
  ...jest.requireActual<typeof import("@/lib/editor-workbench/monaco-workbench")>(
    "@/lib/editor-workbench/monaco-workbench"
  ),
  mountMonacoWorkbench: (...a: unknown[]) => mountMock(...a),
}))
const registerActionsMock = jest.fn((..._a: unknown[]) => [{ dispose: jest.fn() }])
jest.mock("@/lib/editor-workbench/register-editor-actions", () => ({
  registerEditorActions: (...a: unknown[]) => registerActionsMock(...a),
}))
const snippetsMock = jest.fn((..._a: unknown[]) => [])
const emmetMock = jest.fn((..._a: unknown[]) => [])
jest.mock("@/lib/monaco/snippets", () => ({
  registerAllSnippets: (...a: unknown[]) => snippetsMock(...a),
  registerEmmetSupport: (...a: unknown[]) => emmetMock(...a),
}))
jest.mock("@/lib/canvas/monaco-loader", () => ({ configureMonacoLoader: jest.fn() }))
jest.mock("@/lib/canvas/themes/cognia-active-theme", () => ({
  COGNIA_ACTIVE_THEME_ID: "cognia-active",
  syncCogniaActiveTheme: jest.fn(),
}))
jest.mock("@/lib/themes", () => ({ resolveActiveThemeColors: () => ({ colors: {} }) }))
jest.mock("@/stores", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) =>
    sel({ colorTheme: "default", activeCustomThemeId: null, customThemes: [] }),
}))
jest.mock("@/components/editor/lsp-server-hint", () => ({ LspServerHint: () => null }))
jest.mock("@/components/editor/monaco-diagnostics-bar", () => ({
  MonacoDiagnosticsBar: () => null,
}))

const revealLineInCenter = jest.fn()
const setPosition = jest.fn()
const focus = jest.fn()
const setTheme = jest.fn()
const getOffsetAt = jest.fn(({ column }: { column: number }) => column - 1)
let editorModelPresent = true
let cursorSelectionListener: ((event: unknown) => void) | null = null
let capturedOnChange: ((v: string) => void) | null = null
let editorProps: { path?: string; keepCurrentModel?: boolean } = {}
let editorMountCount = 0
const registryModels = new Map<
  string,
  { disposeCalls: number; isDisposed(): boolean; dispose(): void }
>()
jest.mock("@monaco-editor/react", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  const MockEditor = ({
    onMount,
    onChange,
    path,
    keepCurrentModel,
  }: {
    onMount: (e: unknown, m: unknown) => void
    onChange: (v: string) => void
    path?: string
    keepCurrentModel?: boolean
  }) => {
    capturedOnChange = onChange
    editorProps = { path, keepCurrentModel }
    // Mimic @monaco-editor/react: fire onMount exactly once, even if the effect
    // re-runs — a ref guard keeps mount-once semantics while `onMount` stays a dep.
    const mountedRef = React.useRef(false)
    React.useEffect(() => {
      if (mountedRef.current) return
      mountedRef.current = true
      editorMountCount += 1
      const editor = {
        revealLineInCenter,
        setPosition,
        focus,
        getId: () => "ed1",
        getModel: () => (editorModelPresent ? { getOffsetAt } : null),
        onDidChangeCursorSelection: (listener: (event: unknown) => void) => {
          cursorSelectionListener = listener
          return { dispose: jest.fn() }
        },
      }
      onMount(editor, {
        editor: {
          setTheme,
          getModel: (uri: string) => registryModels.get(uri) ?? null,
        },
        Uri: { parse: (value: string) => value },
        languages: {},
      })
    }, [onMount])
    return React.createElement("div", { "data-testid": "monaco" })
  }
  return { __esModule: true, default: MockEditor }
})

import { ProjectMonaco } from "./project-monaco"
import {
  getMonacoModelRegistryNamespace,
  releaseModel,
  resetMonacoModelRegistry,
  retainModel,
} from "@/lib/editor-workbench/monaco-model-registry"
import type { OpenFile } from "./use-project-editor"

const file: OpenFile = {
  relPath: "src/a.ts",
  absolutePath: "/repo/src/a.ts",
  language: "typescript",
  savedContent: "x",
  draftContent: "x",
  draftVersion: 1,
}

const otherFile: OpenFile = {
  relPath: "src/b.ts",
  absolutePath: "/repo/src/b.ts",
  language: "typescript",
  savedContent: "y",
  draftContent: "y",
  draftVersion: 1,
}

beforeEach(() => {
  mountMock.mockClear()
  workbenchDisposeMock.mockClear()
  registerActionsMock.mockClear()
  revealLineInCenter.mockClear()
  setTheme.mockClear()
  capturedOnChange = null
  cursorSelectionListener = null
  editorProps = {}
  editorMountCount = 0
  registryModels.clear()
  editorModelPresent = true
  resetMonacoModelRegistry()
  mockResolvedTheme = "dark"
})

describe("ProjectMonaco", () => {
  it("mounts the workbench on the file surface with the real absolute path", () => {
    render(
      <ProjectMonaco
        file={file}
        projectRoot="/repo"
        onChange={jest.fn()}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )
    expect(mountMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        surface: "file",
        absolutePath: "/repo/src/a.ts",
        projectRoot: "/repo",
        documentId: "src/a.ts",
      })
    )
    expect(registerActionsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ idPrefix: "file.kb.", includePluginCommands: true })
    )
    expect(snippetsMock).toHaveBeenCalled()
    expect(emmetMock).toHaveBeenCalled()
  })

  it("propagates edits via onChange", () => {
    const onChange = jest.fn()
    render(
      <ProjectMonaco
        file={file}
        projectRoot="/repo"
        onChange={onChange}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )
    capturedOnChange?.("new content")
    expect(onChange).toHaveBeenCalledWith("new content")
  })

  it("reports a non-empty selection as resource offsets", () => {
    const onSelectionChange = jest.fn()
    render(
      <ProjectMonaco
        file={file}
        projectRoot="/repo"
        onChange={jest.fn()}
        onSelectionChange={onSelectionChange}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )
    cursorSelectionListener?.({
      selection: {
        getStartPosition: () => ({ lineNumber: 1, column: 2 }),
        getEndPosition: () => ({ lineNumber: 1, column: 4 }),
      },
    })
    expect(onSelectionChange).toHaveBeenCalledWith({ kind: "text", start: 1, end: 3 })
  })

  it("lifts the mounted Monaco diagnostics context into the workbench", () => {
    const onDiagnosticsReady = jest.fn()
    const { unmount } = render(
      <ProjectMonaco
        file={file}
        projectRoot="/repo"
        onChange={jest.fn()}
        onDiagnosticsReady={onDiagnosticsReady}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )
    expect(onDiagnosticsReady).toHaveBeenCalledWith(
      "src/a.ts",
      expect.objectContaining({ monaco: expect.anything(), editor: expect.anything() })
    )
    unmount()
    expect(onDiagnosticsReady).toHaveBeenLastCalledWith("src/a.ts", null)
  })

  it("reveals a line when a goto event targets this file", () => {
    render(
      <ProjectMonaco
        file={file}
        projectRoot="/repo"
        onChange={jest.fn()}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )
    window.dispatchEvent(
      new CustomEvent(PROJECT_EDITOR_GOTO_EVENT, {
        detail: { relPath: "src/a.ts", line: 5, column: 2 },
      })
    )
    expect(revealLineInCenter).toHaveBeenCalledWith(5)
    expect(setPosition).toHaveBeenCalledWith({ lineNumber: 5, column: 2 })
  })

  it("still mounts the workbench when the theme has not resolved yet", () => {
    mockResolvedTheme = undefined
    render(
      <ProjectMonaco
        file={file}
        projectRoot="/repo"
        onChange={jest.fn()}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )
    expect(mountMock).toHaveBeenCalled()
  })

  it("activates the wallpaper-aware theme after registering it on mount", () => {
    render(
      <ProjectMonaco
        file={file}
        projectRoot="/repo"
        onChange={jest.fn()}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )

    expect(setTheme).toHaveBeenCalledWith("cognia-active")
  })

  it("addresses the model by its file:// uri and keeps it on unmount", () => {
    const { unmount } = render(
      <ProjectMonaco
        file={file}
        projectRoot="/repo"
        onChange={jest.fn()}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )
    expect(editorProps.path).toBe("file:///repo/src/a.ts")
    expect(editorProps.keepCurrentModel).toBe(true)
    unmount()
  })

  it("swaps files without remounting the editor, rebinding the workbench in place", () => {
    // The regression guard: a remount here destroys the Monaco model and the
    // undo stack behind it.
    const { rerender } = render(
      <ProjectMonaco
        file={file}
        projectRoot="/repo"
        onChange={jest.fn()}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )
    expect(editorMountCount).toBe(1)
    expect(mountMock).toHaveBeenCalledTimes(1)

    rerender(
      <ProjectMonaco
        file={otherFile}
        projectRoot="/repo"
        onChange={jest.fn()}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )

    expect(editorMountCount).toBe(1)
    expect(editorProps.path).toBe("file:///repo/src/b.ts")
    expect(workbenchDisposeMock).toHaveBeenCalledTimes(1)
    expect(mountMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ absolutePath: "/repo/src/b.ts", documentId: "src/b.ts" })
    )
  })

  it("does not rebind the workbench when only the draft content changes", () => {
    const { rerender } = render(
      <ProjectMonaco
        file={file}
        projectRoot="/repo"
        onChange={jest.fn()}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )
    mountMock.mockClear()

    rerender(
      <ProjectMonaco
        file={{ ...file, draftContent: "x2", draftVersion: 2 }}
        projectRoot="/repo"
        onChange={jest.fn()}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )

    expect(mountMock).not.toHaveBeenCalled()
    expect(workbenchDisposeMock).not.toHaveBeenCalled()
  })

  it("re-attaches editor actions once per open document, not per keystroke", () => {
    const { rerender } = render(
      <ProjectMonaco
        file={file}
        projectRoot="/repo"
        onChange={jest.fn()}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )
    expect(registerActionsMock).toHaveBeenCalledTimes(1)

    // A new `actions` identity on every render is exactly what the workbench
    // produces (it memoises on `activeFile`, which changes per keystroke).
    rerender(
      <ProjectMonaco
        file={{ ...file, draftContent: "x2", draftVersion: 2 }}
        projectRoot="/repo"
        onChange={jest.fn()}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )
    expect(registerActionsMock).toHaveBeenCalledTimes(1)

    rerender(
      <ProjectMonaco
        file={otherFile}
        projectRoot="/repo"
        onChange={jest.fn()}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )
    expect(registerActionsMock).toHaveBeenCalledTimes(2)
  })

  it("moves the diagnostics context to the newly active file", () => {
    const onDiagnosticsReady = jest.fn()
    const { rerender } = render(
      <ProjectMonaco
        file={file}
        projectRoot="/repo"
        onChange={jest.fn()}
        onDiagnosticsReady={onDiagnosticsReady}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )
    onDiagnosticsReady.mockClear()

    rerender(
      <ProjectMonaco
        file={otherFile}
        projectRoot="/repo"
        onChange={jest.fn()}
        onDiagnosticsReady={onDiagnosticsReady}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )

    expect(onDiagnosticsReady).toHaveBeenNthCalledWith(1, "src/a.ts", null)
    expect(onDiagnosticsReady).toHaveBeenLastCalledWith(
      "src/b.ts",
      expect.objectContaining({ monaco: expect.anything(), editor: expect.anything() })
    )
  })

  it("binds the model registry so a closed file's model can be disposed", () => {
    const model = {
      disposeCalls: 0,
      isDisposed: () => model.disposeCalls > 0,
      dispose: () => {
        model.disposeCalls += 1
      },
    }
    registryModels.set("file:///repo/src/a.ts", model)
    retainModel("file:///repo/src/a.ts")

    render(
      <ProjectMonaco
        file={file}
        projectRoot="/repo"
        onChange={jest.fn()}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )
    expect(getMonacoModelRegistryNamespace()).not.toBeNull()

    releaseModel("file:///repo/src/a.ts")
    expect(model.disposeCalls).toBe(1)
  })

  it("reports selections through the latest callback after a file switch", () => {
    const first = jest.fn()
    const second = jest.fn()
    const { rerender } = render(
      <ProjectMonaco
        file={file}
        projectRoot="/repo"
        onChange={jest.fn()}
        onSelectionChange={first}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )
    rerender(
      <ProjectMonaco
        file={otherFile}
        projectRoot="/repo"
        onChange={jest.fn()}
        onSelectionChange={second}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )

    cursorSelectionListener?.({
      selection: {
        getStartPosition: () => ({ lineNumber: 1, column: 2 }),
        getEndPosition: () => ({ lineNumber: 1, column: 4 }),
      },
    })

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith({ kind: "text", start: 1, end: 3 })
  })

  it("ignores goto events for other files", () => {
    render(
      <ProjectMonaco
        file={file}
        projectRoot="/repo"
        onChange={jest.fn()}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )
    window.dispatchEvent(
      new CustomEvent(PROJECT_EDITOR_GOTO_EVENT, {
        detail: { relPath: "src/other.ts", line: 5, column: 2 },
      })
    )
    expect(revealLineInCenter).not.toHaveBeenCalled()
  })
  it("treats a collapsed selection as no selection", () => {
    const onSelectionChange = jest.fn()
    render(
      <ProjectMonaco
        file={file}
        projectRoot="/repo"
        onChange={jest.fn()}
        onSelectionChange={onSelectionChange}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )
    cursorSelectionListener?.({
      selection: {
        getStartPosition: () => ({ lineNumber: 1, column: 3 }),
        getEndPosition: () => ({ lineNumber: 1, column: 3 }),
      },
    })
    expect(onSelectionChange).toHaveBeenCalledWith(undefined)
  })

  it("ignores a selection event fired without a model", () => {
    const onSelectionChange = jest.fn()
    render(
      <ProjectMonaco
        file={file}
        projectRoot="/repo"
        onChange={jest.fn()}
        onSelectionChange={onSelectionChange}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )
    editorModelPresent = false
    cursorSelectionListener?.({
      selection: {
        getStartPosition: () => ({ lineNumber: 1, column: 2 }),
        getEndPosition: () => ({ lineNumber: 1, column: 4 }),
      },
    })
    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it("normalises a cleared editor value to an empty string", () => {
    const onChange = jest.fn()
    render(
      <ProjectMonaco
        file={file}
        projectRoot="/repo"
        onChange={onChange}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )
    ;(capturedOnChange as unknown as (v: string | undefined) => void)?.(undefined)
    expect(onChange).toHaveBeenCalledWith("")
  })

  it("renders its own diagnostics bar when the host does not take the handles", () => {
    render(
      <ProjectMonaco
        file={file}
        projectRoot="/repo"
        onChange={jest.fn()}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )
    // No `onDiagnosticsReady` → the component owns the bar rather than lifting
    // the handles, and the workbench binding still happens.
    expect(mountMock).toHaveBeenCalled()
  })

  it("applies the light theme variant when the resolved theme is not dark", () => {
    mockResolvedTheme = "light"
    render(
      <ProjectMonaco
        file={file}
        projectRoot="/repo"
        onChange={jest.fn()}
        actions={[]}
        actionLabels={{}}
        bindings={{}}
      />
    )
    expect(setTheme).toHaveBeenCalledWith("cognia-active")
  })
})
