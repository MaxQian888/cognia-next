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

import { ImportDialog } from "./import-dialog"

// jsdom File.text() shim
function makeFile(content: string, name: string): File {
  const f = new File([content], name, { type: "text/plain" })
  Object.defineProperty(f, "text", { value: async () => content })
  return f
}

beforeEach(() => addCase.mockClear())

describe("ImportDialog — File tab", () => {
  it("parses a CSV, maps columns, previews, and imports", async () => {
    render(<ImportDialog datasetId="d" capability="chat" onClose={jest.fn()} />)
    const input = screen.getByLabelText("import.file.pick")
    fireEvent.change(input, { target: { files: [makeFile("q,a\nhi,yo\nfoo,bar", "t.csv")] } })
    // mapping selects appear after parse
    await waitFor(() =>
      expect(screen.getByLabelText("import.file.inputColumn")).toBeInTheDocument()
    )
    // default input col = first column "q"; import the 2 rows
    fireEvent.click(screen.getByText('import.action:{"count":2}'))
    await waitFor(() => expect(addCase).toHaveBeenCalledTimes(2))
    expect(addCase).toHaveBeenCalledWith("d", expect.objectContaining({ input: "hi" }))
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

describe("ImportDialog — tabs", () => {
  it("switches to the HuggingFace tab and exposes the uri input", () => {
    render(<ImportDialog datasetId="d" capability="chat" onClose={jest.fn()} />)
    fireEvent.click(screen.getByText("import.tabs.huggingface"))
    expect(screen.getByLabelText("import.hf.uri")).toBeInTheDocument()
  })

  it("calls onClose", () => {
    const onClose = jest.fn()
    render(<ImportDialog datasetId="d" capability="chat" onClose={onClose} />)
    fireEvent.click(screen.getByText("import.close"))
    expect(onClose).toHaveBeenCalled()
  })
})
