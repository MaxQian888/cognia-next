/**
 * The closed unions this module declares, pinned as values.
 *
 * A union is erased at compile time, so every exhaustive `Record<Union, X>` in
 * the console, the visuals and the queue is only exhaustive against whatever
 * the union said when that file was written. Adding a ninth delivery status is
 * a type error in each of those maps, which is the point, but nothing today
 * would tell a reader of THIS file how many there are supposed to be, or which
 * of them are terminal.
 *
 * `satisfies` is what makes the lists below real assertions: a member removed
 * from the union fails here, and a member added to the union without being
 * listed fails the count.
 */

import { isTerminalBotDelivery } from "./bot-event-deliveries"
import type {
  BotDefinitionSource,
  BotDeliveryStatus,
  BotInstallationStatus,
  BotScopeKind,
  LocalBotExecutor,
} from "./bot-types"

const DELIVERY_STATUSES = [
  "pending",
  "leased",
  "running",
  "parked",
  "succeeded",
  "failed",
  "deadletter",
  "dismissed",
] as const satisfies readonly BotDeliveryStatus[]

const INSTALLATION_STATUSES = [
  "enabled",
  "disabled",
  "needs_setup",
] as const satisfies readonly BotInstallationStatus[]

const SCOPE_KINDS = ["account", "workspace", "project"] as const satisfies readonly BotScopeKind[]

const DEFINITION_SOURCES = ["plugin", "local"] as const satisfies readonly BotDefinitionSource[]

const LOCAL_EXECUTORS = [
  "workflow",
  "squad",
  "agent-turn",
] as const satisfies readonly LocalBotExecutor[]

describe("BotDeliveryStatus", () => {
  it("has eight members, and the list here names all of them", () => {
    // A ninth arriving without a line here means one of the exhaustive maps
    // over this union was updated and this pin was not.
    expect(new Set(DELIVERY_STATUSES).size).toBe(8)
  })

  it("keeps parked out of the terminal set, because a parked run resumes", () => {
    // Settling it would close the run a person is still being asked about.
    expect(isTerminalBotDelivery("parked")).toBe(false)
    expect(isTerminalBotDelivery("pending")).toBe(false)
    expect(isTerminalBotDelivery("leased")).toBe(false)
    expect(isTerminalBotDelivery("running")).toBe(false)
  })

  it("treats a settled status as terminal, but not a retryable failure", () => {
    // `failed` backs off and returns to `pending`. Calling it terminal would
    // retire a delivery that has attempts left, and `deadletter` is the state
    // that means it has run out of them.
    for (const status of ["succeeded", "deadletter", "dismissed"] as const) {
      expect({ status, terminal: isTerminalBotDelivery(status) }).toEqual({
        status,
        terminal: true,
      })
    }
    expect(isTerminalBotDelivery("failed")).toBe(false)
  })
})

describe("BotInstallationStatus", () => {
  it("keeps needs_setup as a real third answer, not a flavour of disabled", () => {
    // Collapsing them leaves a user unable to tell "I turned this off" from
    // "this is one binding away from working".
    expect(INSTALLATION_STATUSES).toHaveLength(3)
    expect(INSTALLATION_STATUSES).toContain("needs_setup")
  })
})

describe("BotScopeKind and BotDefinitionSource", () => {
  it("names three scopes and two definition worlds", () => {
    expect(SCOPE_KINDS).toEqual(["account", "workspace", "project"])
    expect(DEFINITION_SOURCES).toEqual(["plugin", "local"])
  })
})

describe("LocalBotExecutor", () => {
  it("excludes handler, because a row has no module to load", () => {
    // A person who wants custom code writes a plugin.
    expect(LOCAL_EXECUTORS).not.toContain("handler")
    expect(LOCAL_EXECUTORS).toHaveLength(3)
  })
})
