/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import React from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// Radix Tabs needs pointer / scroll APIs that jsdom doesn't expose; stub it
// with a context-backed shim that mirrors the value / onValueChange contract.
jest.mock("@/components/ui/tabs", () => {
  type Ctx = { value: string; set: (v: string) => void }
  const TabsContext = React.createContext<Ctx>({ value: "", set: () => {} })
  return {
    Tabs: ({
      children,
      value,
      onValueChange,
    }: {
      children: React.ReactNode
      value: string
      onValueChange: (v: string) => void
    }) =>
      React.createElement(
        TabsContext.Provider,
        { value: { value, set: onValueChange } },
        React.createElement("div", { "data-testid": "tabs-root", "data-value": value }, children)
      ),
    TabsList: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", { role: "tablist" }, children),
    TabsTrigger: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const ctx = React.useContext(TabsContext)
      return React.createElement(
        "button",
        {
          role: "tab",
          "data-testid": `tab-${value}`,
          onClick: () => ctx.set(value),
        },
        children
      )
    },
    TabsContent: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const ctx = React.useContext(TabsContext)
      return ctx.value === value
        ? React.createElement("div", { "data-testid": `tabpanel-${value}` }, children)
        : null
    },
  }
})

import { TwinPersonaTab } from "./twin-persona-tab"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { addEntity, appendPlaybooks, appendStyleSamples } from "@/lib/db/twin-profile"
import {
  registerMockExtension,
  clearAllMockExtensions,
} from "@/components/plugins/test-utils/register-mock-extension"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

afterEach(() => {
  clearAllMockExtensions()
})

describe("TwinPersonaTab", () => {
  it("renders empty count badges and the entities subtab by default", async () => {
    render(<TwinPersonaTab twinId="twin_empty" />)
    expect(screen.getByTestId("persona-count-entities").textContent).toMatch(/0/)
    expect(screen.getByTestId("persona-count-playbooks").textContent).toMatch(/0/)
    expect(screen.getByTestId("persona-count-style").textContent).toMatch(/0/)
    expect(screen.getByTestId("tabpanel-entities")).toBeTruthy()
  })

  it("mounts the twin.persona.panel plugin slot below the sub-tabs", () => {
    registerMockExtension("twin.persona.panel", () => (
      <span data-testid="persona-plugin">persona plugin</span>
    ))
    render(<TwinPersonaTab twinId="twin_empty" />)
    expect(screen.getByTestId("persona-plugin")).toBeInTheDocument()
  })

  it("switches between sub-tabs", async () => {
    render(<TwinPersonaTab twinId="twin_empty" />)
    await userEvent.click(screen.getByTestId("tab-playbooks"))
    await waitFor(() => expect(screen.getByTestId("tabpanel-playbooks")).toBeTruthy())
    await userEvent.click(screen.getByTestId("tab-style"))
    await waitFor(() => expect(screen.getByTestId("tabpanel-style")).toBeTruthy())
  })

  it("reflects live counts after entities + playbooks + styleSamples land", async () => {
    await addEntity("twin_live", {
      name: "Alice",
      aliases: [],
      role: "person",
      firstSeenChunkId: "manual",
    })
    await appendPlaybooks("twin_live", [
      {
        id: "pb1",
        title: "On-call",
        trigger: "incident",
        steps: [{ order: 1, action: "ack" }],
        examples: [],
        confidence: 0.7,
      },
    ])
    await appendStyleSamples("twin_live", [
      {
        id: "s1",
        contextLabel: "PR description",
        original: "We chose to go with Kafka.",
        summary: "concise tone",
        sourceChunkId: "chunk-1",
        tone: ["concise"],
        addedAt: 1,
        addedBy: "distill",
      },
    ])
    render(<TwinPersonaTab twinId="twin_live" />)
    await waitFor(() => {
      expect(screen.getByTestId("persona-count-entities").textContent).toMatch(/1/)
      expect(screen.getByTestId("persona-count-playbooks").textContent).toMatch(/1/)
      expect(screen.getByTestId("persona-count-style").textContent).toMatch(/1/)
    })
  })
})
