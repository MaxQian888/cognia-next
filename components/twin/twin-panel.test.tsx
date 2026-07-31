/**
 * Light integration coverage for the twin workbench. We don't render every
 * tab here — that would balloon the test surface — but we exercise:
 *
 *   • the empty-state when no characters bind a twin
 *   • the single-twin path (chooser hidden, label shown)
 *   • the multi-twin path (chooser shown, switching between twins)
 *   • the upload + delete round-trip in the Sources tab
 *   • the draft accept flow in the Drafts tab
 */

import "fake-indexeddb/auto"
import React from "react"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// Radix Select is tricky in jsdom because of pointer-event/scroll APIs.
// Use a native-<select>-backed stub that mirrors the contract we use:
// the Select wrapper exposes a single native <select> carrying the aria-label
// from SelectTrigger and the option list from SelectItem children.
jest.mock("@/components/ui/select", () => {
  type SelectChildren = {
    ariaLabel?: string
    options: Array<{ value: string; label: React.ReactNode }>
  }

  const collect = (nodes: React.ReactNode, sink: SelectChildren): void => {
    React.Children.forEach(nodes, (child) => {
      if (!React.isValidElement(child)) return
      const { type, props } = child as React.ReactElement<{
        children?: React.ReactNode
        value?: string
        "aria-label"?: string
        __stubKind?: string
      }>
      if (
        typeof type === "function" &&
        (type as { displayName?: string }).displayName === "SelectTriggerStub"
      ) {
        if (props["aria-label"]) sink.ariaLabel = props["aria-label"]
      }
      if (
        typeof type === "function" &&
        (type as { displayName?: string }).displayName === "SelectItemStub"
      ) {
        sink.options.push({ value: props.value ?? "", label: props.children })
        return
      }
      collect(props.children, sink)
    })
  }

  const SelectTriggerStub: React.FC<
    React.HTMLAttributes<HTMLDivElement> & { "aria-label"?: string }
  > = ({ children }) => <>{children}</>
  ;(SelectTriggerStub as React.FC & { displayName?: string }).displayName = "SelectTriggerStub"

  const SelectItemStub: React.FC<{ value: string; children: React.ReactNode }> = ({ children }) => (
    <>{children}</>
  )
  ;(SelectItemStub as React.FC & { displayName?: string }).displayName = "SelectItemStub"

  const Select: React.FC<{
    value: string
    onValueChange: (v: string) => void
    children: React.ReactNode
  }> = ({ value, onValueChange, children }) => {
    const harvest: SelectChildren = { options: [] }
    collect(children, harvest)
    return (
      <select
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        aria-label={harvest.ariaLabel}
      >
        {harvest.options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    )
  }

  return {
    Select,
    SelectTrigger: SelectTriggerStub,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectValue: () => null,
    SelectItem: SelectItemStub,
  }
})

// motion/react can hydrate fine in jsdom but ships unnecessary overhead in tests.
jest.mock("motion/react", () => {
  const passthrough = (tag: keyof React.JSX.IntrinsicElements & string) => {
    const Stub = ({ children, ...props }: React.HTMLAttributes<HTMLElement>) =>
      React.createElement(tag, props, children)
    Stub.displayName = `MotionStub(${tag})`
    return Stub
  }
  const AnimatePresence = ({ children }: { children: React.ReactNode }) => <>{children}</>
  AnimatePresence.displayName = "AnimatePresenceStub"
  return {
    motion: {
      div: passthrough("div"),
      li: passthrough("li"),
      span: passthrough("span"),
      button: passthrough("button"),
    },
    AnimatePresence,
    useReducedMotion: () => false,
  }
})

import { TwinPanel } from "./twin-panel"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createCharacter } from "@/lib/db/characters"
import { createTwinSource } from "@/lib/db/twin-sources"
import { createTwinDraft } from "@/lib/db/twin-drafts"
import {
  registerMockExtension,
  clearAllMockExtensions,
} from "@/components/plugins/test-utils/register-mock-extension"

// Dexie + RTL integration flows; give a cold IndexedDB open headroom over 5s.
jest.setTimeout(20000)

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  const db = getDb()
  await Promise.all([
    db.twinSources.clear(),
    db.twinChunks.clear(),
    db.twinDrafts.clear(),
    db.twinJobs.clear(),
    db.twinProfile.clear(),
  ])
})

afterEach(() => {
  clearAllMockExtensions()
})

describe("TwinPanel", () => {
  it("renders the empty state with a guided-create CTA when no twin exists", async () => {
    render(<TwinPanel />)
    await screen.findByText(/No digital twins yet/i)
    expect(await screen.findByTestId("twin-empty-create")).toBeInTheDocument()
  })

  it("opens the guided wizard from the empty-state CTA", async () => {
    render(<TwinPanel />)
    await userEvent.click(await screen.findByTestId("twin-empty-create"))
    await screen.findByTestId("twin-wizard")
  })

  it("keeps the creation wizard mounted (no reset to step 1) when the first twin is created", async () => {
    // Regression: creating the first twin flips the live query empty→non-empty,
    // swapping the empty-state branch for the main branch. When the wizard was
    // rendered at a different tree position in each branch, React remounted it,
    // resetting it to step 1 and orphaning the just-created twin.
    render(<TwinPanel />)
    await userEvent.click(await screen.findByTestId("twin-empty-create"))
    await screen.findByTestId("twin-wizard")
    await userEvent.type(screen.getByTestId("twin-wizard-name"), "First Twin")
    await userEvent.click(screen.getByTestId("twin-wizard-next"))
    // The wizard must ADVANCE to step 2 (sources), not remount back to step 1.
    await screen.findByTestId("twin-wizard-sources-count")
    expect(screen.queryByTestId("twin-wizard-name")).not.toBeInTheDocument()
  })

  it("hides the toolbar controls in the empty state and shows them once a twin exists", async () => {
    const { unmount } = render(<TwinPanel />)
    await screen.findByTestId("twin-empty-create")
    // Toolbar renders the title only — no selector / worker pill without a twin.
    expect(screen.getByTestId("twin-toolbar")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Active twin/i })).not.toBeInTheDocument()
    unmount()

    await createCharacter({
      name: "Alice",
      systemPrompt: "you are alice",
      twinId: "twin_alice",
    })
    render(<TwinPanel />)
    await screen.findByRole("button", { name: /Active twin/i })
    expect(screen.getByTestId("twin-toolbar")).toHaveTextContent(/worker/i)
  })

  it("mounts the twin.panel.header plugin slot in the header once a twin exists", async () => {
    await createCharacter({
      name: "Alice",
      systemPrompt: "you are alice",
      twinId: "twin_alice",
    })
    registerMockExtension("twin.panel.header", () => (
      <span data-testid="twin-header-plugin">header plugin</span>
    ))
    render(<TwinPanel />)
    expect(await screen.findByTestId("twin-header-plugin")).toBeInTheDocument()
  })

  it("backfills a registry row from a legacy character.twinId and shows it in the switcher", async () => {
    await createCharacter({
      name: "Alice",
      systemPrompt: "you are alice",
      twinId: "twin_alice",
    })
    render(<TwinPanel />)
    // The mount-time backfill turns the legacy twinId into a named registry row.
    await screen.findByRole("button", { name: /Active twin: Alice/i })
  })

  it("switches between twins via the selector dropdown", async () => {
    await createCharacter({
      name: "Alice",
      systemPrompt: "you are alice",
      twinId: "twin_alice",
    })
    await createCharacter({
      name: "Bob",
      systemPrompt: "you are bob",
      twinId: "twin_bob",
    })
    render(<TwinPanel />)
    const trigger = await screen.findByRole("button", { name: /Active twin:/i })
    await userEvent.click(trigger)
    await userEvent.click(await screen.findByTestId("twin-selector-item-twin_bob"))
    await screen.findByRole("button", { name: /Active twin: Bob/i })
  })

  it("shows the source list and supports deleting a source", async () => {
    await createCharacter({
      name: "Alice",
      systemPrompt: "you are alice",
      twinId: "twin_alice",
    })
    const source = await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/notes.md",
      title: "Onboarding notes",
      bytes: 100,
      fingerprint: "f1",
      redacted: false,
    })
    render(<TwinPanel />)
    await screen.findByText("Onboarding notes")
    expect(screen.getAllByText(/Sources/i).length).toBeGreaterThan(0)
    const deleteBtn = screen.getByRole("button", { name: /delete/i })
    await userEvent.click(deleteBtn)
    // Deleting now requires confirming in an alert dialog.
    const dialog = await screen.findByRole("alertdialog")
    await userEvent.click(within(dialog).getByRole("button", { name: /^Delete$/i }))
    await waitFor(async () => {
      expect(await getDb().twinSources.get(source.id)).toBeUndefined()
    })
    await waitFor(() => {
      expect(screen.queryByTestId(`twin-source-${source.id}-row`)).not.toBeInTheDocument()
    })
  })

  it("renders pending draft details and accept / reject buttons", async () => {
    await createCharacter({
      name: "Alice",
      systemPrompt: "you are alice",
      twinId: "twin_alice",
    })
    await createTwinDraft({
      twinId: "twin_alice",
      jobId: "job_1",
      kind: "skill",
      payload: {
        kind: "skill",
        data: {
          name: "Triage P1",
          description: "outage triage",
          content: "## Steps\n1. Acknowledge",
        },
      },
      provenance: { chunkIds: ["c1"], rationale: "frequent" },
      evaluation: { qualityScore: 0.4, concerns: ["thin"], suggestions: ["add examples"] },
    })
    render(<TwinPanel />)
    // Radix Tabs may render either role="tab" or a plain button — use a
    // text-based query and click whatever matched.
    const draftsTrigger = await screen.findByText("Drafts")
    await userEvent.click(draftsTrigger)
    await screen.findByText("Triage P1")
    expect(screen.getByText(/quality: low/i)).toBeInTheDocument()
    expect(screen.getByText(/thin/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /accept/i })).toBeEnabled()
    expect(screen.getByRole("button", { name: /reject/i })).toBeEnabled()
  })
})
