import type { BotInstallationRow } from "@/lib/db/bot-types"
import type { InstalledBot } from "@/lib/bot/installed-bot"
import { resolveBotPolicy } from "@/lib/bot/policy/ceilings"
import type { PluginBotTriggerDef } from "@/types/plugin/plugin-bot"

import {
  botRowIsArmed,
  botRowNeedsAttention,
  buildBotRow,
  buildBotRows,
  buildBotStats,
  countDeadLettersByInstallation,
  filterBotRows,
  matchesBotSearch,
  summarizeBotRows,
  triggerDetail,
  type BotConsoleRow,
} from "./bot-rows"

const MANUAL: PluginBotTriggerDef = { id: "run", kind: "manual" }

function installation(over: Partial<BotInstallationRow> = {}): BotInstallationRow {
  return {
    id: "boti_1",
    definitionId: "acme:review",
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    status: "enabled",
    config: {},
    credentialBindings: {},
    createdAt: 1,
    updatedAt: 10,
    ...over,
  }
}

function resolved(
  row: BotInstallationRow,
  over: Partial<InstalledBot["definition"]> = {},
  problems: InstalledBot["problems"] = []
): InstalledBot {
  const definition = {
    id: row.definitionId,
    name: "Review",
    version: "1.0.0",
    executor: "handler" as const,
    triggers: [MANUAL],
    source: "plugin" as const,
    ...over,
  }
  // The real fold rather than an empty object: the console renders the
  // provenance, and a stubbed `{}` here would let a row that drops it pass.
  const policyResolution = resolveBotPolicy([
    { name: "definition", policy: definition.policy },
    { name: "installation", policy: row.policyGrant },
  ])
  return {
    installation: row,
    definition,
    policy: policyResolution.policy,
    policyResolution,
    problems,
  }
}

describe("triggerDetail", () => {
  it("projects health and manual input forms without creating a second configuration model", () => {
    const raw = installation({
      activatedAt: 2,
      monitor: { lastError: "offline", lastSuccessAt: 3 },
    })
    const inputSchema = { type: "object" }
    const row = buildBotRow({
      installation: raw,
      resolved: resolved(raw, { triggers: [{ ...MANUAL, inputSchema }] }),
    })
    expect(row.monitor).toEqual(raw.monitor)
    expect(row.activatedAt).toBe(2)
    expect(row.triggers[0].inputSchema).toEqual(inputSchema)
    expect(botRowNeedsAttention(row)).toBe(true)
  })
  it("gives back the literal each kind carries, and nothing for the ones that carry none", () => {
    expect(triggerDetail({ id: "c", kind: "schedule", cron: "0 9 * * *" })).toBe("0 9 * * *")
    expect(
      triggerDetail({ id: "e", kind: "event", source: "integration", types: ["a.b", "a.c"] })
    ).toBe("a.b, a.c")
    expect(triggerDetail({ id: "i", kind: "interaction", adapterTypes: ["lark"] })).toBe("lark")
    expect(triggerDetail({ id: "d", kind: "derivedState", everyMs: 1, state: "stale" })).toBe(
      "stale"
    )
    expect(triggerDetail(MANUAL)).toBeUndefined()
    // An event trigger with an empty type list has nothing to add, and an
    // empty string would render as a stray separator.
    expect(triggerDetail({ id: "e", kind: "event", source: "bot", types: [] })).toBeUndefined()
  })

  it("keeps an interval off the literal, because it is a translated sentence", () => {
    const row = buildBotRow({
      installation: installation(),
      resolved: resolved(installation(), {
        triggers: [{ id: "p", kind: "poll", everyMs: 300_000 }],
      }),
    })
    expect(row.triggers[0]).toMatchObject({ everyMs: 300_000 })
    expect(row.triggers[0].detail).toBeUndefined()
  })
})

describe("buildBotRow", () => {
  it("reads the armed state through the installation's overrides", () => {
    const inst = installation({ triggerOverrides: { run: false } })
    const row = buildBotRow({ installation: inst, resolved: resolved(inst) })
    expect(row.triggers).toEqual([{ id: "run", kind: "manual", armed: false }])
    expect(row.armedTriggers).toBe(0)
  })

  it("falls back to the definition's own default when nothing overrides it", () => {
    const inst = installation()
    const row = buildBotRow({
      installation: inst,
      resolved: resolved(inst, {
        triggers: [{ id: "push", kind: "event", source: "integration", types: ["push"] }],
      }),
    })
    expect(row.armedTriggers).toBe(1)
  })

  it("keeps a row for an installation whose definition is gone", () => {
    // Dropping it would leave a user with an installation they can neither see
    // nor uninstall, still holding scheduler rows.
    const row = buildBotRow({ installation: installation(), resolved: null })
    expect(row.orphaned).toBe(true)
    expect(row.name).toBe("acme:review")
    expect(row.executor).toBeUndefined()
    expect(row.triggers).toEqual([])
  })

  it("reports the required slots that are still unbound", () => {
    const inst = installation({ credentialBindings: { token: {} } })
    const row = buildBotRow({
      installation: inst,
      resolved: resolved(inst, {
        requires: {
          credentials: [
            { id: "token", label: "Token" },
            { id: "optional", label: "Optional", optional: true },
          ],
        },
      }),
    })
    // An empty object under a slot id is what a half-finished wizard leaves.
    expect(row.unboundSlots).toEqual(["token"])
    expect(row.requiredSlots).toHaveLength(2)
  })

  it("carries the resolution problems through rather than collapsing them", () => {
    const inst = installation()
    const row = buildBotRow({
      installation: inst,
      resolved: resolved(inst, {}, [
        { kind: "version_drift", pinned: "1.0.0", available: "1.1.0" },
      ]),
    })
    expect(row.problems).toEqual([{ kind: "version_drift", pinned: "1.0.0", available: "1.1.0" }])
  })
})

describe("buildBotRow credentials and policy", () => {
  it("joins each declared slot to what it is bound to, never to a secret", () => {
    const inst = installation({
      credentialBindings: { token: { integrationAccountId: "acct_9" }, chat: {} },
    })
    const row = buildBotRow({
      installation: inst,
      resolved: resolved(inst, {
        requires: {
          credentials: [
            { id: "token", label: "Token", integration: "github" },
            { id: "chat", label: "Chat", optional: true },
          ],
        },
      }),
    })
    expect(row.credentials).toEqual([
      {
        id: "token",
        label: "Token",
        optional: false,
        bound: true,
        integration: "github",
        integrationAccountId: "acct_9",
      },
      // An empty object under a slot id is a half-finished wizard, not a
      // binding, so this one is listed and unbound.
      { id: "chat", label: "Chat", optional: true, bound: false },
    ])
  })

  it("carries the policy fold with its provenance, not just the numbers", () => {
    const inst = installation({ policyGrant: { maxConcurrentRuns: 1 } })
    const row = buildBotRow({
      installation: inst,
      resolved: resolved(inst, { policy: { maxRunDurationMs: 60_000 } }),
    })
    expect(row.policy?.policy).toMatchObject({ maxRunDurationMs: 60_000, maxConcurrentRuns: 1 })
    expect(row.policy?.provenance).toMatchObject({
      maxRunDurationMs: "definition",
      maxConcurrentRuns: "installation",
    })
  })

  it("leaves the policy absent for an orphan rather than reading as no limits", () => {
    const row = buildBotRow({ installation: installation(), resolved: null })
    expect(row.policy).toBeUndefined()
    expect(row.credentials).toEqual([])
  })
})

describe("buildBotRows", () => {
  it("orders newest first", () => {
    const rows = buildBotRows([
      { installation: installation({ id: "a", updatedAt: 1 }), resolved: null },
      { installation: installation({ id: "b", updatedAt: 9 }), resolved: null },
    ])
    expect(rows.map((row) => row.id)).toEqual(["b", "a"])
  })
})

describe("configuration on the row", () => {
  it("carries the definition's schema and the installation's stored values", () => {
    const install = installation({ config: { channel: "#ops" } })
    const row = buildBotRow({
      installation: install,
      resolved: resolved(install, {
        configSchema: { properties: { channel: { type: "string" } } },
      }),
    })
    expect(row.configSchema).toEqual({ properties: { channel: { type: "string" } } })
    expect(row.config).toEqual({ channel: "#ops" })
  })

  it("omits the schema for a definition that has none, rather than an empty object", () => {
    // "Nothing to configure" and "an empty form" are different answers.
    const install = installation()
    const row = buildBotRow({ installation: install, resolved: resolved(install) })
    expect("configSchema" in row).toBe(false)
  })

  it("keeps an orphan's stored config, which is all that is left of it", () => {
    const row = buildBotRow({
      installation: installation({ config: { channel: "#ops" } }),
      resolved: null,
    })
    expect(row.config).toEqual({ channel: "#ops" })
    expect("configSchema" in row).toBe(false)
  })
})

describe("countDeadLettersByInstallation", () => {
  it("counts only dead letters, per installation", () => {
    expect(
      countDeadLettersByInstallation([
        { installationId: "a", status: "deadletter" },
        { installationId: "a", status: "deadletter" },
        { installationId: "a", status: "failed" },
        { installationId: "b", status: "succeeded" },
      ])
    ).toEqual({ a: 2 })
  })
})

describe("botRowNeedsAttention", () => {
  function row(over: Partial<BotConsoleRow> = {}): BotConsoleRow {
    const inst = installation()
    return { ...buildBotRow({ installation: inst, resolved: resolved(inst) }), ...over }
  }

  it("lights up for an unbound credential and for a dead letter", () => {
    expect(botRowNeedsAttention(row({ status: "needs_setup" }))).toBe(true)
    expect(botRowNeedsAttention(row({ deadLetters: 1 }))).toBe(true)
  })

  it("lights up for a handler that never resolved, because that Bot cannot run", () => {
    expect(
      botRowNeedsAttention(
        row({ problems: [{ kind: "handler_missing", definitionId: "acme:review" }] })
      )
    ).toBe(true)
  })

  it("stays dark for version drift", () => {
    // The Bot keeps running on the version that exists. Lighting up for every
    // ordinary plugin update trains the reader to ignore the light.
    expect(
      botRowNeedsAttention(
        row({ problems: [{ kind: "version_drift", pinned: "1.0.0", available: "1.1.0" }] })
      )
    ).toBe(false)
  })

  it("stays dark for an orphan, which is inert rather than broken", () => {
    expect(botRowNeedsAttention(row({ orphaned: true }))).toBe(false)
  })
})

describe("botRowIsArmed", () => {
  const base = buildBotRow({ installation: installation(), resolved: resolved(installation()) })

  it("needs an enabled installation with at least one armed trigger", () => {
    expect(botRowIsArmed(base)).toBe(true)
    expect(botRowIsArmed({ ...base, status: "disabled" })).toBe(false)
    expect(botRowIsArmed({ ...base, armedTriggers: 0 })).toBe(false)
  })

  it("refuses an orphan and a missing handler", () => {
    expect(botRowIsArmed({ ...base, orphaned: true })).toBe(false)
    expect(
      botRowIsArmed({
        ...base,
        problems: [{ kind: "handler_missing", definitionId: "acme:review" }],
      })
    ).toBe(false)
  })
})

describe("summarizeBotRows", () => {
  it("counts the four numbers the masthead shows", () => {
    const armed = buildBotRow({ installation: installation(), resolved: resolved(installation()) })
    const stuck = { ...armed, id: "boti_2", status: "needs_setup" as const, deadLetters: 3 }
    expect(summarizeBotRows([armed, stuck])).toEqual({
      total: 2,
      armed: 1,
      needsAttention: 1,
      deadLetters: 3,
    })
  })
})

describe("matchesBotSearch / filterBotRows", () => {
  const armed = buildBotRow({ installation: installation(), resolved: resolved(installation()) })
  const stuck: BotConsoleRow = { ...armed, id: "boti_2", status: "needs_setup", name: "Digest" }

  it("matches the name, the definition id and the installation id", () => {
    expect(matchesBotSearch(armed, "rev")).toBe(true)
    expect(matchesBotSearch(armed, "acme:")).toBe(true)
    expect(matchesBotSearch(armed, "boti_1")).toBe(true)
    expect(matchesBotSearch(armed, "nope")).toBe(false)
    expect(matchesBotSearch(armed, "   ")).toBe(true)
  })

  it("filters by status and by attention independently", () => {
    expect(filterBotRows([armed, stuck], "", "all")).toHaveLength(2)
    expect(filterBotRows([armed, stuck], "", "needs_setup").map((r) => r.id)).toEqual(["boti_2"])
    expect(filterBotRows([armed, stuck], "", "attention").map((r) => r.id)).toEqual(["boti_2"])
    expect(filterBotRows([armed, stuck], "digest", "all").map((r) => r.id)).toEqual(["boti_2"])
  })
})

describe("buildBotStats", () => {
  const inst = installation()
  const base = buildBotRow({ installation: inst, resolved: resolved(inst) })

  it("marks a Bot with no armed trigger as needing a look", () => {
    // Installed and inert reads identically to healthy unless the strip says
    // so, which is the whole reason the masthead carries this number.
    expect(buildBotStats({ ...base, armedTriggers: 0 })).toEqual([
      { id: "triggers", value: 0, total: 1, tone: "attention" },
    ])
    expect(buildBotStats(base)).toEqual([{ id: "triggers", value: 1, total: 1, tone: "positive" }])
  })

  it("prints a credential fraction only for a Bot that needs credentials", () => {
    expect(buildBotStats(base).map((s) => s.id)).not.toContain("credentials")
    const withSlots = buildBotStats({
      ...base,
      requiredSlots: [
        { id: "token", label: "Token" },
        { id: "other", label: "Other" },
      ],
      unboundSlots: ["token"],
    })
    expect(withSlots).toContainEqual({
      id: "credentials",
      value: 1,
      total: 2,
      tone: "attention",
    })
  })

  it("prints dead letters only when there are any", () => {
    expect(buildBotStats(base).map((s) => s.id)).not.toContain("deadLetters")
    expect(buildBotStats({ ...base, deadLetters: 4 })).toContainEqual({
      id: "deadLetters",
      value: 4,
      tone: "critical",
    })
  })

  it("returns nothing at all for an orphan, which can answer no question", () => {
    expect(buildBotStats({ ...base, orphaned: true, triggers: [], requiredSlots: [] })).toEqual([])
  })
})
