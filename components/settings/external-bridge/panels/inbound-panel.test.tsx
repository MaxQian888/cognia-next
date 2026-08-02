import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { BridgeInboundPanel, filterDrafts, indexJobsByDraft } from "./inbound-panel"
import type { InboundDraftRow } from "@/lib/db/inbound-drafts"
import type { InboundMaterializationRow } from "@/lib/db/inbound-materializations"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

let liveDrafts: InboundDraftRow[] = []
let liveJobs: InboundMaterializationRow[] = []

/**
 * The panel runs two `useLiveQuery` calls whose callbacks are async, so the
 * real hook's return value cannot be produced synchronously here.
 *
 * They are told apart by their dependency arrays — the drafts query depends on
 * `[filter]`, the jobs query on `[]` — rather than by call order or a render
 * counter. A counter breaks the moment React re-renders, which is exactly what
 * every interaction in this suite causes.
 */
/** When true, both queries return `undefined` — Dexie's pre-first-result state. */
let liveQueriesPending = false

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (_fn: () => unknown, deps?: unknown[]) => {
    if (liveQueriesPending) return undefined
    return deps && deps.length > 0 ? liveDrafts : new Map(liveJobs.map((job) => [job.draftId, job]))
  },
}))

const mockAccept = jest.fn()
const mockReject = jest.fn()
jest.mock("@/lib/db/inbound-drafts", () => {
  const actual = jest.requireActual("@/lib/db/inbound-drafts")
  return {
    ...actual,
    listInboundDrafts: jest.fn(async () => []),
    acceptInboundDraft: (...args: unknown[]) => mockAccept(...args),
    rejectInboundDraft: (...args: unknown[]) => mockReject(...args),
  }
})

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ inboundMaterializations: { toArray: async () => [] } }),
}))

const mockRetry = jest.fn()
jest.mock("@/lib/inbound/materializer", () => ({
  retryMaterializationNow: (...args: unknown[]) => mockRetry(...args),
}))

// Created inside the factory, then retrieved: `jest.mock` is hoisted above the
// module's `const` initializers, so a factory closing over one hits a TDZ error
// when the mocked module is first required.
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))
const { toast } = jest.requireMock("sonner") as {
  toast: { error: jest.Mock; success: jest.Mock }
}
const toastError = toast.error
const toastSuccess = toast.success

function draft(over: Partial<InboundDraftRow> = {}): InboundDraftRow {
  return {
    id: "d1",
    kind: "note",
    status: "pending",
    title: "A submission",
    body: "<untrusted_content>\nthe body\n</untrusted_content>",
    createdAt: Date.UTC(2026, 6, 28, 9, 0),
    metadata: { origin: "mcp" },
    ...over,
  }
}

const failedJob: InboundMaterializationRow = {
  draftId: "a",
  kind: "note",
  status: "failed",
  queuedAt: 1,
  attempts: 3,
  error: "memory store refused: disabled",
}

beforeEach(() => {
  liveDrafts = []
  liveJobs = []
  liveQueriesPending = false
  jest.clearAllMocks()
})

describe("filterDrafts", () => {
  const rows = [
    draft({ id: "p", status: "pending" }),
    draft({ id: "a", status: "accepted" }),
    draft({ id: "r", status: "rejected" }),
  ]

  it("narrows to one status", () => {
    expect(filterDrafts(rows, "pending").map((r) => r.id)).toEqual(["p"])
    expect(filterDrafts(rows, "accepted").map((r) => r.id)).toEqual(["a"])
    expect(filterDrafts(rows, "rejected").map((r) => r.id)).toEqual(["r"])
  })

  it("passes everything through for 'all' — which is not a status", () => {
    expect(filterDrafts(rows, "all").map((r) => r.id)).toEqual(["p", "a", "r"])
  })

  it("does not mutate the input", () => {
    const input = [...rows]
    filterDrafts(input, "all")
    expect(input).toHaveLength(3)
  })
})

describe("indexJobsByDraft", () => {
  it("keys rows by draft id", () => {
    const index = indexJobsByDraft([failedJob, { ...failedJob, draftId: "b" }])
    expect(index.get("a")).toBe(failedJob)
    expect(index.get("b")?.draftId).toBe("b")
    expect(index.get("missing")).toBeUndefined()
  })

  it("returns an empty index for no rows", () => {
    expect(indexJobsByDraft([]).size).toBe(0)
  })
})

describe("listing", () => {
  it("renders the empty state before the first query result arrives", () => {
    // Dexie yields `undefined` until the first result lands; the panel must not
    // crash trying to filter or index it.
    liveQueriesPending = true
    render(<BridgeInboundPanel />)
    expect(screen.getByText("inbound.empty")).toBeInTheDocument()
  })

  it("renders a draft that predates origin tracking without an origin badge", () => {
    liveDrafts = [draft({ id: "old", metadata: undefined, source: undefined })]
    render(<BridgeInboundPanel />)

    const row = screen.getByTestId("bridge-inbound-row-old")
    expect(within(row).queryByText(/inbound\.origin\./)).not.toBeInTheDocument()
    expect(within(row).getByText("inbound.kind.note")).toBeInTheDocument()
  })

  it("says there is nothing to review when the queue is empty", () => {
    render(<BridgeInboundPanel />)
    expect(screen.getByText("inbound.empty")).toBeInTheDocument()
  })

  it("renders kind, status, and origin badges for each draft", () => {
    liveDrafts = [draft({ id: "p", kind: "skill" })]
    render(<BridgeInboundPanel />)

    const row = screen.getByTestId("bridge-inbound-row-p")
    expect(within(row).getByText("inbound.kind.skill")).toBeInTheDocument()
    expect(within(row).getByText("inbound.status.pending")).toBeInTheDocument()
    expect(within(row).getByText("inbound.origin.mcp")).toBeInTheDocument()
  })

  it("offers accept/reject only for pending drafts", () => {
    liveDrafts = [draft({ id: "p", status: "pending" }), draft({ id: "a", status: "accepted" })]
    render(<BridgeInboundPanel />)

    const pending = screen.getByTestId("bridge-inbound-row-p")
    expect(within(pending).getByText("inbound.accept")).toBeInTheDocument()
    expect(within(pending).getByText("inbound.reject")).toBeInTheDocument()

    // Both terminal states are final — there is no re-decide affordance.
    const accepted = screen.getByTestId("bridge-inbound-row-a")
    expect(within(accepted).queryByText("inbound.accept")).not.toBeInTheDocument()
    expect(within(accepted).queryByText("inbound.reject")).not.toBeInTheDocument()
  })
})

describe("review actions", () => {
  it("requires confirmation before accepting, then calls the CAS helper", async () => {
    liveDrafts = [draft({ id: "p" })]
    render(<BridgeInboundPanel />)

    await userEvent.click(
      within(screen.getByTestId("bridge-inbound-row-p")).getByText("inbound.accept")
    )
    // Accepting is terminal and queues real work; it must not fire on one click.
    expect(mockAccept).not.toHaveBeenCalled()
    expect(screen.getByText("inbound.acceptConfirmTitle")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "inbound.accept" }))
    await waitFor(() => expect(mockAccept).toHaveBeenCalledWith("p", {}))
  })

  it("requires confirmation before rejecting", async () => {
    liveDrafts = [draft({ id: "p" })]
    render(<BridgeInboundPanel />)

    await userEvent.click(
      within(screen.getByTestId("bridge-inbound-row-p")).getByText("inbound.reject")
    )
    expect(mockReject).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole("button", { name: "inbound.reject" }))
    await waitFor(() => expect(mockReject).toHaveBeenCalledWith("p"))
  })

  it("shows the confirmation copy for the draft's own kind", async () => {
    liveDrafts = [draft({ id: "p", kind: "skill" })]
    render(<BridgeInboundPanel />)

    await userEvent.click(
      within(screen.getByTestId("bridge-inbound-row-p")).getByText("inbound.accept")
    )
    // The skill copy is the one that explains it lands disabled.
    expect(screen.getByText("inbound.acceptConfirmDesc.skill")).toBeInTheDocument()
  })
})

describe("untrusted body", () => {
  it("labels the body and never renders it as markdown", async () => {
    liveDrafts = [
      draft({ id: "p", body: "<untrusted_content>\n# not a heading\n</untrusted_content>" }),
    ]
    render(<BridgeInboundPanel />)

    await userEvent.click(screen.getByLabelText("inbound.detailAria:A submission"))

    expect(screen.getByText("inbound.untrustedLabel")).toBeInTheDocument()
    // As markdown this would become an <h1> indistinguishable from Cognia's UI.
    expect(screen.queryByRole("heading", { name: "not a heading" })).not.toBeInTheDocument()
    expect(screen.getByDisplayValue("# not a heading")).toBeInTheDocument()
  })

  it("re-fences an operator edit, and sends nothing when the text is unchanged", async () => {
    liveDrafts = [draft({ id: "p" })]
    render(<BridgeInboundPanel />)

    await userEvent.click(screen.getByLabelText("inbound.detailAria:A submission"))
    const editor = screen.getByLabelText("inbound.editAria:A submission")
    await userEvent.clear(editor)
    await userEvent.type(editor, "trimmed")

    await userEvent.click(
      within(screen.getByTestId("bridge-inbound-row-p")).getByText("inbound.accept")
    )
    await userEvent.click(screen.getByRole("button", { name: "inbound.accept" }))

    await waitFor(() =>
      expect(mockAccept).toHaveBeenCalledWith("p", {
        // Editing hostile text does not make it trusted.
        editedBody: "<untrusted_content>\ntrimmed\n</untrusted_content>",
      })
    )
  })

  it("renders a terminal draft's body read-only", async () => {
    liveDrafts = [draft({ id: "a", status: "accepted" })]
    render(<BridgeInboundPanel />)

    await userEvent.click(screen.getByLabelText("inbound.detailAria:A submission"))
    expect(screen.queryByLabelText("inbound.editAria:A submission")).not.toBeInTheDocument()
    expect(screen.getByText("the body")).toBeInTheDocument()
  })
})

describe("materialization failures", () => {
  it("surfaces the failure on the accepted row and offers a retry", async () => {
    liveDrafts = [draft({ id: "a", status: "accepted" })]
    liveJobs = [failedJob]
    render(<BridgeInboundPanel />)

    const row = screen.getByTestId("bridge-inbound-row-a")
    expect(within(row).getByText(/inbound\.materializeFailed:3/)).toBeInTheDocument()
    // The review decision stands; only the follow-up work failed.
    expect(within(row).getByText("inbound.status.accepted")).toBeInTheDocument()

    mockRetry.mockResolvedValue({ draftId: "a", status: "completed" })
    await userEvent.click(within(row).getByLabelText("inbound.retryAria:A submission"))
    await waitFor(() => expect(mockRetry).toHaveBeenCalledWith("a"))
  })

  it("offers no retry for a job that succeeded", () => {
    liveDrafts = [draft({ id: "a", status: "accepted" })]
    liveJobs = [{ ...failedJob, status: "completed", producedId: "kn_a", error: undefined }]
    render(<BridgeInboundPanel />)

    const row = screen.getByTestId("bridge-inbound-row-a")
    expect(within(row).queryByText("inbound.retry")).not.toBeInTheDocument()
  })

  it("shows what an accepted draft turned into", async () => {
    liveDrafts = [draft({ id: "a", status: "accepted" })]
    liveJobs = [{ ...failedJob, status: "completed", producedId: "kn_a", error: undefined }]
    render(<BridgeInboundPanel />)

    await userEvent.click(screen.getByLabelText("inbound.detailAria:A submission"))
    expect(screen.getByText("inbound.producedId:kn_a")).toBeInTheDocument()
  })

  it("reports a retry that failed again instead of claiming success", async () => {
    liveDrafts = [draft({ id: "a", status: "accepted" })]
    liveJobs = [failedJob]
    render(<BridgeInboundPanel />)

    mockRetry.mockResolvedValue({ draftId: "a", status: "failed", error: "still disabled" })
    await userEvent.click(screen.getByLabelText("inbound.retryAria:A submission"))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("still disabled"))
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("falls back to a generic message when a failed retry gives no reason", async () => {
    liveDrafts = [draft({ id: "a", status: "accepted" })]
    liveJobs = [failedJob]
    render(<BridgeInboundPanel />)

    mockRetry.mockResolvedValue({ draftId: "a", status: "failed" })
    await userEvent.click(screen.getByLabelText("inbound.retryAria:A submission"))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("inbound.retryFailed"))
  })

  it("surfaces a thrown retry error", async () => {
    liveDrafts = [draft({ id: "a", status: "accepted" })]
    liveJobs = [failedJob]
    render(<BridgeInboundPanel />)

    mockRetry.mockRejectedValue(new Error("db closed"))
    await userEvent.click(screen.getByLabelText("inbound.retryAria:A submission"))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("db closed"))
  })
})

describe("error surfacing", () => {
  it("reports a lost accept race rather than silently doing nothing", async () => {
    liveDrafts = [draft({ id: "p" })]
    mockAccept.mockRejectedValue(new Error("cannot transition accepted → accepted"))
    render(<BridgeInboundPanel />)

    await userEvent.click(
      within(screen.getByTestId("bridge-inbound-row-p")).getByText("inbound.accept")
    )
    await userEvent.click(screen.getByRole("button", { name: "inbound.accept" }))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("cannot transition accepted → accepted")
    )
  })

  it("stringifies a non-Error accept rejection", async () => {
    liveDrafts = [draft({ id: "p" })]
    // Dexie and IndexedDB both reject with DOMException-like values that are
    // not `Error` instances.
    mockAccept.mockRejectedValue({ name: "AbortError" })
    render(<BridgeInboundPanel />)

    await userEvent.click(
      within(screen.getByTestId("bridge-inbound-row-p")).getByText("inbound.accept")
    )
    await userEvent.click(screen.getByRole("button", { name: "inbound.accept" }))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("[object Object]"))
  })

  it("stringifies a non-Error retry rejection", async () => {
    liveDrafts = [draft({ id: "a", status: "accepted" })]
    liveJobs = [failedJob]
    mockRetry.mockRejectedValue("raw string")
    render(<BridgeInboundPanel />)

    await userEvent.click(screen.getByLabelText("inbound.retryAria:A submission"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("raw string"))
  })

  it("reports a failed reject", async () => {
    liveDrafts = [draft({ id: "p" })]
    mockReject.mockRejectedValue("plain string rejection")
    render(<BridgeInboundPanel />)

    await userEvent.click(
      within(screen.getByTestId("bridge-inbound-row-p")).getByText("inbound.reject")
    )
    await userEvent.click(screen.getByRole("button", { name: "inbound.reject" }))

    // Non-Error rejections must still reach the operator.
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("plain string rejection"))
  })
})

describe("status filter and counts", () => {
  it("counts pending drafts while the pending filter is active", () => {
    liveDrafts = [draft({ id: "p1" }), draft({ id: "p2" })]
    render(<BridgeInboundPanel />)
    expect(screen.getByText("inbound.pendingCount:2")).toBeInTheDocument()
  })

  it("switches the filter, which re-runs the query", async () => {
    liveDrafts = [draft({ id: "a", status: "accepted" })]
    render(<BridgeInboundPanel />)

    await userEvent.click(screen.getByLabelText("inbound.filterAria"))
    await userEvent.click(await screen.findByRole("option", { name: "inbound.filter.all" }))

    await waitFor(() =>
      expect(screen.getByLabelText("inbound.filterAria")).toHaveTextContent("inbound.filter.all")
    )
    // No pending rows under the "all" filter, so no pending count.
    expect(screen.queryByText(/inbound\.pendingCount/)).not.toBeInTheDocument()
  })

  it("shows a rejection reason when one was recorded", async () => {
    liveDrafts = [draft({ id: "r", status: "rejected", rejectionReason: "spam" })]
    render(<BridgeInboundPanel />)

    await userEvent.click(screen.getByLabelText("inbound.detailAria:A submission"))
    expect(screen.getByText("inbound.rejectionReason:spam")).toBeInTheDocument()
  })
})
