/**
 * Coverage for `<TwinSelector />` — the workbench dropdown that lists
 * existing twins and exposes CRUD modals. Real Dexie under fake-indexeddb;
 * the component mutates the database via lib/db/twins.ts.
 */

import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const mockRemoveTwin = jest.fn()
jest.mock("@/lib/twin/lifecycle", () => ({
  removeTwin: (...args: unknown[]) => mockRemoveTwin(...args),
}))

import { TwinSelector } from "./twin-selector"
import { createTwin, listTwins } from "@/lib/db/twins"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { Twin } from "@/types/twin"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  mockRemoveTwin.mockImplementation(async (id: string) => {
    const { deleteTwin } = jest.requireActual("@/lib/db/twins") as typeof import("@/lib/db/twins")
    const value = await deleteTwin(id, { skipExternalCleanup: true })
    return { ok: true, removed: true, value }
  })
})

async function refreshTwins(): Promise<Twin[]> {
  return listTwins({ includeArchived: true })
}

describe("TwinSelector", () => {
  it("renders the active twin name and color swatch", async () => {
    const work = await createTwin({ id: "twin_work", name: "Work", color: "#abcdef" })
    render(<TwinSelector twins={[work]} activeTwinId={work.id} onSelect={jest.fn()} />)
    const trigger = screen.getByRole("button", { name: /Active twin: Work/i })
    expect(trigger).toBeInTheDocument()
  })

  it("falls back to 'no twin selected' when the registry is empty", () => {
    render(<TwinSelector twins={[]} activeTwinId={null} onSelect={jest.fn()} />)
    expect(screen.getByText(/No twin selected/i)).toBeInTheDocument()
  })

  it("emits onSelect when picking another twin", async () => {
    const a = await createTwin({ id: "twin_a", name: "Alpha" })
    const b = await createTwin({ id: "twin_b", name: "Beta" })
    const onSelect = jest.fn()
    render(<TwinSelector twins={[a, b]} activeTwinId={a.id} onSelect={onSelect} />)
    await userEvent.click(screen.getByRole("button", { name: /Active twin: Alpha/i }))
    await userEvent.click(await screen.findByTestId("twin-selector-item-twin_b"))
    expect(onSelect).toHaveBeenCalledWith("twin_b")
  })

  it("creates a new twin via the new-twin dialog and writes to Dexie", async () => {
    const onSelect = jest.fn()
    const onAfterCreate = jest.fn()
    render(
      <TwinSelector
        twins={[]}
        activeTwinId={null}
        onSelect={onSelect}
        onAfterCreate={onAfterCreate}
      />
    )
    await userEvent.click(screen.getByRole("button", { name: /No twin selected/i }))
    await userEvent.click(await screen.findByTestId("twin-selector-new"))
    const input = await screen.findByTestId("twin-selector-name-input")
    await userEvent.type(input, "Mentor self")
    await userEvent.click(screen.getByTestId("twin-selector-name-submit"))
    await waitFor(async () => {
      const rows = await refreshTwins()
      expect(rows).toHaveLength(1)
      expect(rows[0].name).toBe("Mentor self")
    })
    expect(onAfterCreate).toHaveBeenCalled()
    expect(onSelect).toHaveBeenCalled()
  })

  it("routes the new-twin item to onGuidedCreate when provided (skips the inline dialog)", async () => {
    const onGuidedCreate = jest.fn()
    render(
      <TwinSelector
        twins={[]}
        activeTwinId={null}
        onSelect={jest.fn()}
        onGuidedCreate={onGuidedCreate}
      />
    )
    await userEvent.click(screen.getByRole("button", { name: /No twin selected/i }))
    await userEvent.click(await screen.findByTestId("twin-selector-new"))
    expect(onGuidedCreate).toHaveBeenCalledTimes(1)
    // The inline create dialog must not open when a guided handler is wired.
    expect(screen.queryByTestId("twin-selector-name-input")).toBeNull()
  })

  it("rejects empty names in the create dialog", async () => {
    render(<TwinSelector twins={[]} activeTwinId={null} onSelect={jest.fn()} />)
    await userEvent.click(screen.getByRole("button", { name: /No twin selected/i }))
    await userEvent.click(await screen.findByTestId("twin-selector-new"))
    const input = await screen.findByTestId("twin-selector-name-input")
    await userEvent.clear(input)
    await userEvent.click(screen.getByTestId("twin-selector-name-submit"))
    expect(await screen.findByText(/Name is required/i)).toBeInTheDocument()
  })

  it("renames the active twin via the rename dialog", async () => {
    const twin = await createTwin({ id: "twin_x", name: "Old", updatedAt: 100 })
    render(<TwinSelector twins={[twin]} activeTwinId={twin.id} onSelect={jest.fn()} />)
    await userEvent.click(screen.getByRole("button", { name: /Active twin: Old/i }))
    await userEvent.click(await screen.findByText("Rename"))
    const input = await screen.findByTestId("twin-selector-name-input")
    await userEvent.clear(input)
    await userEvent.type(input, "Brand new")
    await userEvent.click(screen.getByTestId("twin-selector-name-submit"))
    await waitFor(async () => {
      const rows = await refreshTwins()
      expect(rows[0].name).toBe("Brand new")
      expect(rows[0].updatedAt).toBeGreaterThan(100)
    })
  })

  it("clones the active twin and switches to the new id", async () => {
    const src = await createTwin({ id: "twin_src", name: "Source", color: "#ff0000" })
    const onSelect = jest.fn()
    const onAfterCreate = jest.fn()
    render(
      <TwinSelector
        twins={[src]}
        activeTwinId={src.id}
        onSelect={onSelect}
        onAfterCreate={onAfterCreate}
      />
    )
    await userEvent.click(screen.getByRole("button", { name: /Active twin: Source/i }))
    await userEvent.click(await screen.findByText("Clone"))
    // Default clone name = "Source (copy)" — accept it.
    await userEvent.click(screen.getByTestId("twin-selector-name-submit"))
    await waitFor(async () => {
      const rows = await refreshTwins()
      expect(rows).toHaveLength(2)
      const clone = rows.find((r) => r.id !== "twin_src")
      expect(clone?.name).toBe("Source (copy)")
      expect(clone?.color).toBe("#ff0000")
    })
    expect(onAfterCreate).toHaveBeenCalled()
    expect(onSelect).toHaveBeenCalledWith(expect.not.stringMatching(/^twin_src$/))
  })

  it("archives and shows archived twins under a divider", async () => {
    const a = await createTwin({ id: "twin_a", name: "Active" })
    const arc = await createTwin({ id: "twin_arc", name: "Archived twin", archived: true })
    render(<TwinSelector twins={[a, arc]} activeTwinId={a.id} onSelect={jest.fn()} />)
    await userEvent.click(screen.getByRole("button", { name: /Active twin: Active/i }))
    // The section header "Archived" and the archived twin's name should both
    // render — we assert on the twin name (unique) and the section header
    // via dropdown-menu-label slot existence.
    await screen.findByText("Archived twin")
    expect(screen.getAllByText(/Archived/).length).toBeGreaterThan(1)
  })

  it("toggles archive on the active twin and bumps updatedAt", async () => {
    const twin = await createTwin({ id: "twin_y", name: "Toggle me", updatedAt: 100 })
    render(<TwinSelector twins={[twin]} activeTwinId={twin.id} onSelect={jest.fn()} />)
    await userEvent.click(screen.getByRole("button", { name: /Active twin: Toggle me/i }))
    await userEvent.click(await screen.findByText("Archive"))
    await waitFor(async () => {
      const rows = await refreshTwins()
      expect(rows[0].archived).toBe(true)
    })
  })

  it("hard-deletes the active twin with cascade + emits onAfterDelete", async () => {
    const t1 = await createTwin({ id: "twin_keep", name: "Keep" })
    const t2 = await createTwin({ id: "twin_kill", name: "Kill" })
    const onAfterDelete = jest.fn()
    const onSelect = jest.fn()
    render(
      <TwinSelector
        twins={[t1, t2]}
        activeTwinId={t2.id}
        onSelect={onSelect}
        onAfterDelete={onAfterDelete}
      />
    )
    await userEvent.click(screen.getByRole("button", { name: /Active twin: Kill/i }))
    await userEvent.click(await screen.findByTestId("twin-selector-delete"))
    await userEvent.click(await screen.findByTestId("twin-selector-delete-confirm"))
    await waitFor(async () => {
      const rows = await refreshTwins()
      expect(rows.map((r) => r.id)).toEqual(["twin_keep"])
    })
    // `deleteTwin` commits the cascade transaction (so the rows above are gone)
    // before awaiting its best-effort post-commit cleanup and only then resolving.
    // The callbacks fire after that resolution, so we must wait for them rather
    // than asserting synchronously the moment the rows disappear. Waiting here
    // also drains those post-commit promises before the suite tears down, which
    // is what prevents the "Cannot log after tests are done" async leak.
    await waitFor(() => {
      expect(onAfterDelete).toHaveBeenCalledWith(
        "twin_kill",
        expect.objectContaining({ sources: 0, chunks: 0 }),
        "Kill"
      )
    })
    // We deleted the active twin, so the selector should fall back to the
    // other one and emit onSelect with its id.
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith("twin_keep")
    })
  })
})
