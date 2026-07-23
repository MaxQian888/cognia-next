/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { TraceSummary } from "@/lib/ai/eval/trace-summary"
import type { TraceAnnotationRow } from "@/lib/db/trace-annotations"
import type { EvalDataset } from "@/types/eval/eval"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let traces: TraceSummary[] = []
let annotations: TraceAnnotationRow[] = []
let datasets: EvalDataset[] = []

jest.mock("@/hooks/eval/use-eval-data", () => ({
  useRecentTraces: () => traces,
  useTraceAnnotations: () => annotations,
  useEvalDatasets: () => datasets,
}))
const upsertAnnotation = jest.fn(async () => ({}))
const markSavedAsCase = jest.fn(async () => {})
jest.mock("@/lib/db/trace-annotations", () => ({
  upsertAnnotation: (...a: unknown[]) => upsertAnnotation(...(a as [])),
  markSavedAsCase: (...a: unknown[]) => markSavedAsCase(...(a as [])),
}))
const addCase = jest.fn(async () => ({ id: "evc_new" }))
jest.mock("@/lib/db/eval-datasets", () => ({
  addCase: (...a: unknown[]) => addCase(...(a as [])),
}))

import { TraceAnnotationPanel } from "./trace-annotation-panel"

function trace(traceId: string): TraceSummary {
  return { traceId, sessionId: "s1", startTime: 1, toolNames: ["Read"], preview: "do the thing" }
}
function ann(traceId: string, failureMode?: string): TraceAnnotationRow {
  return {
    id: "an_" + traceId,
    traceId,
    sessionId: "s1",
    firstFailureNote: "note",
    ...(failureMode ? { failureMode } : {}),
    createdAt: 1,
    updatedAt: 1,
  }
}

beforeEach(() => {
  traces = []
  annotations = []
  datasets = []
  upsertAnnotation.mockClear()
  markSavedAsCase.mockClear()
  addCase.mockClear()
})

describe("TraceAnnotationPanel", () => {
  it("shows the empty state when there are no recent traces", () => {
    render(<TraceAnnotationPanel />)
    expect(screen.getByText("annotate.empty")).toBeInTheDocument()
  })

  it("renders a row per recent trace with its tool chips", () => {
    traces = [trace("t1")]
    render(<TraceAnnotationPanel />)
    expect(screen.getByTestId("trace-row")).toBeInTheDocument()
    expect(screen.getByText("Read")).toBeInTheDocument()
    expect(screen.getByText("do the thing")).toBeInTheDocument()
  })

  it("saves an annotation with the entered note and failure mode", async () => {
    traces = [trace("t1")]
    render(<TraceAnnotationPanel />)
    fireEvent.change(screen.getByLabelText("annotate.firstFailure"), {
      target: { value: "picked wrong tool" },
    })
    fireEvent.change(screen.getByLabelText("annotate.failureMode"), {
      target: { value: "wrong-tool" },
    })
    await act(async () => {
      fireEvent.click(screen.getByText("annotate.save"))
    })
    expect(upsertAnnotation).toHaveBeenCalledWith({
      traceId: "t1",
      sessionId: "s1",
      firstFailureNote: "picked wrong tool",
      failureMode: "wrong-tool",
    })
  })

  it("promotes a trace to an eval case in the selected dataset", async () => {
    traces = [trace("t1")]
    datasets = [
      { id: "d1", name: "DS", capability: "chat.tool-use", version: 1, createdAt: 0, updatedAt: 0 },
    ]
    render(<TraceAnnotationPanel />)
    await act(async () => {
      fireEvent.click(screen.getByText("annotate.saveAsCase"))
    })
    expect(addCase).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ source: "real-trace", sourceTraceId: "t1" })
    )
    expect(markSavedAsCase).toHaveBeenCalledWith("t1", "evc_new")
  })

  it("saves an annotation without a failure mode when the field is left blank", async () => {
    traces = [trace("t1")]
    render(<TraceAnnotationPanel />)
    fireEvent.change(screen.getByLabelText("annotate.firstFailure"), {
      target: { value: "just a note" },
    })
    await act(async () => {
      fireEvent.click(screen.getByText("annotate.save"))
    })
    expect(upsertAnnotation).toHaveBeenCalledWith({
      traceId: "t1",
      sessionId: "s1",
      firstFailureNote: "just a note",
    })
  })

  it("does not promote a trace when no dataset exists", async () => {
    traces = [trace("t1")]
    datasets = []
    render(<TraceAnnotationPanel />)
    await act(async () => {
      fireEvent.click(screen.getByText("annotate.saveAsCase"))
    })
    expect(addCase).not.toHaveBeenCalled()
  })

  it("shows the already-saved state for a trace promoted earlier", () => {
    traces = [trace("t1")]
    annotations = [{ ...ann("t1"), savedAsCaseId: "evc_old" }]
    datasets = [
      { id: "d1", name: "DS", capability: "chat.tool-use", version: 1, createdAt: 0, updatedAt: 0 },
    ]
    render(<TraceAnnotationPanel />)
    expect(screen.getByText("annotate.savedAsCase")).toBeInTheDocument()
  })

  it("switches the target dataset via the picker", () => {
    traces = [trace("t1")]
    datasets = [
      { id: "d1", name: "DS1", capability: "c", version: 1, createdAt: 0, updatedAt: 0 },
      { id: "d2", name: "DS2", capability: "c", version: 1, createdAt: 0, updatedAt: 0 },
    ]
    render(<TraceAnnotationPanel />)
    fireEvent.change(screen.getByLabelText("annotate.pickDataset"), { target: { value: "d2" } })
    expect(screen.getByLabelText("annotate.pickDataset")).toHaveValue("d2")
  })

  it("renders the failure taxonomy and saturation cue", () => {
    traces = [trace("t1")]
    annotations = Array.from({ length: 25 }, (_, i) => ann(`t${i}`, "wrong-tool"))
    render(<TraceAnnotationPanel />)
    expect(screen.getByText(/wrong-tool · 25/)).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("annotate.saturation")
  })

  it("shows a persisted annotation that arrives after the traces", () => {
    // `useRecentTraces` and `useTraceAnnotations` are independent async live
    // queries. When the traces resolved first, rows mounted with empty fields
    // and the annotation never reached them — a saved note rendered blank, and
    // pressing Save overwrote it with "".
    traces = [trace("t1")]
    annotations = []
    datasets = []
    const { rerender } = render(<TraceAnnotationPanel />)
    expect(screen.getByLabelText("annotate.firstFailure")).toHaveValue("")

    annotations = [
      {
        traceId: "t1",
        sessionId: "s1",
        firstFailureNote: "picked the wrong tool",
        failureMode: "wrong-tool",
        updatedAt: 2,
      } as TraceAnnotationRow,
    ]
    rerender(<TraceAnnotationPanel />)
    expect(screen.getByLabelText("annotate.firstFailure")).toHaveValue("picked the wrong tool")
    expect(screen.getByLabelText("annotate.failureMode")).toHaveValue("wrong-tool")
  })

  it("does not overwrite a persisted note with an empty one on save", () => {
    traces = [trace("t1")]
    annotations = [
      {
        traceId: "t1",
        sessionId: "s1",
        firstFailureNote: "picked the wrong tool",
        updatedAt: 2,
      } as TraceAnnotationRow,
    ]
    datasets = []
    upsertAnnotation.mockClear()
    render(<TraceAnnotationPanel />)
    fireEvent.click(screen.getByText("annotate.save"))
    expect(upsertAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({ firstFailureNote: "picked the wrong tool" })
    )
  })

  it("keeps unsaved edits per trace while the live query refreshes", () => {
    traces = [trace("t1"), trace("t2")]
    annotations = []
    datasets = []
    const { rerender } = render(<TraceAnnotationPanel />)
    const [first] = screen.getAllByLabelText("annotate.firstFailure")
    fireEvent.change(first, { target: { value: "in progress" } })
    // An unrelated live-query tick must not discard what is being typed.
    annotations = [{ traceId: "t2", sessionId: "s2", updatedAt: 3 } as TraceAnnotationRow]
    rerender(<TraceAnnotationPanel />)
    expect(screen.getAllByLabelText("annotate.firstFailure")[0]).toHaveValue("in progress")
  })
})
