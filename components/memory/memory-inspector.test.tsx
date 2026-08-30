/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Memory } from "@/types/memory/memory"
import type { MemoryAuditEvent, MemoryEvidence } from "@/types/memory/governance"
import { MemoryInspector } from "./memory-inspector"

const NOW = 1_700_000_000_000

function mem(over: Partial<Memory> = {}): Memory {
  return {
    id: "m1",
    scope: "global",
    type: "semantic",
    text: "The user prefers pnpm",
    tags: ["tools"],
    importance: 7,
    createdAt: NOW,
    updatedAt: NOW,
    lastAccessedAt: NOW,
    accessCount: 3,
    version: 2,
    status: "active",
    pinned: false,
    provenance: "user",
    ...over,
  }
}

function evidence(over: Partial<MemoryEvidence> = {}): MemoryEvidence {
  return {
    id: "e1",
    memoryId: "m1",
    kind: "manual",
    sourceId: "manual:m1:v2",
    createdAt: NOW - 1000,
    ...over,
  } as MemoryEvidence
}

function audit(over: Partial<MemoryAuditEvent> = {}): MemoryAuditEvent {
  return { id: "a1", action: "promoted", reason: "user_review", createdAt: NOW, ...over }
}

function setup(over: Partial<Parameters<typeof MemoryInspector>[0]> = {}) {
  const onClose = jest.fn()
  const onSave = jest.fn()
  const onPinToggle = jest.fn()
  const onArchive = jest.fn()
  const onDelete = jest.fn()
  const onReview = jest.fn()
  render(
    <MemoryInspector
      memory={mem()}
      onClose={onClose}
      onSave={onSave}
      onPinToggle={onPinToggle}
      onArchive={onArchive}
      onDelete={onDelete}
      onReview={onReview}
      {...over}
    />
  )
  return { onClose, onSave, onPinToggle, onArchive, onDelete, onReview }
}

describe("MemoryInspector", () => {
  it("renders the memory under named sections", () => {
    setup()
    expect(screen.getByText("The user prefers pnpm")).toBeTruthy()
    for (const heading of ["Memory", "Tags", "Origin", "Status", "Activity", "Metrics"]) {
      expect(screen.getByRole("heading", { name: heading })).toBeTruthy()
    }
  })

  // The panel this replaced live-queried evidence and audit rows and rendered
  // only `.length` — the data was fetched and thrown away.
  it("renders the evidence and audit rows instead of counting them", () => {
    setup({ evidence: [evidence()], auditEvents: [audit()] })
    const activity = screen.getByTestId("memory-activity")
    expect(within(activity).getByText("Marked verified")).toBeTruthy()
    expect(within(activity).getByText("Entered by hand")).toBeTruthy()
  })

  it("interleaves the two sources newest first", () => {
    setup({
      evidence: [evidence({ createdAt: NOW })],
      auditEvents: [audit({ createdAt: NOW - 5000 })],
    })
    const entries = within(screen.getByTestId("memory-activity")).getAllByRole("listitem")
    expect(entries[0]?.textContent).toContain("Entered by hand")
    expect(entries[1]?.textContent).toContain("Marked verified")
  })

  it("says so when there is no history yet", () => {
    setup()
    expect(screen.getByText("Nothing recorded yet.")).toBeTruthy()
    expect(screen.queryByTestId("memory-activity")).toBeNull()
  })

  // `useFormatter().dateTime` needs a Date; a bare epoch number rendered the raw
  // milliseconds into the Origin grid.
  it("formats timestamps instead of printing raw epoch milliseconds", () => {
    setup()
    const origin = screen.getByRole("heading", { name: "Origin" }).parentElement!
    expect(origin.textContent).not.toContain(String(NOW))
    expect(origin.textContent).toMatch(/\d{4}/)
  })

  it("labels a pending_instruction review state", () => {
    setup({ memory: mem({ reviewStatus: "pending_instruction" }) })
    expect(screen.getByTestId("memory-inspector-review").textContent).toBe("Awaiting review")
  })

  it("hands the pin callback the desired state", async () => {
    const { onPinToggle } = setup({ memory: mem({ pinned: false }) })
    await userEvent.click(screen.getByTestId("memory-inspector-pin"))
    expect(onPinToggle).toHaveBeenCalledWith("m1", true)
  })

  it("saves an edit with text, tags and importance", async () => {
    const { onSave } = setup()
    await userEvent.click(screen.getByRole("button", { name: /edit/i }))
    fireEvent.change(screen.getByRole("textbox", { name: "Text" }), {
      target: { value: "The user prefers bun" },
    })
    fireEvent.change(screen.getByLabelText("Tags"), { target: { value: "a, b ,a" } })
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).toHaveBeenCalledWith("m1", {
      text: "The user prefers bun",
      tags: ["a", "b"],
      importance: 7,
    })
  })

  it("confirms before archiving", async () => {
    const { onArchive } = setup()
    await userEvent.click(screen.getByTestId("memory-inspector-archive"))
    expect(onArchive).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Archive" }))
    expect(onArchive).toHaveBeenCalledWith("m1")
  })

  it("keeps permanent delete behind the overflow menu and a confirmation", async () => {
    const { onDelete } = setup()
    await userEvent.click(screen.getByRole("button", { name: "More actions" }))
    await userEvent.click(screen.getByTestId("memory-inspector-delete"))
    expect(onDelete).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Delete" }))
    expect(onDelete).toHaveBeenCalledWith("m1")
  })

  it("hides archive on an already-archived memory", () => {
    setup({ memory: mem({ status: "invalidated", invalidatedAt: NOW }) })
    expect(screen.queryByTestId("memory-inspector-archive")).toBeNull()
  })

  it("marks a memory verified", async () => {
    const { onReview } = setup({ memory: mem({ reviewStatus: "unreviewed" }) })
    await userEvent.click(screen.getByTestId("memory-inspector-verify"))
    expect(onReview).toHaveBeenCalledWith("m1", "verified")
  })

  it("links to a conflicting memory and offers the resolver", async () => {
    const other = mem({ id: "m2", text: "The user prefers npm" })
    const onOpenResolver = jest.fn()
    setup({
      memory: mem({ reviewStatus: "conflict", conflictWithIds: ["m2"] }),
      resolveMemory: (id) => (id === "m2" ? other : undefined),
      onOpenResolver,
    })
    expect(screen.getByText("The user prefers npm")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Resolve conflict…" }))
    expect(onOpenResolver).toHaveBeenCalled()
  })

  it("steps through the list and reports its position", async () => {
    const onNavigate = jest.fn()
    setup({ onNavigate, navPosition: { index: 2, total: 5 } })
    expect(screen.getByText("2/5")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Next memory" }))
    expect(onNavigate).toHaveBeenCalledWith(1)
  })

  it("disables navigation at the ends of the list", () => {
    setup({ onNavigate: jest.fn(), navPosition: { index: 1, total: 3 } })
    expect(screen.getByRole("button", { name: "Previous memory" }).hasAttribute("disabled")).toBe(
      true
    )
  })
})

describe("the project-claim section", () => {
  const claim = (over: Partial<Memory> = {}) =>
    mem({ projectMemoryKind: "constraint", text: "the repo pins rust to 1.77.2", ...over })

  it("stays out of the way for a personal memory", () => {
    setup({ memory: mem() })
    expect(screen.queryByTestId("memory-claim-kind")).toBeNull()
    expect(screen.queryByTestId("memory-claim-applicability")).toBeNull()
  })

  it("names the claim kind for a mined row", () => {
    setup({ memory: claim() })
    expect(within(screen.getByTestId("memory-claim-kind")).getByText("Constraint")).toBeTruthy()
  })

  it("shows when the evidence happened, not when the miner ran", () => {
    // `createdAt` is today for a backfilled eight-month-old session; showing it
    // would date every mined claim to the day mining was switched on.
    setup({ memory: claim({ observedAt: NOW - 86_400_000 * 200 }) })
    expect(screen.getByText("Observed")).toBeTruthy()
  })

  it("says a never-verified claim has never been verified", () => {
    setup({ memory: claim() })
    expect(screen.getByText("Never verified")).toBeTruthy()
  })

  it("renders the branch and path scope, naming the unscoped case", () => {
    setup({ memory: claim() })
    expect(screen.getByText("Every branch")).toBeTruthy()
    expect(screen.getByText("Every path")).toBeTruthy()
  })

  it("shows why an automatic claim was narrowed", () => {
    setup({ memory: claim({ scopeRationale: "seen only under src-tauri/" }) })
    expect(screen.getByText(/seen only under src-tauri/)).toBeTruthy()
  })

  describe("applicability is three-valued, not two", () => {
    it("applies when the claim is unscoped", () => {
      setup({ memory: claim(), readerContext: { branch: "dev" } })
      expect(
        screen.getByTestId("memory-claim-applicability").getAttribute("data-applicability")
      ).toBe("applies")
    })

    it("does not apply on another branch", () => {
      setup({ memory: claim({ branch: "main" }), readerContext: { branch: "dev" } })
      expect(
        screen.getByTestId("memory-claim-applicability").getAttribute("data-applicability")
      ).toBe("elsewhere")
    })

    it("cannot tell when the claim is path-scoped and no file is open", () => {
      // Distinct from "does not apply": `matchesPath` answers false for a
      // missing path, and collapsing the two would tell the user a claim is
      // irrelevant when nothing has been checked.
      setup({ memory: claim({ pathPattern: "src-tauri" }), readerContext: { branch: "dev" } })
      expect(
        screen.getByTestId("memory-claim-applicability").getAttribute("data-applicability")
      ).toBe("unknown")
    })

    it("uses the retriever's own path predicate", () => {
      setup({
        memory: claim({ pathPattern: "src-tauri" }),
        readerContext: { branch: "dev", path: "src-tauri/src/lib.rs" },
      })
      expect(
        screen.getByTestId("memory-claim-applicability").getAttribute("data-applicability")
      ).toBe("applies")
    })

    it("renders the badge inert rather than hiding it when the claim is elsewhere", () => {
      // Rule 7: a missing badge would read as "applies".
      setup({ memory: claim({ branch: "main" }), readerContext: { branch: "dev" } })
      const badge = screen.getByTestId("memory-claim-applicability")
      expect(badge.textContent).toBe("Does not apply where you are")
    })
  })

  it("marks a claim out of date without archiving it", async () => {
    const user = userEvent.setup()
    const onMarkOutdated = jest.fn(async () => {})
    const onArchive = jest.fn()
    setup({ memory: claim(), onMarkOutdated, onArchive })
    await user.click(screen.getByTestId("memory-claim-mark-outdated"))
    expect(onMarkOutdated).toHaveBeenCalledWith("m1")
    // An expired claim is still true history; archiving is a different intent
    // with its own button.
    expect(onArchive).not.toHaveBeenCalled()
  })

  it("offers no mark-outdated button when the host supplies no handler", () => {
    setup({ memory: claim() })
    expect(screen.queryByTestId("memory-claim-mark-outdated")).toBeNull()
  })
})
