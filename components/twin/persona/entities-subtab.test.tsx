/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import React from "react"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// AlertDialog / Dialog need a portal target in jsdom — Radix is fine but slow
// here; stub them with minimal modal-like containers so testing-library can
// reach the inner buttons without pointer-event gymnastics.
jest.mock("@/components/ui/alert-dialog", () => {
  return {
    AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
      open ? <div data-testid="alert-dialog">{children}</div> : null,
    AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AlertDialogAction: ({
      children,
      onClick,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) => (
      <button onClick={onClick} {...props}>
        {children}
      </button>
    ),
    AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  }
})
jest.mock("@/components/ui/dialog", () => {
  return {
    Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
      open ? <div data-testid="dialog">{children}</div> : null,
    DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
    DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  }
})
jest.mock("@/components/ui/select", () => {
  const Select = ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (v: string) => void
    children: React.ReactNode
  }) => {
    const options: Array<{ value: string; label: React.ReactNode }> = []
    const collect = (nodes: React.ReactNode) => {
      React.Children.forEach(nodes, (child) => {
        if (!React.isValidElement(child)) return
        const typed = child as React.ReactElement<{ value?: string; children?: React.ReactNode }>
        const props = typed.props
        if (
          (child.type as { displayName?: string }).displayName === "MockSelectItem" ||
          typeof props.value === "string"
        ) {
          if (typeof props.value === "string") {
            options.push({ value: props.value, label: props.children })
            return
          }
        }
        collect(props.children)
      })
    }
    collect(children)
    return (
      <select
        data-testid="entity-editor-role"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {typeof opt.label === "string" ? opt.label : opt.value}
          </option>
        ))}
      </select>
    )
  }
  const SelectItem = ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
  ;(SelectItem as unknown as { displayName: string }).displayName = "MockSelectItem"
  return {
    Select,
    SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem,
  }
})

import { EntitiesSubtab } from "./entities-subtab"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { getTwinProfile } from "@/lib/db/twin-profile"
import type { ProfileEntity } from "@/types/twin"

const TWIN_ID = "twin_x"

function makeEntity(name: string, extras: Partial<ProfileEntity> = {}): ProfileEntity {
  return {
    name,
    aliases: [],
    role: "person",
    firstSeenChunkId: "chunk-1",
    ...extras,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("EntitiesSubtab", () => {
  it("renders the empty hint when no entities exist", () => {
    render(<EntitiesSubtab twinId={TWIN_ID} entities={[]} />)
    expect(screen.getByText(/No entities yet/i)).toBeInTheDocument()
  })

  it("sorts pinned rows first", () => {
    render(
      <EntitiesSubtab
        twinId={TWIN_ID}
        entities={[makeEntity("Zoe"), makeEntity("Alice", { pinned: true }), makeEntity("Bob")]}
      />
    )
    const rows = screen.getAllByTestId(/^entity-row-/)
    expect(rows[0]).toHaveAttribute("data-testid", "entity-row-Alice")
  })

  it("filters by name / alias / relation", async () => {
    render(
      <EntitiesSubtab
        twinId={TWIN_ID}
        entities={[
          makeEntity("Alice", { aliases: ["alicia"] }),
          makeEntity("Bob", { relation: "ex-colleague at PhoenixCorp" }),
        ]}
      />
    )
    const search = screen.getByTestId("entities-search")
    await userEvent.type(search, "phoenix")
    await waitFor(() => {
      expect(screen.queryByTestId("entity-row-Alice")).toBeNull()
      expect(screen.getByTestId("entity-row-Bob")).toBeInTheDocument()
    })
  })

  it("adds a new entity through the editor (clean text passes the PII gate)", async () => {
    const { rerender } = render(<EntitiesSubtab twinId={TWIN_ID} entities={[]} />)
    await userEvent.click(screen.getByTestId("entities-add"))
    const dialog = screen.getByTestId("entity-editor-dialog")
    await userEvent.type(within(dialog).getByTestId("entity-editor-name"), "Alice")
    await userEvent.click(within(dialog).getByTestId("entity-editor-save"))
    await waitFor(async () => {
      const profile = await getTwinProfile(TWIN_ID)
      expect(profile?.entities.map((e) => e.name)).toEqual(["Alice"])
      expect(profile?.entities[0].pinned).toBe(true)
    })
    rerender(
      <EntitiesSubtab twinId={TWIN_ID} entities={(await getTwinProfile(TWIN_ID))!.entities} />
    )
  })

  it("blocks save when description carries PII", async () => {
    render(<EntitiesSubtab twinId={TWIN_ID} entities={[]} />)
    await userEvent.click(screen.getByTestId("entities-add"))
    const dialog = screen.getByTestId("entity-editor-dialog")
    await userEvent.type(within(dialog).getByTestId("entity-editor-name"), "Alice")
    await userEvent.type(
      within(dialog).getByTestId("entity-editor-relation"),
      "email me at alice@example.com"
    )
    await userEvent.click(within(dialog).getByTestId("entity-editor-save"))
    await waitFor(() =>
      expect(within(dialog).getByTestId("entity-editor-error")).toBeInTheDocument()
    )
    // Profile should still be empty — save was blocked.
    const profile = await getTwinProfile(TWIN_ID)
    expect(profile?.entities ?? []).toEqual([])
  })

  it("toggles the pinned flag through the row pin button", async () => {
    // Seed the row through the real CRUD so the next setEntityPinned call has
    // something to flip.
    const { addEntity } = await import("@/lib/db/twin-profile")
    await addEntity(TWIN_ID, makeEntity("Alice"))
    const profile = await getTwinProfile(TWIN_ID)
    render(<EntitiesSubtab twinId={TWIN_ID} entities={profile!.entities} />)
    await userEvent.click(screen.getByTestId("entity-pin-Alice"))
    await waitFor(async () => {
      const next = await getTwinProfile(TWIN_ID)
      expect(next?.entities[0].pinned).toBe(true)
    })
  })

  it("deletes a row through the AlertDialog confirm", async () => {
    const { addEntity } = await import("@/lib/db/twin-profile")
    await addEntity(TWIN_ID, makeEntity("Alice"))
    const profile = await getTwinProfile(TWIN_ID)
    render(<EntitiesSubtab twinId={TWIN_ID} entities={profile!.entities} />)
    await userEvent.click(screen.getByTestId("entity-delete-Alice"))
    await userEvent.click(screen.getByTestId("entity-delete-confirm"))
    await waitFor(async () => {
      const next = await getTwinProfile(TWIN_ID)
      expect(next?.entities ?? []).toEqual([])
    })
  })
})
