/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${JSON.stringify(vals)}` : key,
}))

const addCase = jest.fn(async () => ({ id: "c" }))
jest.mock("@/lib/db/eval-datasets", () => ({
  addCase: (...a: unknown[]) => addCase(...(a as [])),
}))
jest.mock("@/hooks/eval/use-eval-data", () => ({
  useRecentTraces: () => [
    { traceId: "t1", sessionId: "s1", startTime: 1, toolNames: ["Read"], preview: "a trace" },
  ],
}))
// Keep the real parsers / mappers / foreign adapters; only stub HuggingFace (network).
const importHuggingFace = jest.fn()
jest.mock("@/lib/ai/eval/import", () => {
  const actual = jest.requireActual("@/lib/ai/eval/import")
  return { ...actual, importHuggingFace: (...a: unknown[]) => importHuggingFace(...(a as [])) }
})

import { ImportDialog } from "./import-dialog"

function makeFile(content: string, name: string): File {
  const f = new File([content], name, { type: "text/plain" })
  Object.defineProperty(f, "text", { value: async () => content })
  return f
}

beforeEach(() => {
  addCase.mockClear()
  importHuggingFace.mockReset()
})

describe("ImportDialog — File tab", () => {
  it("parses a CSV, maps columns, previews, and imports", async () => {
    render(<ImportDialog datasetId="d" capability="chat" onClose={jest.fn()} />)
    fireEvent.change(screen.getByLabelText("import.file.pick"), {
      target: { files: [makeFile("q,a\nhi,yo\nfoo,bar", "t.csv")] },
    })
    await waitFor(() =>
      expect(screen.getByLabelText("import.file.inputColumn")).toBeInTheDocument()
    )
    fireEvent.click(screen.getByText('import.action:{"count":2}'))
    await waitFor(() => expect(addCase).toHaveBeenCalledTimes(2))
    expect(addCase).toHaveBeenCalledWith("d", expect.objectContaining({ input: "hi" }))
    expect(screen.getByRole("status")).toBeInTheDocument()
  })

  it("parses a JSONL file (detectFormat branch)", async () => {
    render(<ImportDialog datasetId="d" capability="chat" onClose={jest.fn()} />)
    fireEvent.change(screen.getByLabelText("import.file.pick"), {
      target: { files: [makeFile('{"q":"hi"}\n{"q":"yo"}', "t.jsonl")] },
    })
    await waitFor(() =>
      expect(screen.getByLabelText("import.file.inputColumn")).toBeInTheDocument()
    )
    fireEvent.change(screen.getByLabelText("import.file.expectedColumn"), { target: { value: "" } })
    fireEvent.click(screen.getByText('import.action:{"count":2}'))
    await waitFor(() => expect(addCase).toHaveBeenCalledTimes(2))
  })

  it("surfaces a parse error", async () => {
    render(<ImportDialog datasetId="d" capability="chat" onClose={jest.fn()} />)
    fireEvent.change(screen.getByLabelText("import.file.pick"), {
      target: { files: [makeFile("{ not json", "t.json")] },
    })
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument())
  })
})

describe("ImportDialog — HuggingFace tab", () => {
  it("fetches + imports from a HF uri", async () => {
    importHuggingFace.mockResolvedValue({
      cases: [{ input: "q1", source: "handwritten" }],
      skipped: [],
    })
    render(<ImportDialog datasetId="d" capability="chat" onClose={jest.fn()} />)
    fireEvent.click(screen.getByText("import.tabs.huggingface"))
    fireEvent.change(screen.getByLabelText("import.hf.uri"), {
      target: { value: "hf://datasets/o/n?split=test" },
    })
    fireEvent.click(screen.getByText("import.hf.fetch"))
    await waitFor(() => expect(importHuggingFace).toHaveBeenCalled())
    await waitFor(() => expect(addCase).toHaveBeenCalledTimes(1))
  })

  it("shows the error when HF import rejects", async () => {
    importHuggingFace.mockRejectedValue(new Error("HTTP 503"))
    render(<ImportDialog datasetId="d" capability="chat" onClose={jest.fn()} />)
    fireEvent.click(screen.getByText("import.tabs.huggingface"))
    fireEvent.change(screen.getByLabelText("import.hf.uri"), { target: { value: "o/n" } })
    fireEvent.click(screen.getByText("import.hf.fetch"))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("HTTP 503"))
  })
})

describe("ImportDialog — Foreign tab", () => {
  it("imports a promptfoo export file", async () => {
    render(<ImportDialog datasetId="d" capability="chat" onClose={jest.fn()} />)
    fireEvent.click(screen.getByText("import.tabs.foreign"))
    const file = makeFile(
      JSON.stringify({
        tests: [{ vars: { input: "translate hi" }, assert: [{ type: "equals", value: "salut" }] }],
      }),
      "pf.json"
    )
    fireEvent.change(screen.getByLabelText("import.foreign.pick"), { target: { files: [file] } })
    await waitFor(() => expect(addCase).toHaveBeenCalledTimes(1))
    expect(addCase).toHaveBeenCalledWith("d", expect.objectContaining({ input: "translate hi" }))
  })

  it("imports an OpenAI-Evals jsonl when that format is selected", async () => {
    render(<ImportDialog datasetId="d" capability="chat" onClose={jest.fn()} />)
    fireEvent.click(screen.getByText("import.tabs.foreign"))
    fireEvent.change(screen.getByLabelText("import.foreign.format"), {
      target: { value: "openai-evals" },
    })
    const file = makeFile('{"input":"2+2?","ideal":"4"}', "ev.jsonl")
    fireEvent.change(screen.getByLabelText("import.foreign.pick"), { target: { files: [file] } })
    await waitFor(() => expect(addCase).toHaveBeenCalledTimes(1))
  })
})

describe("ImportDialog — History tab", () => {
  it("imports a picked trace as a case", async () => {
    render(<ImportDialog datasetId="d" capability="chat" onClose={jest.fn()} />)
    fireEvent.click(screen.getByText("import.tabs.history"))
    fireEvent.click(screen.getByLabelText('import.history.pick:{"id":"s1"}'))
    fireEvent.click(screen.getByText('import.action:{"count":1}'))
    await waitFor(() => expect(addCase).toHaveBeenCalledTimes(1))
    expect(addCase).toHaveBeenCalledWith(
      "d",
      expect.objectContaining({ source: "real-trace", sourceTraceId: "t1" })
    )
  })
})

describe("ImportDialog — shell", () => {
  it("calls onClose", () => {
    const onClose = jest.fn()
    render(<ImportDialog datasetId="d" capability="chat" onClose={onClose} />)
    fireEvent.click(screen.getByText("import.close"))
    expect(onClose).toHaveBeenCalled()
  })
})
