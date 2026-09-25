/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import type { AppSettings, ChatSession } from "@cognia/agent-config-types"
import {
  fakeCompiledConfig,
  fixtureRouteRequest,
  routeAction,
  RunAcceptedSchema,
  RunSnapshotSchema,
  uuidFromName,
  type RunRequestPolicy,
} from "@cognia/router-fusion"

const committed: Array<{ sessionId: string; upserts: unknown[] }> = []
jest.mock("@/lib/db/messages", () => ({
  commitMessageDelta: jest.fn(async (sessionId: string, delta: { upserts: unknown[] }) => {
    committed.push({ sessionId, upserts: delta.upserts })
  }),
}))

jest.mock("@/lib/db/paired-devices", () => ({
  getPairedDevice: jest.fn(async (deviceId: string) =>
    deviceId === "phone-1" ? { deviceId, label: "  Max's phone  " } : undefined
  ),
}))

const piiClean = jest.fn(() => true)
jest.mock("@cognia/redact", () => ({
  ...jest.requireActual("@cognia/redact"),
  hasNoLeakingPiiDeep: () => piiClean(),
}))

import { fusionContentCodec } from "../db/content-codec"
import { FusionDB } from "../db/fusion-db"
import { FusionLedgerStore } from "../db/ledger-store"
import { decodeRunInput } from "../db/run-input"
import {
  COMPANION_CONTEXT_MAX_TURNS,
  COMPANION_CONTEXT_TOKEN_BUDGET,
  companionActor,
  companionKeyId,
  companionRunRequest,
  controlCompanionRun,
  createCompanionRun,
  getCompanionRun,
  isCompanionRun,
  isCompanionRunMode,
  listCompanionRunEvents,
  resumeCompanionRun,
  trimCompanionContext,
} from "./companion-run-host"
import type { CreateRunFromApiInput, RunApiActor, RunApiDeps } from "./run-api"

const USD = 1_000_000
const NOW = 1_800_000_000_000
const config = fakeCompiledConfig()
let dbCounter = 0

const POLICY: RunRequestPolicy = {
  trackedBudgetEnabled: true,
  maxRunCapMicrousd: () => 5 * USD,
  workspaceAuthorized: () => false,
  acceptanceProfileExists: () => false,
  minimumProfile: "economy",
  degradeAllowed: true,
}

const SETTINGS = {
  routerFusion: {
    enabled: true,
    surfaces: { companion: true },
    budgetMode: "tracked",
    runCapUsdByMode: { direct: "0.40", cascade: "1.20", panel: "2.50", delegate: "3.00" },
  },
} as unknown as AppSettings

async function actorFor(deviceId: string): Promise<RunApiActor> {
  return companionActor(deviceId)
}

function harness() {
  const name = `fusion-companion-host-test-${++dbCounter}`
  const store = new FusionLedgerStore({
    db: new FusionDB(name),
    codec: fusionContentCodec(name),
    now: () => NOW,
  })
  const started: string[] = []
  const created: CreateRunFromApiInput[] = []
  const sessions = new Map<string, ChatSession>([
    [
      "desktop-session",
      { id: "desktop-session", title: "t", transcriptRevision: 6 } as ChatSession,
    ],
    [
      "scheduled-session",
      {
        id: "scheduled-session",
        title: "Morning digest (scheduled)",
        transcriptRevision: 2,
        origin: { kind: "scheduled-task", taskId: "task-1", taskName: "Morning digest" },
      } as ChatSession,
    ],
    [
      "key-session",
      {
        id: "key-session",
        title: "t",
        transcriptRevision: 1,
        origin: { kind: "gateway-api", keyId: "key-a", keyName: "CI robot" },
      } as ChatSession,
    ],
  ])
  const transcripts = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>()
  const transcriptModes: string[] = []
  let runs = 0
  let ids = 0
  const deps: RunApiDeps = {
    store: async () => store,
    appSettings: () => SETTINGS,
    policy: () => POLICY,
    createRun: async (input) => {
      created.push(input)
      const runId = uuidFromName(`companion-run:${++runs}`)
      const { decision } = routeAction(
        config,
        fixtureRouteRequest({ runId, decisionId: uuidFromName(`decision:${runId}`) })
      )
      const outcome = await store.createRun({
        runId,
        sessionId: input.session.id,
        surface: "companion",
        origin: "companion",
        decision,
        actionId: "direct_baseline",
        ruleId: null,
        roleDeployments: { solver: "fake-baseline" },
        config,
        capMicrousd: 1 * USD,
        maxModelCalls: 4,
        deadlineMs: 60_000,
        budgetMode: "tracked",
        tenantLimitRemainingMicrousd: null,
        actorKeyId: input.actor.keyId,
        actorKeyName: input.actor.keyName,
        inputArtifactId: input.inputArtifactId,
        currentSessionVersion: input.sessionVersion,
      })
      if (!outcome.ok) {
        return {
          ok: false as const,
          error: { status: 409 as const, code: outcome.code, message: outcome.code },
        }
      }
      return { ok: true as const, value: { runId } }
    },
    startRun: (runId) => started.push(runId),
    session: {
      get: async (id) => sessions.get(id),
      open: async (actor, title) => {
        const session = {
          id: `opened-${sessions.size + 1}`,
          title,
          transcriptRevision: 0,
          origin: { kind: "gateway-api", keyId: actor.keyId ?? "local", keyName: actor.keyName },
        } as ChatSession
        sessions.set(session.id, session)
        return session
      },
      messages: async (id) => transcripts.get(id) ?? [],
    },
    now: () => NOW,
    newId: () => uuidFromName(`id:${++ids}`),
  }
  /** What `createCompanionRun` asks the Run API wiring for, per call. */
  const apiDeps = (transcript: string) => {
    transcriptModes.push(transcript)
    return deps
  }
  return { store, deps, apiDeps, started, created, sessions, transcripts, transcriptModes }
}

beforeEach(() => {
  piiClean.mockReset().mockReturnValue(true)
  committed.length = 0
})

describe("companionActor", () => {
  it("acts as the paired device, named by its pairing label, with every Run API scope", async () => {
    const actor = await companionActor("phone-1")
    expect(actor).toEqual({
      keyId: "device:phone-1",
      keyName: "Max's phone",
      scopes: [
        "runs:create",
        "runs:read",
        "runs:cancel",
        "runs:approve",
        "artifacts:read",
        "feedback:write",
      ],
    })
    // A device this host has no row for is named by its id, not left anonymous.
    await expect(companionActor("tablet-9")).resolves.toMatchObject({
      keyId: "device:tablet-9",
      keyName: "device:tablet-9",
    })
    // The prefix keeps a device from ever being mistaken for a gateway key.
    expect(companionKeyId("key-a")).toBe("device:key-a")
  })
})

describe("companionRunRequest", () => {
  it("builds the request from this host's cap and budget mode, never from the phone's", () => {
    const request = companionRunRequest(SETTINGS, "panel", "compare these")
    expect(request).toMatchObject({
      mode: "panel",
      allowed_modes: ["panel"],
      budget: { max_cost_usd: "2.500000", mode: "tracked" },
      input_messages: [{ role: "user", content: "compare these" }],
      delivery: "verified_buffered",
      allow_degraded: true,
    })
    expect(isCompanionRunMode("cascade")).toBe(true)
    expect(isCompanionRunMode("delegate")).toBe(false)
  })
})

describe("createCompanionRun", () => {
  it("creates a companion run in the conversation the phone is showing, and starts it", async () => {
    const { apiDeps, store, started, created } = harness()
    const actor = await actorFor("phone-1")
    const outcome = await createCompanionRun(
      SETTINGS,
      {
        actor,
        mode: "cascade",
        text: "  summarise the design doc  ",
        sessionId: "desktop-session",
        idempotencyKey: "companion-run:k1",
      },
      { apiDeps }
    )
    if (!outcome.ok) throw new Error(outcome.error.code)
    expect(RunAcceptedSchema.safeParse(outcome.value.accepted).success).toBe(true)
    expect(outcome.value.replayed).toBe(false)
    expect(created[0]).toMatchObject({
      session: { id: "desktop-session" },
      sessionVersion: 6,
      messages: [{ role: "user", content: "summarise the design doc" }],
      actor: { keyId: "device:phone-1" },
    })
    const run = await store.getRun(outcome.value.accepted.run_id)
    expect(run).toMatchObject({ surface: "companion", actorKeyId: "device:phone-1" })
    const input = await store.artifactStore(run!.runId).get(run!.inputArtifactId!)
    expect(decodeRunInput(input?.content)?.messages).toEqual([
      { role: "user", content: "summarise the design doc" },
    ])
    expect(started).toEqual([run!.runId])
  })

  it("[ACC:API-02] replays the same run for the same key and message, and refuses a different message", async () => {
    const { apiDeps, store, started } = harness()
    const actor = await actorFor("phone-1")
    const input = {
      actor,
      mode: "cascade" as const,
      text: "hello",
      sessionId: "desktop-session",
      idempotencyKey: "companion-run:k2",
    }
    const first = await createCompanionRun(SETTINGS, input, { apiDeps })
    const again = await createCompanionRun(SETTINGS, input, { apiDeps })
    if (!first.ok || !again.ok) throw new Error("create refused")
    expect(again.value).toEqual({ accepted: first.value.accepted, replayed: true })
    expect(await store.db.fusionRuns.count()).toBe(1)
    expect(started).toHaveLength(1)

    const different = await createCompanionRun(
      SETTINGS,
      { ...input, text: "something else" },
      { apiDeps }
    )
    expect(different).toMatchObject({
      ok: false,
      error: { status: 409, code: "IDEMPOTENCY_CONFLICT" },
    })
  })

  it("opens a conversation for the device when the phone names none", async () => {
    const { apiDeps, sessions } = harness()
    const outcome = await createCompanionRun(
      SETTINGS,
      { actor: await actorFor("phone-1"), mode: "panel", text: "hi", idempotencyKey: "k3" },
      { apiDeps }
    )
    expect(outcome.ok).toBe(true)
    const opened = [...sessions.values()].find((session) => session.id.startsWith("opened-"))
    expect(opened?.origin).toEqual({
      kind: "gateway-api",
      keyId: "device:phone-1",
      keyName: "Max's phone",
    })
  })

  it("treats a scheduled run's conversation as the user's own, not a gateway key's", async () => {
    // Only a gateway origin fences a conversation to its key; the scheduled
    // origin names which task opened it and fences nothing.
    const { apiDeps, created } = harness()
    const outcome = await createCompanionRun(
      SETTINGS,
      {
        actor: await actorFor("phone-1"),
        mode: "cascade",
        text: "why did this fail?",
        sessionId: "scheduled-session",
        idempotencyKey: "companion-run:scheduled",
      },
      { apiDeps }
    )
    expect(outcome.ok).toBe(true)
    expect(created[0]).toMatchObject({ session: { id: "scheduled-session" } })
  })

  it("[ACC:AUTH-03] never writes into a gateway key's conversation", async () => {
    const { apiDeps, store } = harness()
    await expect(
      createCompanionRun(
        SETTINGS,
        {
          actor: await actorFor("phone-1"),
          mode: "cascade",
          text: "hi",
          sessionId: "key-session",
          idempotencyKey: "k4",
        },
        { apiDeps }
      )
    ).resolves.toMatchObject({ ok: false, error: { status: 404, code: "SESSION_NOT_FOUND" } })
    await expect(
      createCompanionRun(
        SETTINGS,
        {
          actor: await actorFor("phone-1"),
          mode: "cascade",
          text: "hi",
          sessionId: "nope",
          idempotencyKey: "k5",
        },
        { apiDeps }
      )
    ).resolves.toMatchObject({ ok: false, error: { code: "SESSION_NOT_FOUND" } })
    expect(await store.db.fusionRuns.count()).toBe(0)
  })

  it("refuses an empty message and personal data before anything is stored", async () => {
    const { apiDeps, store } = harness()
    const actor = await actorFor("phone-1")
    await expect(
      createCompanionRun(
        SETTINGS,
        { actor, mode: "cascade", text: "   ", idempotencyKey: "k6" },
        { apiDeps }
      )
    ).resolves.toMatchObject({ ok: false, error: { code: "SCHEMA_INVALID" } })
    piiClean.mockReturnValue(false)
    await expect(
      createCompanionRun(
        SETTINGS,
        { actor, mode: "cascade", text: "my card is 4111 1111 1111 1111", idempotencyKey: "k7" },
        { apiDeps }
      )
    ).resolves.toMatchObject({ ok: false, error: { status: 422, code: "PII_BLOCKED" } })
    expect(await store.db.fusionRuns.count()).toBe(0)
    expect(await store.db.fusionArtifacts.count()).toBe(0)
  })
})

describe("trimCompanionContext", () => {
  const turn = (role: "user" | "assistant", content: string) => ({ role, content })

  it("keeps the newest turns whole, within a token budget and a turn ceiling", () => {
    const history = Array.from({ length: 30 }, (_, index) =>
      turn(index % 2 === 0 ? "user" : "assistant", `turn ${index}`)
    )
    const kept = trimCompanionContext(history)
    expect(kept).toHaveLength(COMPANION_CONTEXT_MAX_TURNS)
    expect(kept.at(-1)).toEqual(history.at(-1))
    expect(kept[0]).toEqual(history[history.length - COMPANION_CONTEXT_MAX_TURNS])

    // A budget cut drops whole turns, oldest first, and is the same every time.
    const long = [
      turn("user", "a".repeat(4_000)),
      turn("assistant", "b".repeat(4_000)),
      turn("user", "now"),
    ]
    const budgeted = trimCompanionContext(long, 400)
    expect(budgeted).toEqual([turn("user", "now")])
    expect(trimCompanionContext(long, 400)).toEqual(budgeted)
    // The newest turn is kept even when it alone is over budget: a follow-up
    // without the thing it follows is worse than one over its context budget.
    expect(trimCompanionContext([turn("user", "x".repeat(40_000))], 10)).toHaveLength(1)
    expect(trimCompanionContext([], COMPANION_CONTEXT_TOKEN_BUDGET)).toEqual([])
  })
})

describe("a follow-up carries its conversation", () => {
  const history = [
    { role: "user" as const, content: "which database should we use?" },
    { role: "assistant" as const, content: "Postgres, for the joins." },
  ]

  it("puts the host's own recent turns in front of the new message, and appends that message once", async () => {
    const { apiDeps, created, transcripts, transcriptModes, store } = harness()
    transcripts.set("desktop-session", [...history])
    const outcome = await createCompanionRun(
      SETTINGS,
      {
        actor: await actorFor("phone-1"),
        mode: "cascade",
        text: "why not MySQL?",
        sessionId: "desktop-session",
        idempotencyKey: "follow-up-1",
      },
      { apiDeps }
    )
    if (!outcome.ok) throw new Error(outcome.error.code)
    expect(created[0].messages).toEqual([...history, { role: "user", content: "why not MySQL?" }])
    // The stored input is what a worker reads after a restart, so the context
    // is in it too.
    const run = await store.getRun(outcome.value.accepted.run_id)
    expect(
      decodeRunInput((await store.artifactStore(run!.runId).get(run!.inputArtifactId!))?.content)
        ?.messages
    ).toEqual([...history, { role: "user", content: "why not MySQL?" }])
    // The run writes only its answer, and the person's message is appended
    // here — once, with the id the transcript applier would have used.
    expect(transcriptModes).toEqual(["answer-only"])
    expect(committed).toEqual([
      {
        sessionId: "desktop-session",
        upserts: [
          {
            id: `rf-${outcome.value.accepted.run_id}-input-2`,
            role: "user",
            parts: [{ type: "text", text: "why not MySQL?" }],
            metadata: {
              triggerWorkflows: false,
              routerFusion: {
                runId: outcome.value.accepted.run_id,
                origin: "gateway-api",
                keyName: "Max's phone",
              },
            },
          },
        ],
      },
    ])
  })

  it("starts a new conversation with the one message, and lets the run write it", async () => {
    const { apiDeps, created, transcripts, transcriptModes } = harness()
    // Another conversation's turns are not this run's context.
    transcripts.set("desktop-session", [...history])
    const outcome = await createCompanionRun(
      SETTINGS,
      {
        actor: await actorFor("phone-1"),
        mode: "panel",
        text: "fresh question",
        idempotencyKey: "new-1",
      },
      { apiDeps }
    )
    expect(outcome.ok).toBe(true)
    expect(created[0].messages).toEqual([{ role: "user", content: "fresh question" }])
    expect(transcriptModes).toEqual(["input-and-answer"])
    expect(committed).toEqual([])
  })

  it("trims an oversized conversation deterministically and gates the whole of it for PII", async () => {
    const { apiDeps, created, transcripts } = harness()
    const long = Array.from({ length: 40 }, (_, index) => ({
      role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `${index}: ${"word ".repeat(200)}`,
    }))
    transcripts.set("desktop-session", long)
    const input = {
      actor: await actorFor("phone-1"),
      mode: "cascade" as const,
      text: "summarise that",
      sessionId: "desktop-session",
      idempotencyKey: "long-1",
    }
    await createCompanionRun(SETTINGS, input, { apiDeps })
    const sent = created[0].messages
    expect(sent.at(-1)).toEqual({ role: "user", content: "summarise that" })
    expect(sent).toEqual([
      ...trimCompanionContext(long),
      { role: "user", content: "summarise that" },
    ])
    expect(sent.length).toBeLessThan(long.length + 1)
    // Whole turns only — nothing is half-quoted.
    for (const message of sent.slice(0, -1)) expect(long).toContainEqual(message)
    // The transcript is what went through the gate, not only the new message.
    expect(piiClean).toHaveBeenCalled()

    piiClean.mockReturnValue(false)
    const second = harness()
    second.transcripts.set("desktop-session", long)
    await expect(
      createCompanionRun(
        SETTINGS,
        { ...input, idempotencyKey: "long-2" },
        { apiDeps: second.apiDeps }
      )
    ).resolves.toMatchObject({ ok: false, error: { code: "PII_BLOCKED" } })
    expect(second.created).toEqual([])
  })
})

describe("reading, resuming and controlling a companion run", () => {
  async function started() {
    const h = harness()
    const actor = await actorFor("phone-1")
    const outcome = await createCompanionRun(
      SETTINGS,
      { actor, mode: "cascade", text: "hi", sessionId: "desktop-session", idempotencyKey: "k8" },
      { apiDeps: h.apiDeps }
    )
    if (!outcome.ok) throw new Error(outcome.error.code)
    return { ...h, actor, runId: outcome.value.accepted.run_id }
  }

  it("[ACC:CACHE-05] shows a run to the device that created it, and to no other device", async () => {
    const { apiDeps, actor, runId } = await started()
    const read = await getCompanionRun(SETTINGS, { actor, runId }, { apiDeps })
    if (!read.ok) throw new Error(read.error.code)
    expect(RunSnapshotSchema.safeParse(read.value.snapshot).success).toBe(true)
    const other = await actorFor("tablet-9")
    await expect(
      getCompanionRun(SETTINGS, { actor: other, runId }, { apiDeps })
    ).resolves.toMatchObject({ ok: false, error: { status: 404, code: "RUN_NOT_FOUND" } })
    await expect(
      listCompanionRunEvents(SETTINGS, { actor: other, runId, afterSeq: 0 }, { apiDeps })
    ).resolves.toMatchObject({ ok: false, error: { code: "RUN_NOT_FOUND" } })
  })

  it("pages the run's events by seq", async () => {
    const { apiDeps, actor, runId } = await started()
    const all = await listCompanionRunEvents(SETTINGS, { actor, runId, afterSeq: 0 }, { apiDeps })
    if (!all.ok) throw new Error(all.error.code)
    expect(all.value.events.map((event) => event.seq)).toEqual(
      all.value.events.map((_, index) => index + 1)
    )
    const tail = await listCompanionRunEvents(
      SETTINGS,
      { actor, runId, afterSeq: 1, limit: 1 },
      { apiDeps }
    )
    if (!tail.ok) throw new Error(tail.error.code)
    expect(tail.value.events.map((event) => event.seq)).toEqual([2])
  })

  it("resumes through the Run API's own version check", async () => {
    const { apiDeps, actor, runId } = await started()
    await expect(
      resumeCompanionRun(
        SETTINGS,
        {
          actor,
          runId,
          body: {
            kind: "input",
            expected_run_version: 0,
            input_messages: [{ role: "user", content: "more" }],
          },
        },
        { apiDeps }
      )
    ).resolves.toMatchObject({ ok: false, error: { status: 409 } })
  })

  it("is recognised as a companion run, and stops through the Run API for its device only", async () => {
    const { apiDeps, actor, runId, store } = await started()
    await expect(isCompanionRun(SETTINGS, runId, { apiDeps })).resolves.toBe(true)
    await expect(isCompanionRun(SETTINGS, "not-a-run", { apiDeps })).resolves.toBe(false)

    const stranger = await controlCompanionRun(
      SETTINGS,
      {
        actor: await actorFor("tablet-9"),
        command: { runId, action: "stop", expectedRevision: 0 },
      },
      { apiDeps }
    )
    expect(stranger).toEqual({ accepted: false, reason: "run_not_found" })

    const unsupported = await controlCompanionRun(
      SETTINGS,
      { actor, command: { runId, action: "pause", expectedRevision: 0 } },
      { apiDeps }
    )
    expect(unsupported).toMatchObject({ accepted: false, reason: "unsupported_for_kind" })

    // No companion run waits for an approval in this build (delegate is B4):
    // the decision is refused by the Run API, never silently accepted.
    const approve = await controlCompanionRun(
      SETTINGS,
      {
        actor,
        command: {
          runId,
          action: "approve",
          expectedRevision: 0,
          interruptId: uuidFromName("approval"),
        },
      },
      { apiDeps }
    )
    expect(approve).toMatchObject({ accepted: false, code: "RUN_NOT_WAITING" })

    // A stale revision never blocks a stop.
    const stopped = await controlCompanionRun(
      SETTINGS,
      { actor, command: { runId, action: "stop", expectedRevision: 0 } },
      { apiDeps }
    )
    expect(stopped.accepted).toBe(true)
    expect((await store.getRun(runId))?.status).toBe("cancelled")
  })
})
