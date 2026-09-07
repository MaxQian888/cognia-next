/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"

const saveConfig = jest.fn(async (_id: string, _config: Record<string, unknown>) => true)
let readiness = { availability: { state: "available", reason: "local-host" }, can: true }

jest.mock("@/hooks/bots/use-bot-lifecycle-actions", () => ({
  useBotLifecycleReadiness: () => readiness,
  useBotLifecycleActions: () => ({
    pending: new Set<string>(),
    saveConfig: (id: string, config: Record<string, unknown>) => saveConfig(id, config),
  }),
}))

import { BotConfigSection } from "./config-section"

const SCHEMA = {
  type: "object",
  properties: {
    channel: { type: "string", title: "Channel", default: "#general" },
    verbose: { type: "boolean", title: "Verbose" },
  },
}

function row(over: Partial<BotConsoleRow> = {}): BotConsoleRow {
  return {
    id: "boti_1",
    definitionId: "acme:review",
    source: "plugin",
    name: "Review",
    executor: "handler",
    status: "enabled",
    scope: { kind: "account" },
    orphaned: false,
    problems: [],
    triggers: [],
    armedTriggers: 0,
    unboundSlots: [],
    requiredSlots: [],
    credentials: [],
    config: {},
    configSchema: SCHEMA,
    deadLetters: 0,
    updatedAt: 10,
    ...over,
  }
}

beforeEach(() => {
  saveConfig.mockClear().mockResolvedValue(true)
  readiness = { availability: { state: "available", reason: "local-host" }, can: true }
})

describe("BotConfigSection", () => {
  it("seeds a field from the schema default when the installation set nothing", () => {
    // Through `resolveBotConfig`, the same resolver the runtime uses, so the
    // form opens with what a run would actually receive.
    render(<BotConfigSection row={row()} />)
    expect(screen.getByLabelText("Channel")).toHaveValue("#general")
  })

  it("prefers the installation's stored value over the default", () => {
    render(<BotConfigSection row={row({ config: { channel: "#ops" } })} />)
    expect(screen.getByLabelText("Channel")).toHaveValue("#ops")
  })

  it("submits the whole form, so a cleared field is actually cleared", async () => {
    const user = userEvent.setup()
    render(<BotConfigSection row={row({ config: { channel: "#ops" } })} />)
    await user.clear(screen.getByLabelText("Channel"))
    await user.click(screen.getByRole("button", { name: "Save settings" }))
    expect(saveConfig).toHaveBeenCalledWith("boti_1", { channel: "", verbose: false })
  })

  it("says the Bot has no settings rather than rendering an empty form", () => {
    const withoutSchema = row()
    delete (withoutSchema as { configSchema?: unknown }).configSchema
    render(<BotConfigSection row={withoutSchema} />)
    expect(screen.getByText("Nothing to configure")).toBeInTheDocument()
    expect(screen.queryByTestId("bot-config")).not.toBeInTheDocument()
  })

  it("tells an orphan apart from a Bot that simply has no settings", () => {
    const orphan = row({ orphaned: true })
    delete (orphan as { configSchema?: unknown }).configSchema
    render(<BotConfigSection row={orphan} />)
    expect(screen.getByText("No settings to show")).toBeInTheDocument()
  })

  it("renders the form DISABLED with the reason rather than hiding it", () => {
    // An absent form says "this Bot has no settings", which is a different
    // answer from "not from here".
    readiness = {
      availability: { state: "unsupported", reason: "requires-companion" },
      can: false,
    }
    render(<BotConfigSection row={row()} />)
    expect(screen.getByLabelText("Channel")).toBeDisabled()
    expect(screen.getByTestId("bot-config-blocked")).toHaveTextContent(
      "This browser cannot run Bots"
    )
  })
})
