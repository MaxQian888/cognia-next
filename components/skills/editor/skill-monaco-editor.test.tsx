/**
 * @jest-environment jsdom
 */

const fakeEditor = {
  id: "monaco-1",
  getModel: () => ({ uri: { toString: () => "skill:///fake/uri" } }),
  setPosition: jest.fn(),
  revealLineInCenterIfOutsideViewport: jest.fn(),
  focus: jest.fn(),
  getAction: () => ({ run: jest.fn() }),
}
const fakeMonaco = {
  editor: {
    defineTheme: jest.fn(),
    setTheme: jest.fn(),
    getModelMarkers: () => [],
    onDidChangeMarkers: () => ({ dispose: () => {} }),
  },
  languages: {},
  Uri: {},
}

jest.mock("@monaco-editor/react", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react")
  const MockEditor = ({
    value,
    onChange,
    language,
    onMount,
  }: {
    value: string
    onChange: (v: string | undefined) => void
    language: string
    onMount?: (editor: unknown, monaco: unknown) => void
  }) => {
    // The real Editor fires onMount asynchronously after layout. Mirror that
    // with an effect (RTL's act() flushes it within render) so consumers can
    // safely setState in onMount without "update during render" errors.
    React.useEffect(() => {
      onMount?.(fakeEditor, fakeMonaco)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return (
      <textarea
        data-testid="monaco-mock"
        data-language={language}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }
  return { __esModule: true, default: MockEditor, loader: { config: jest.fn() } }
})

jest.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}))

jest.mock("@/lib/canvas/monaco-loader", () => ({
  configureMonacoLoader: jest.fn(),
}))

const mountSpy = jest.fn()
const disposeSpy = jest.fn()
jest.mock("@/lib/editor-workbench/monaco-workbench", () => ({
  mountMonacoWorkbench: (editor: unknown, monaco: unknown, spec: unknown) => {
    mountSpy(editor, monaco, spec)
    return { uri: "skill:///fake/uri", dispose: disposeSpy }
  },
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { SkillMonacoEditor } from "./skill-monaco-editor"

beforeEach(() => {
  mountSpy.mockClear()
  disposeSpy.mockClear()
})

describe("SkillMonacoEditor", () => {
  it("renders Monaco with the requested language", () => {
    render(<SkillMonacoEditor value="body" language="markdown" onChange={jest.fn()} />)
    expect(screen.getByTestId("monaco-mock")).toHaveAttribute("data-language", "markdown")
  })

  it("renders the diagnostics bar once the editor mounts", () => {
    render(<SkillMonacoEditor value="body" language="typescript" onChange={jest.fn()} />)
    expect(screen.getByTestId("monaco-diagnostics-bar")).toBeInTheDocument()
    expect(screen.getByText("No problems")).toBeInTheDocument()
  })

  it("forwards changes to onChange", () => {
    const onChange = jest.fn()
    render(<SkillMonacoEditor value="body" language="markdown" onChange={onChange} />)
    fireEvent.change(screen.getByTestId("monaco-mock"), { target: { value: "edited" } })
    expect(onChange).toHaveBeenCalledWith("edited")
  })

  it("mounts the workbench with the right URI spec when skillId + documentId are provided", () => {
    render(
      <SkillMonacoEditor
        value="content"
        language="typescript"
        onChange={jest.fn()}
        skillId="skill-A"
        documentId="file-7"
      />
    )
    expect(mountSpy).toHaveBeenCalledTimes(1)
    const [editor, monaco, spec] = mountSpy.mock.calls[0]
    expect(editor).toBe(fakeEditor)
    expect(monaco).toBe(fakeMonaco)
    expect(spec).toMatchObject({
      surface: "skill",
      skillId: "skill-A",
      documentId: "file-7",
      language: "typescript",
      initialContent: "content",
    })
  })

  it("skips workbench mount when no skillId or documentId provided (defensive)", () => {
    render(<SkillMonacoEditor value="x" language="markdown" onChange={jest.fn()} />)
    expect(mountSpy).not.toHaveBeenCalled()
  })

  it("disposes the workbench handle when the editor unmounts", () => {
    const { unmount } = render(
      <SkillMonacoEditor
        value="x"
        language="typescript"
        onChange={jest.fn()}
        skillId="s"
        documentId="d"
      />
    )
    expect(mountSpy).toHaveBeenCalledTimes(1)
    unmount()
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it("disposes the workbench handle when documentId changes", () => {
    const { rerender } = render(
      <SkillMonacoEditor
        value="x"
        language="typescript"
        onChange={jest.fn()}
        skillId="s"
        documentId="d1"
      />
    )
    expect(mountSpy).toHaveBeenCalledTimes(1)
    rerender(
      <SkillMonacoEditor
        value="x"
        language="typescript"
        onChange={jest.fn()}
        skillId="s"
        documentId="d2"
      />
    )
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })
})
