/**
 * @jest-environment jsdom
 */
import { render } from "@testing-library/react"
import { PROJECT_EDITOR_GOTO_EVENT } from "./editor-events"

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))
let mockResolvedTheme: string | undefined = "dark"
jest.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: mockResolvedTheme }) }))

const mountMock = jest.fn((..._a: unknown[]) => ({
  uri: "file:///repo/src/a.ts",
  dispose: jest.fn(),
}))
jest.mock("@/lib/editor-workbench/monaco-workbench", () => ({
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
let capturedOnChange: ((v: string) => void) | null = null
jest.mock("@monaco-editor/react", () => {
  const React = require("react")
  const MockEditor = ({
    onMount,
    onChange,
  }: {
    onMount: (e: unknown, m: unknown) => void
    onChange: (v: string) => void
  }) => {
    capturedOnChange = onChange
    // Mimic @monaco-editor/react: fire onMount exactly once, even if the effect
    // re-runs — a ref guard keeps mount-once semantics while `onMount` stays a dep.
    const mountedRef = React.useRef(false)
    React.useEffect(() => {
      if (mountedRef.current) return
      mountedRef.current = true
      const editor = { revealLineInCenter, setPosition, focus, getId: () => "ed1" }
      onMount(editor, { editor: {}, languages: {} })
    }, [onMount])
    return React.createElement("div", { "data-testid": "monaco" })
  }
  return { __esModule: true, default: MockEditor }
})

import { ProjectMonaco } from "./project-monaco"
import type { OpenFile } from "./use-project-editor"

const file: OpenFile = {
  relPath: "src/a.ts",
  absolutePath: "/repo/src/a.ts",
  language: "typescript",
  savedContent: "x",
  draftContent: "x",
}

beforeEach(() => {
  mountMock.mockClear()
  registerActionsMock.mockClear()
  revealLineInCenter.mockClear()
  capturedOnChange = null
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
})
