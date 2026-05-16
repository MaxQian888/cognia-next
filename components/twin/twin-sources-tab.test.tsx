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

jest.mock("motion/react", () => ({
  motion: {
    li: ({ children, className, ...props }: React.LiHTMLAttributes<HTMLLIElement>) => (
      <li className={className} {...props}>
        {children}
      </li>
    ),
    span: ({ children, className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
      <span className={className} {...props}>
        {children}
      </span>
    ),
  },
  useReducedMotion: () => true,
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
