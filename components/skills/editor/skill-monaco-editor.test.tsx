/**
 * @jest-environment jsdom
 */

const fakeEditor = { id: "monaco-1" }
const fakeMonaco = { editor: {}, languages: {}, Uri: {} }

jest.mock("@monaco-editor/react", () => ({
  __esModule: true,
  default: ({
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
    // The real Editor fires onMount asynchronously after layout; for unit
    // tests we invoke it synchronously so consumers can assert workbench
    // wiring without extra timers.
    if (onMount) onMount(fakeEditor, fakeMonaco)
    return (
      <textarea
        data-testid="monaco-mock"
        data-language={language}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  },
  loader: { config: jest.fn() },
}))

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
