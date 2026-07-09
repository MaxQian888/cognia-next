/**
 * @jest-environment jsdom
 *
 * Coverage for the Sources tab: empty state, row rendering with status
 * badge, toggle of the uploader, and delete action.
 */

import "fake-indexeddb/auto"
import React from "react"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("motion/react", () => {
  const MotionLi = React.forwardRef<HTMLLIElement, React.LiHTMLAttributes<HTMLLIElement>>(
    function MotionLi({ children, className, ...props }, ref) {
      return (
        <li ref={ref} className={className} {...props}>
          {children}
        </li>
      )
    }
  )
  function MotionSpan({ children, className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
    return (
      <span className={className} {...props}>
        {children}
      </span>
    )
  }
  return {
    motion: { li: MotionLi, span: MotionSpan },
    useReducedMotion: () => true,
  }
})

// Override the global next/navigation mock per-test so we can verify the
// sourceId URL-highlight behavior. Defaults to the global empty-params mock.
const mockSearchParams = { current: new URLSearchParams() }
jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    prefetch: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
  }),
  usePathname: () => "/twin",
  useSearchParams: () => mockSearchParams.current,
}))

import { TwinSourcesTab } from "./twin-sources-tab"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createTwinSource, listTwinSourcesByTwin } from "@/lib/db/twin-sources"
import { listTwinJobsByTwin } from "@/lib/db/twin-jobs"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().twinSources.clear()
  mockSearchParams.current = new URLSearchParams()
})

describe("TwinSourcesTab", () => {
  it("renders the empty hint when no sources exist", async () => {
    render(<TwinSourcesTab twinId="twin_alice" />)
    expect(await screen.findByText(/No sources yet/i)).toBeInTheDocument()
  })

  it("renders a source row with translated status badge", async () => {
    const created = await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/intro.md",
      title: "Intro notes",
      bytes: 200,
      fingerprint: "fp1",
      redacted: false,
      status: "parsed",
    })
    render(<TwinSourcesTab twinId="twin_alice" />)
    await screen.findByText("Intro notes")
    const statusBadge = screen.getByTestId(`twin-source-${created.id}-status`)
    expect(statusBadge.textContent).toMatch(/Parsed/i)
    expect(statusBadge.getAttribute("data-variant")).toBe("default")
  })

  it("opens the add-source dialog when 'Add source' is clicked", async () => {
    render(<TwinSourcesTab twinId="twin_alice" />)
    const trigger = await screen.findByTestId("twin-sources-add")
    expect(screen.queryByTestId("twin-add-source-flow")).toBeNull()
    await userEvent.click(trigger)
    expect(await screen.findByTestId("twin-add-source-flow")).toBeInTheDocument()
    // Guided flow starts at the type picker.
    expect(screen.getByTestId("twin-add-source-type-file")).toBeInTheDocument()
  })

  it("highlights the row matching ?sourceId on mount", async () => {
    const created = await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/keep.md",
      title: "Keep",
      bytes: 10,
      fingerprint: "fp_keep",
      redacted: false,
    })
    const scrollSpy = jest.fn()
    // jsdom doesn't implement scrollIntoView — stub it before render.
    window.HTMLElement.prototype.scrollIntoView = scrollSpy
    mockSearchParams.current = new URLSearchParams({ sourceId: created.id })
    render(<TwinSourcesTab twinId="twin_alice" />)
    await screen.findByText("Keep")
    await waitFor(() => {
      const row = screen.getByTestId(`twin-source-${created.id}-row`)
      expect(row.className).toContain("ring-2")
    })
    expect(scrollSpy).toHaveBeenCalled()
  })

  it("shows no pending-ingest CTA when there are no pending sources", async () => {
    await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/done.md",
      title: "Already parsed",
      bytes: 10,
      fingerprint: "fp_done",
      redacted: false,
      status: "parsed",
    })
    render(<TwinSourcesTab twinId="twin_alice" />)
    await screen.findByText("Already parsed")
    expect(screen.queryByTestId("twin-sources-queue-ingest")).toBeNull()
  })

  it("surfaces a pending-ingest CTA and enqueues an ingest job on click", async () => {
    const a = await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/a.md",
      title: "Pending A",
      bytes: 10,
      fingerprint: "fp_a",
      redacted: false,
      status: "pending",
    })
    const b = await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/b.md",
      title: "Pending B",
      bytes: 10,
      fingerprint: "fp_b",
      redacted: false,
      status: "pending",
    })
    render(<TwinSourcesTab twinId="twin_alice" />)
    const cta = await screen.findByTestId("twin-sources-queue-ingest")
    await userEvent.click(cta)
    await waitFor(async () => {
      const jobs = await listTwinJobsByTwin("twin_alice")
      const ingest = jobs.find((j) => j.kind === "ingest")
      expect(ingest).toBeDefined()
      expect(ingest?.sourceIds.sort()).toEqual([a.id, b.id].sort())
    })
  })

  it("formats KB/MB sizes and shows a source error message", async () => {
    await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/big.md",
      title: "Big failed source",
      bytes: 2 * 1024 * 1024,
      fingerprint: "fp_big",
      redacted: false,
      status: "failed",
      errorMessage: "Slack import: malformed JSON — Unexpected token",
    })
    await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/mid.md",
      title: "Mid source",
      bytes: 4096,
      fingerprint: "fp_mid",
      redacted: false,
      status: "parsed",
    })
    render(<TwinSourcesTab twinId="twin_alice" />)
    await screen.findByText("Big failed source")
    expect(screen.getByText("2.0 MB")).toBeInTheDocument()
    expect(screen.getByText("4.0 KB")).toBeInTheDocument()
    expect(screen.getByText(/malformed JSON/)).toBeInTheDocument()
  })

  it("deletes a source when its delete button is clicked", async () => {
    await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/x.md",
      title: "Doomed",
      bytes: 10,
      fingerprint: "fp_doom",
      redacted: false,
    })
    render(<TwinSourcesTab twinId="twin_alice" />)
    await screen.findByText("Doomed")
    const deleteBtn = screen.getByRole("button", { name: /^Delete$/i })
    await userEvent.click(deleteBtn)
    // Deleting now requires confirming in an alert dialog.
    const dialog = await screen.findByRole("alertdialog")
    await userEvent.click(within(dialog).getByRole("button", { name: /^Delete$/i }))
    await waitFor(async () => {
      const remaining = await listTwinSourcesByTwin("twin_alice")
      expect(remaining).toEqual([])
    })
  })

  it("keeps the source when the delete confirmation is cancelled", async () => {
    await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/keep2.md",
      title: "Kept",
      bytes: 10,
      fingerprint: "fp_kept",
      redacted: false,
    })
    render(<TwinSourcesTab twinId="twin_alice" />)
    await screen.findByText("Kept")
    await userEvent.click(screen.getByRole("button", { name: /^Delete$/i }))
    const dialog = await screen.findByRole("alertdialog")
    await userEvent.click(within(dialog).getByRole("button", { name: /^Cancel$/i }))
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    })
    expect(await listTwinSourcesByTwin("twin_alice")).toHaveLength(1)
  })

  it("filters sources by status via the filter chips", async () => {
    await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/p.md",
      title: "Pending doc",
      bytes: 10,
      fingerprint: "fp_p",
      redacted: false,
      status: "pending",
    })
    await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/q.md",
      title: "Parsed doc",
      bytes: 10,
      fingerprint: "fp_q",
      redacted: false,
      status: "parsed",
    })
    render(<TwinSourcesTab twinId="twin_alice" />)
    await screen.findByText("Pending doc")
    await screen.findByText("Parsed doc")

    await userEvent.click(await screen.findByTestId("twin-sources-filter-parsed"))
    await waitFor(() => {
      expect(screen.queryByText("Pending doc")).not.toBeInTheDocument()
    })
    expect(screen.getByText("Parsed doc")).toBeInTheDocument()

    // Clicking the active chip again resets back to "all".
    await userEvent.click(screen.getByTestId("twin-sources-filter-parsed"))
    await screen.findByText("Pending doc")
  })
})
