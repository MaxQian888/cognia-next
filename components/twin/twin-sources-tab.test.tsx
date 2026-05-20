/**
 * @jest-environment jsdom
 *
 * Coverage for the Sources tab: empty state, row rendering with status
 * badge, toggle of the uploader, and delete action.
 */

import "fake-indexeddb/auto"
import React from "react"
import { render, screen, waitFor } from "@testing-library/react"
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

  it("toggles the uploader when 'Add source' is clicked", async () => {
    render(<TwinSourcesTab twinId="twin_alice" />)
    const trigger = await screen.findByRole("button", { name: /Add source/i })
    expect(screen.queryByLabelText(/Pick text files/i)).toBeNull()
    await userEvent.click(trigger)
    expect(await screen.findByLabelText(/Pick text files/i)).toBeInTheDocument()
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
    await waitFor(async () => {
      const remaining = await listTwinSourcesByTwin("twin_alice")
      expect(remaining).toEqual([])
    })
  })
})
