/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${JSON.stringify(vals)}` : key,
}))

type BulkArgs = [
  string,
  Record<string, unknown>[],
  { upsertBySourceId: boolean; onProgress?: (w: number, t: number) => void },
]
const bulkAddCases = jest.fn<Promise<{ added: number; updated: number }>, BulkArgs>(async () => ({
  added: 0,
  updated: 0,
}))
const updateDataset = jest.fn(async () => undefined)
jest.mock("@/lib/db/eval-datasets", () => ({
  bulkAddCases: (...a: unknown[]) => bulkAddCases(...(a as unknown as BulkArgs)),
  updateDataset: (...a: unknown[]) => updateDataset(...(a as [])),
}))

// Keep the real parsers / mappers / foreign adapters; only stub the network.
const fetchHuggingFaceSchema = jest.fn()
const importHuggingFace = jest.fn()
jest.mock("@/lib/ai/eval/import", () => {
  const actual = jest.requireActual("@/lib/ai/eval/import")
  return {
    ...actual,
    fetchHuggingFaceSchema: (...a: unknown[]) => fetchHuggingFaceSchema(...(a as [])),
    importHuggingFace: (...a: unknown[]) => importHuggingFace(...(a as [])),
  }
})

const recentTraces = jest.fn<unknown[], []>(() => [])
const tracePrompts: Record<string, string> = {}
jest.mock("@/hooks/eval/use-eval-data", () => ({
  useRecentTraces: () => recentTraces(),
  useTracePrompts: () => tracePrompts,
}))

import type { ComponentProps } from "react"
import { ImportDialog } from "./import-dialog"

/** A File whose `.text()` resolves — jsdom's File does not implement it. */
function textFile(name: string, content: string): File {
  const f = new File([content], name, { type: "text/plain" })
  Object.defineProperty(f, "text", { value: async () => content })
  return f
}

const CSV = "question,answer,split,rid\nWhat is 2+2?,#### 4,test,r1\nWhat is 3+3?,#### 6,test,r2\n"

beforeEach(() => {
  bulkAddCases.mockClear().mockResolvedValue({ added: 0, updated: 0 })
  updateDataset.mockClear()
  fetchHuggingFaceSchema.mockReset()
  importHuggingFace.mockReset()
  recentTraces.mockReturnValue([])
})

function renderDialog(props: Partial<ComponentProps<typeof ImportDialog>> = {}) {
  const onClose = jest.fn()
  render(<ImportDialog datasetId="d1" capability="chat.qa" onClose={onClose} {...props} />)
  return { onClose }
}

async function loadCsv() {
  fireEvent.change(screen.getByLabelText("import.file.pick"), {
    target: { files: [textFile("cases.csv", CSV)] },
  })
  await waitFor(() => expect(screen.getByTestId("mapping")).toBeInTheDocument())
}

const casesOf = (call: number) =>
  bulkAddCases.mock.calls[call][1] as unknown as Record<string, unknown>[]
const optsOf = (call: number) =>
  bulkAddCases.mock.calls[call][2] as unknown as { upsertBySourceId: boolean }

describe("ImportDialog — file source", () => {
  it("maps columns and previews before writing anything", async () => {
    renderDialog()
    await loadCsv()
    expect(screen.getByTestId("import-preview")).toHaveTextContent('{"count":2}')
    expect(bulkAddCases).not.toHaveBeenCalled()
  })

  it("writes through the bulk path, not one addCase per row", async () => {
    renderDialog()
    await loadCsv()
    fireEvent.click(screen.getByText('import.action:{"count":2}'))
    await waitFor(() => expect(bulkAddCases).toHaveBeenCalledTimes(1))
    expect(bulkAddCases.mock.calls[0][0]).toBe("d1")
    expect(casesOf(0)).toHaveLength(2)
  })

  it("carries the mapped split onto every case", async () => {
    // Nothing used to write `split` at all, so the run dialog's split filter
    // could never match an imported case.
    renderDialog()
    await loadCsv()
    fireEvent.change(screen.getByLabelText("import.mapping.splitColumn"), {
      target: { value: "split" },
    })
    fireEvent.click(screen.getByText('import.action:{"count":2}'))
    await waitFor(() => expect(bulkAddCases).toHaveBeenCalled())
    expect(casesOf(0).map((c) => c.split)).toEqual(["test", "test"])
  })

  it("applies a literal split when the source has no split column", async () => {
    renderDialog()
    await loadCsv()
    fireEvent.change(screen.getByLabelText("import.mapping.splitLiteral"), {
      target: { value: "validation" },
    })
    fireEvent.click(screen.getByText('import.action:{"count":2}'))
    await waitFor(() => expect(bulkAddCases).toHaveBeenCalled())
    expect(casesOf(0).every((c) => c.split === "validation")).toBe(true)
  })

  it("stamps the grading rule onto the cases and remembers it on the dataset", async () => {
    renderDialog()
    await loadCsv()
    fireEvent.change(screen.getByLabelText("mode"), { target: { value: "numeric" } })
    fireEvent.change(screen.getByLabelText("pattern"), { target: { value: "####\\s*(\\d+)" } })
    fireEvent.click(screen.getByText('import.action:{"count":2}'))
    await waitFor(() => expect(bulkAddCases).toHaveBeenCalled())
    expect((casesOf(0)[0].reference as { grading?: unknown }).grading).toMatchObject({
      mode: "numeric",
    })
    expect(updateDataset).toHaveBeenCalledWith("d1", {
      defaultGrading: expect.objectContaining({ mode: "numeric" }),
    })
  })

  it("can opt out of grading, leaving the golden answer for the judge only", async () => {
    renderDialog()
    await loadCsv()
    fireEvent.click(screen.getByText("import.mapping.useGrading"))
    fireEvent.click(screen.getByText('import.action:{"count":2}'))
    await waitFor(() => expect(bulkAddCases).toHaveBeenCalled())
    expect((casesOf(0)[0].reference as { grading?: unknown }).grading).toBeUndefined()
    expect(updateDataset).not.toHaveBeenCalled()
  })

  it("enables idempotent upsert once a stable id column is mapped", async () => {
    renderDialog()
    await loadCsv()
    fireEvent.click(screen.getByText('import.action:{"count":2}'))
    await waitFor(() => expect(bulkAddCases).toHaveBeenCalled())
    expect(optsOf(0).upsertBySourceId).toBe(false)

    bulkAddCases.mockClear()
    fireEvent.change(screen.getByLabelText("import.mapping.idColumn"), {
      target: { value: "rid" },
    })
    fireEvent.click(screen.getByText('import.action:{"count":2}'))
    await waitFor(() => expect(bulkAddCases).toHaveBeenCalled())
    expect(optsOf(0).upsertBySourceId).toBe(true)
    expect(casesOf(0).map((c) => c.id)).toEqual(["r1", "r2"])
  })

  it("reports added vs updated so a re-import is legible", async () => {
    bulkAddCases.mockResolvedValue({ added: 0, updated: 2 })
    renderDialog()
    await loadCsv()
    fireEvent.click(screen.getByText('import.action:{"count":2}'))
    expect(await screen.findByRole("status")).toHaveTextContent('{"added":0,"updated":2}')
  })

  it("surfaces a parse failure instead of failing silently", async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText("import.file.pick"), {
      target: { files: [textFile("cases.json", "{ not json")] },
    })
    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(screen.queryByTestId("mapping")).not.toBeInTheDocument()
  })

  it("pre-selects the dataset's remembered grading rule", async () => {
    renderDialog({ defaultGrading: { mode: "choice", alphabet: "ABCD" } })
    await loadCsv()
    expect(screen.getByLabelText("mode")).toHaveValue("choice")
    expect(screen.getByLabelText("alphabet")).toHaveValue("ABCD")
  })
})

describe("ImportDialog — HuggingFace source", () => {
  const schema = {
    splits: [
      { config: "main", split: "train" },
      { config: "main", split: "test" },
    ],
    columns: ["question", "answer"],
    sampleRows: [{ question: "What is 2+2?", answer: "#### 4" }],
    ref: { dataset: "openai/gsm8k", config: "main", split: "test" },
  }

  async function probe() {
    fireEvent.click(screen.getByText("import.tabs.huggingface"))
    fireEvent.change(screen.getByLabelText("import.hf.uri"), {
      target: { value: "hf://datasets/openai/gsm8k?config=main&split=test" },
    })
    fireEvent.click(screen.getByText("import.hf.probe"))
    await waitFor(() => expect(screen.getByTestId("mapping")).toBeInTheDocument())
  }

  it("discovers splits and columns instead of guessing question/answer", async () => {
    // The old dialog hardcoded {input:"question", expected:"answer"}, so any
    // other dataset imported zero rows and still reported success.
    fetchHuggingFaceSchema.mockResolvedValue(schema)
    renderDialog()
    await probe()
    // The select is bound by index into the discovered split list.
    expect(screen.getByLabelText("import.hf.split")).toHaveValue("1")
    expect(screen.getByLabelText("import.hf.split")).toHaveDisplayValue("main / test")
    expect(screen.getByLabelText("import.file.inputColumn")).toHaveValue("question")
  })

  it("previews sample rows and only fetches the full split on import", async () => {
    fetchHuggingFaceSchema.mockResolvedValue(schema)
    importHuggingFace.mockResolvedValue({
      cases: Array.from({ length: 300 }, (_, i) => ({
        id: `c${i}`,
        input: `q${i}`,
        source: "synthetic",
        split: "test",
      })),
      skipped: [],
    })
    renderDialog()
    await probe()
    // The preview is the small sample, labelled against the real total.
    expect(screen.getByTestId("import-preview")).toHaveTextContent('{"count":1,"total":200}')
    expect(importHuggingFace).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText("import.hf.limit"), { target: { value: "300" } })
    fireEvent.click(screen.getByText('import.actionHf:{"count":300}'))
    await waitFor(() => expect(importHuggingFace).toHaveBeenCalledTimes(1))
    expect(importHuggingFace.mock.calls[0][3]).toMatchObject({ limit: 300 })
    await waitFor(() => expect(casesOf(0)).toHaveLength(300))
  })

  it("reports fetch progress against the requested limit, not the split's size", async () => {
    fetchHuggingFaceSchema.mockResolvedValue(schema)
    importHuggingFace.mockImplementation(
      async (
        _uri: string,
        _spec: unknown,
        _deps: unknown,
        opts: { onProgress?: (f: number, t?: number) => void }
      ) => {
        // The server reports the whole split (1319); the user asked for 200.
        opts.onProgress?.(100, 1319)
        opts.onProgress?.(200, undefined)
        return { cases: [{ id: "c", input: "q", source: "synthetic" }], skipped: [] }
      }
    )
    renderDialog()
    await probe()
    fireEvent.click(screen.getByText('import.actionHf:{"count":200}'))
    await waitFor(() => expect(bulkAddCases).toHaveBeenCalled())
  })

  it("rebuilds the URI from the config/split the user picked", async () => {
    fetchHuggingFaceSchema.mockResolvedValue(schema)
    importHuggingFace.mockResolvedValue({ cases: [], skipped: [] })
    renderDialog()
    await probe()
    fireEvent.change(screen.getByLabelText("import.hf.split"), { target: { value: "0" } })
    fireEvent.click(screen.getByText('import.actionHf:{"count":200}'))
    await waitFor(() => expect(importHuggingFace).toHaveBeenCalled())
    expect(importHuggingFace.mock.calls[0][0]).toBe(
      "hf://datasets/openai/gsm8k?config=main&split=train"
    )
  })

  it("reports an empty result rather than claiming success", async () => {
    fetchHuggingFaceSchema.mockResolvedValue(schema)
    importHuggingFace.mockResolvedValue({ cases: [], skipped: [] })
    renderDialog()
    await probe()
    fireEvent.click(screen.getByText('import.actionHf:{"count":200}'))
    expect(await screen.findByRole("alert")).toHaveTextContent("nothingToImport")
    expect(bulkAddCases).not.toHaveBeenCalled()
  })

  it("surfaces a probe failure", async () => {
    fetchHuggingFaceSchema.mockRejectedValue(new Error("HTTP 404"))
    renderDialog()
    fireEvent.click(screen.getByText("import.tabs.huggingface"))
    fireEvent.change(screen.getByLabelText("import.hf.uri"), { target: { value: "bad/name" } })
    fireEvent.click(screen.getByText("import.hf.probe"))
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 404")
  })

  it("stringifies a non-Error probe rejection rather than rendering [object Object]", async () => {
    fetchHuggingFaceSchema.mockRejectedValue("network unreachable")
    renderDialog()
    fireEvent.click(screen.getByText("import.tabs.huggingface"))
    fireEvent.change(screen.getByLabelText("import.hf.uri"), { target: { value: "o/n" } })
    fireEvent.click(screen.getByText("import.hf.probe"))
    expect(await screen.findByRole("alert")).toHaveTextContent("network unreachable")
  })

  it("falls back to the first split when the probed ref is absent from the list", async () => {
    fetchHuggingFaceSchema.mockResolvedValue({
      ...schema,
      ref: { dataset: "openai/gsm8k", config: "other", split: "nope" },
    })
    renderDialog()
    await probe()
    expect(screen.getByLabelText("import.hf.split")).toHaveValue("0")
  })
})

describe("ImportDialog — history source", () => {
  it("stages picked traces into a preview before writing", async () => {
    recentTraces.mockReturnValue([
      { traceId: "t1", sessionId: "s1", startTime: 1, toolNames: [], preview: "hello" },
    ])
    renderDialog()
    fireEvent.click(screen.getByText("import.tabs.history"))
    fireEvent.click(screen.getByLabelText('import.history.pick:{"id":"s1"}'))
    fireEvent.click(screen.getByText('import.stage:{"count":1}'))
    await waitFor(() => expect(screen.getByTestId("import-preview")).toBeInTheDocument())
    expect(bulkAddCases).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('import.action:{"count":1}'))
    await waitFor(() => expect(bulkAddCases).toHaveBeenCalled())
    // Traces carry a stable id, so re-promoting the same one converges.
    expect(optsOf(0).upsertBySourceId).toBe(true)
  })

  it("shows the empty state with no traces", () => {
    renderDialog()
    fireEvent.click(screen.getByText("import.tabs.history"))
    expect(screen.getByText("import.history.empty")).toBeInTheDocument()
  })
})

describe("ImportDialog — foreign source", () => {
  it("previews a promptfoo export instead of importing on file pick", async () => {
    renderDialog()
    fireEvent.click(screen.getByText("import.tabs.foreign"))
    fireEvent.change(screen.getByLabelText("import.foreign.pick"), {
      target: {
        files: [
          textFile(
            "promptfoo.json",
            JSON.stringify({ tests: [{ vars: { input: "hi" }, assert: [] }] })
          ),
        ],
      },
    })
    await waitFor(() => expect(screen.getByTestId("import-preview")).toBeInTheDocument())
    expect(bulkAddCases).not.toHaveBeenCalled()
  })

  it("parses an OpenAI-Evals export as JSONL, not JSON", async () => {
    renderDialog()
    fireEvent.click(screen.getByText("import.tabs.foreign"))
    fireEvent.change(screen.getByLabelText("import.foreign.format"), {
      target: { value: "openai-evals" },
    })
    fireEvent.change(screen.getByLabelText("import.foreign.pick"), {
      target: {
        files: [
          textFile(
            "evals.jsonl",
            '{"input":[{"role":"user","content":"hi"}],"ideal":"yo"}\n' +
              '{"input":[{"role":"user","content":"bye"}],"ideal":"later"}\n'
          ),
        ],
      },
    })
    await waitFor(() => expect(screen.getByTestId("import-preview")).toBeInTheDocument())
    expect(screen.getByTestId("import-preview")).toHaveTextContent('{"count":2}')
  })

  it("surfaces a malformed export", async () => {
    renderDialog()
    fireEvent.click(screen.getByText("import.tabs.foreign"))
    fireEvent.change(screen.getByLabelText("import.foreign.pick"), {
      target: { files: [textFile("x.json", "{ nope")] },
    })
    expect(await screen.findByRole("alert")).toBeInTheDocument()
  })
})

describe("ImportDialog — chrome", () => {
  it("closes via the close button", () => {
    const { onClose } = renderDialog()
    fireEvent.click(screen.getByText("import.close"))
    expect(onClose).toHaveBeenCalled()
  })

  it("disables the import button until a source is staged", () => {
    renderDialog()
    expect(screen.getByText('import.action:{"count":0}')).toBeDisabled()
  })

  it("clears the staged source when switching tabs", async () => {
    renderDialog()
    await loadCsv()
    fireEvent.click(screen.getByText("import.tabs.foreign"))
    expect(screen.queryByTestId("mapping")).not.toBeInTheDocument()
    expect(screen.queryByTestId("import-preview")).not.toBeInTheDocument()
  })

  it("detects every supported file format from the extension", async () => {
    const rows = [
      ["cases.jsonl", '{"q":"a"}\n{"q":"b"}\n'],
      ["cases.ndjson", '{"q":"a"}\n{"q":"b"}\n'],
      ["cases.json", '[{"q":"a"},{"q":"b"}]'],
      ["cases.yaml", "- q: a\n- q: b\n"],
      ["cases.yml", "- q: a\n- q: b\n"],
      ["cases.txt", '[{"q":"a"},{"q":"b"}]'], // unknown extension → JSON
    ] as const
    for (const [name, body] of rows) {
      const { unmount } = render(
        <ImportDialog datasetId="d1" capability="chat.qa" onClose={jest.fn()} />
      )
      fireEvent.change(screen.getByLabelText("import.file.pick"), {
        target: { files: [textFile(name, body)] },
      })
      await waitFor(() => expect(screen.getByTestId("import-preview")).toBeInTheDocument())
      expect(screen.getByTestId("import-preview")).toHaveTextContent('{"count":2}')
      unmount()
    }
  })

  it("carries every optional case field into the bulk write", async () => {
    // Foreign / history sources produce richer cases than a CSV; none of those
    // fields may be dropped on the way to Dexie.
    renderDialog()
    fireEvent.click(screen.getByText("import.tabs.foreign"))
    fireEvent.change(screen.getByLabelText("import.foreign.format"), {
      target: { value: "langsmith" },
    })
    fireEvent.change(screen.getByLabelText("import.foreign.pick"), {
      target: {
        files: [
          textFile(
            "ls.json",
            JSON.stringify([
              {
                id: "ex-1",
                inputs: { input: "hi", extra: 1 },
                outputs: { output: "yo" },
                metadata: { tags: ["a"] },
              },
            ])
          ),
        ],
      },
    })
    await waitFor(() => expect(screen.getByTestId("import-preview")).toBeInTheDocument())
    fireEvent.click(screen.getByText('import.action:{"count":1}'))
    await waitFor(() => expect(bulkAddCases).toHaveBeenCalled())
    const c = casesOf(0)[0]
    expect(c.input).toBe("hi")
    expect(c.source).toBeDefined()
  })

  it("handles a single-column source with no expected column to offer", async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText("import.file.pick"), {
      target: { files: [textFile("prompts.csv", "question\nhi\nthere\n")] },
    })
    await waitFor(() => expect(screen.getByTestId("mapping")).toBeInTheDocument())
    expect(screen.getByLabelText("import.file.expectedColumn")).toHaveValue("")
    // No expected column → no grading editor to configure.
    expect(screen.queryByTestId("grading-editor")).not.toBeInTheDocument()
    expect(screen.getByTestId("import-preview")).toHaveTextContent('{"count":2}')
  })

  it("shows the mapping but no preview for a source with no usable columns", async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText("import.file.pick"), {
      target: { files: [textFile("empty.json", "[]")] },
    })
    await waitFor(() => expect(screen.getByTestId("mapping")).toBeInTheDocument())
    expect(screen.queryByTestId("import-preview")).not.toBeInTheDocument()
    expect(screen.getByText('import.action:{"count":0}')).toBeDisabled()
  })

  it("leaves the grading preview blank when the first row has no expected value", async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText("import.file.pick"), {
      target: { files: [textFile("cases.json", '[{"q":"only question"},{"q":"b","a":"4"}]')] },
    })
    await waitFor(() => expect(screen.getByTestId("mapping")).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText("import.file.expectedColumn"), {
      target: { value: "q" },
    })
    fireEvent.change(screen.getByLabelText("mode"), { target: { value: "numeric" } })
    expect(screen.getByTestId("grading-extraction")).toBeInTheDocument()
  })

  it("previews grading against a non-string golden answer", async () => {
    // JSON sources routinely put the answer in a number or an object.
    renderDialog()
    fireEvent.change(screen.getByLabelText("import.file.pick"), {
      target: { files: [textFile("cases.json", '[{"q":"2+2","a":4}]')] },
    })
    await waitFor(() => expect(screen.getByTestId("mapping")).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText("mode"), { target: { value: "numeric" } })
    expect(screen.getByTestId("grading-extraction")).toHaveTextContent('{"value":"4"}')
  })

  it("reports rows the mapping could not use", async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText("import.file.pick"), {
      target: { files: [textFile("cases.csv", "question,answer\n,unanswerable\nok,yes\n")] },
    })
    await waitFor(() => expect(screen.getByTestId("mapping")).toBeInTheDocument())
    expect(screen.getByTestId("import-preview")).toHaveTextContent('skipped:{"count":1}')
  })

  it("surfaces a write failure instead of reporting success", async () => {
    bulkAddCases.mockRejectedValue(new Error("QuotaExceededError"))
    renderDialog()
    await loadCsv()
    fireEvent.click(screen.getByText('import.action:{"count":2}'))
    expect(await screen.findByRole("alert")).toHaveTextContent("QuotaExceededError")
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("shows progress with a cancel affordance while writing", async () => {
    let release: () => void = () => {}
    bulkAddCases.mockImplementation(async (_datasetId, _cases, opts) => {
      opts.onProgress?.(1, 2)
      await new Promise<void>((r) => {
        release = r
      })
      return { added: 2, updated: 0 }
    })
    renderDialog()
    await loadCsv()
    fireEvent.click(screen.getByText('import.action:{"count":2}'))
    expect(await screen.findByTestId("import-progress")).toHaveTextContent("1/2")
    fireEvent.click(screen.getByText("import.cancel"))
    release()
    await waitFor(() => expect(screen.queryByTestId("import-progress")).not.toBeInTheDocument())
  })

  it("disables the HuggingFace probe while offline and re-enables it when the network returns", () => {
    const spy = jest.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    renderDialog()
    fireEvent.click(screen.getByText("import.tabs.huggingface"))
    fireEvent.change(screen.getByLabelText("import.hf.uri"), { target: { value: "o/n" } })
    expect(screen.getByText("import.hf.probe")).toBeDisabled()
    expect(screen.getByText("import.hf.offline")).toBeInTheDocument()

    // `navigator.onLine` was read once at render, so the dialog used to stay
    // stuck in whichever state it opened in.
    spy.mockReturnValue(true)
    fireEvent(window, new Event("online"))
    expect(screen.getByText("import.hf.probe")).toBeEnabled()
    spy.mockRestore()
  })
})
