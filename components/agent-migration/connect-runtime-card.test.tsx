/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import en from "@/i18n/messages/en.json"
import type { MigrationResult, MigrationVendor } from "@/lib/agent-migration/types"

const addAgentFromPreset = jest.fn()
let agents: Record<string, { metadata?: Record<string, unknown> }> = {}

jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ agents }),
    { getState: () => ({ addAgentFromPreset }) }
  ),
}))

import { ConnectRuntimeCard } from "./connect-runtime-card"

const result = (artifacts: MigrationResult["artifacts"]): MigrationResult => ({
  vendor: "codex",
  aborted: false,
  artifacts,
})

const renderCard = (vendor: MigrationVendor, migration: MigrationResult) =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ConnectRuntimeCard vendor={vendor} result={migration} />
    </NextIntlClientProvider>
  )

beforeEach(() => {
  addAgentFromPreset.mockReset()
  agents = {}
})

describe("ConnectRuntimeCard", () => {
  it("offers the preset that runs the migrated vendor", () => {
    renderCard("codex", result({ settings: { imported: 2, warnings: [] } }))
    expect(screen.getByTestId("connect-runtime-card")).toBeInTheDocument()
    expect(screen.getByText(/Connect Codex/)).toBeInTheDocument()
  })

  it("creates the connection from the preset", async () => {
    // `addAgentFromPreset` had no callers before this card.
    addAgentFromPreset.mockReturnValue("agent-1")
    renderCard("codex", result({ settings: { imported: 2, warnings: [] } }))
    await userEvent.click(screen.getByTestId("connect-runtime-action"))
    expect(addAgentFromPreset).toHaveBeenCalledWith("codex")
  })

  it("resolves Pi to a real preset, which the map this replaced could not", async () => {
    addAgentFromPreset.mockReturnValue("agent-2")
    renderCard("pi", result({ sessions: { imported: 4, warnings: [] } }))
    await userEvent.click(screen.getByTestId("connect-runtime-action"))
    expect(addAgentFromPreset).toHaveBeenCalledWith("pi-rpc")
  })

  it("says already connected instead of creating a duplicate", async () => {
    agents = { "agent-1": { metadata: { preset: "codex" } } }
    renderCard("codex", result({ settings: { imported: 2, warnings: [] } }))
    expect(screen.getByTestId("connect-runtime-connected")).toBeInTheDocument()
    expect(screen.queryByTestId("connect-runtime-action")).toBeNull()
  })

  it("reports a refused creation instead of looking like it worked", async () => {
    addAgentFromPreset.mockReturnValue(null)
    renderCard("codex", result({ settings: { imported: 1, warnings: [] } }))
    await userEvent.click(screen.getByTestId("connect-runtime-action"))
    expect(screen.getByRole("alert")).toHaveTextContent("The connection could not be created.")
  })

  it("stays hidden when the migration imported nothing", () => {
    // Every category shared, empty or unsupported. Offering to connect off the
    // back of that reads as a result the user did not get.
    renderCard(
      "codex",
      result({
        settings: { imported: 0, skipped: 3, warnings: [] },
        commands: { imported: 0, skipped: 5, warnings: [] },
      })
    )
    expect(screen.queryByTestId("connect-runtime-card")).toBeNull()
  })

  it("switches to connected after a successful create, without a store round trip", async () => {
    addAgentFromPreset.mockReturnValue("agent-9")
    renderCard("codex", result({ settings: { imported: 1, warnings: [] } }))
    await userEvent.click(screen.getByTestId("connect-runtime-action"))
    expect(screen.getByTestId("connect-runtime-connected")).toBeInTheDocument()
  })
})
