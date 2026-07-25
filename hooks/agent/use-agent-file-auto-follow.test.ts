import { renderHook } from "@testing-library/react"
import type { UIMessage } from "ai"
import { openInProjectEditor, reflectEditInProjectEditor } from "@/lib/files/project-editor-bridge"
import { useAgentFileAutoFollow } from "./use-agent-file-auto-follow"

jest.mock("@/lib/files/project-editor-bridge", () => ({
  openInProjectEditor: jest.fn(),
  reflectEditInProjectEditor: jest.fn(),
}))

const openMock = openInProjectEditor as jest.Mock
const reflectMock = reflectEditInProjectEditor as jest.Mock
type Part = UIMessage["parts"][number]

function toolPart(
  name: string,
  state: string,
  input: Record<string, unknown>,
  id = "call-1"
): Part {
  return { type: `tool-${name}`, state, input, toolCallId: id } as Part
}

beforeEach(() => {
  openMock.mockReset()
  reflectMock.mockReset()
})

it("follows a live read (opens, does not reflect) once its input is available", () => {
  const parts = [toolPart("Read", "input-available", { file_path: "src/a.ts", offset: 6 })]
  const { rerender } = renderHook(
    ({ nextParts }) =>
      useAgentFileAutoFollow({ parts: nextParts, isStreaming: true, projectRoot: "/repo" }),
    { initialProps: { nextParts: parts } }
  )

  expect(openMock).toHaveBeenCalledWith("/repo/src/a.ts", 6, undefined)
  expect(reflectMock).not.toHaveBeenCalled()
  rerender({ nextParts: [...parts] })
  expect(openMock).toHaveBeenCalledTimes(1)
})

it("reflects a write as an undo-able edit only after a successful output", () => {
  const input = { file_path: "src/new.ts", content: "export {}" }
  const { rerender } = renderHook(
    ({ parts }) => useAgentFileAutoFollow({ parts, isStreaming: true, projectRoot: "/repo" }),
    { initialProps: { parts: [toolPart("Write", "input-available", input)] } }
  )

  expect(reflectMock).not.toHaveBeenCalled()
  rerender({ parts: [toolPart("Write", "output-available", input)] })
  // Writes go through the reflect path, not the plain open path.
  expect(reflectMock).toHaveBeenCalledWith("/repo/src/new.ts", undefined, undefined)
  expect(openMock).not.toHaveBeenCalled()
})

it("does not replay historical or failed file tools", () => {
  renderHook(() =>
    useAgentFileAutoFollow({
      parts: [toolPart("Edit", "output-error", { file_path: "/repo/src/a.ts" })],
      isStreaming: false,
      projectRoot: "/repo",
    })
  )

  expect(openMock).not.toHaveBeenCalled()
})

it("does not follow a failed write while the response is streaming", () => {
  renderHook(() =>
    useAgentFileAutoFollow({
      parts: [toolPart("Write", "output-error", { file_path: "/repo/src/a.ts" })],
      isStreaming: true,
      projectRoot: "/repo",
    })
  )

  expect(openMock).not.toHaveBeenCalled()
})
