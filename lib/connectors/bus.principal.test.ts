/** @jest-environment jsdom */
/**
 * Integration tests for inbound Step 2.5 — principal resolution
 * (plan 2026-07-24 Phase 1).
 *
 * Properties pinned here:
 *   (a) flag off → byte-identical legacy behavior, no registry gating;
 *   (b) flag on + registered sender → route handler runs, the durable job
 *       carries accountId/principalId, and the event is stamped for
 *       initiator attribution;
 *   (c) flag on + unregistered sender → FAIL CLOSED: no route handler, job
 *       parked history_only, audit + one bind-code reply;
 *   (d) a principal disabled after its first turn is rejected on the next
 *       event (the same resolution step recovery replays re-enter);
 *   (e) cross-account principals never execute under this runtime's account.
 */

import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { createAdapterInstance } from "@/lib/db/adapter-instances"
import { listRecent } from "@/lib/db/connector-audit"
import {
  createFeishuPrincipal,
  setFeishuPrincipalStatus,
  upsertFeishuTenant,
} from "@/lib/db/feishu-principals"
import { getActiveRuntimeAccountId } from "./principal/resolve"
import { getBus, __resetBusForTesting } from "./bus"
import { __resetPruneCounterForTesting } from "./dedup"
import type { NormalizedInboundEvent, PlatformAdapter } from "@/types/connectors"
import type { TriggerPolicy } from "@/types/connectors/policy"

const AUTO_TRIGGER: TriggerPolicy = {
  rules: [{ kind: "private-default" }, { kind: "self-mention" }],
  blockers: [],
  storeUnmatchedInDraftMode: false,
}

function makeAdapter(id: string): PlatformAdapter {
  return {
    id,
    meta: {
      type: "lark",
      displayName: `Bot ${id}`,
      version: "1.0.0",
      capabilities: [],
      transportModes: ["stub"],
      configSchema: {},
    },
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    health: jest.fn().mockReturnValue({ state: "running" }),
    send: jest.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter
}

function larkEvent(
  adapterId: string,
  messageId: string,
  options: { openId?: string; identityScope?: { tenantKey?: string; appId?: string } } = {}
): NormalizedInboundEvent {
  const openId = options.openId ?? "ou_alice"
  return {
    platform: "lark",
    adapterId,
    selfId: "ou_bot",
    messageId,
    conversationRef: { platform: "lark", adapterId, channelId: "oc_1" },
    conversationKey: `lark:${adapterId}:oc_1`,
    sender: { id: `lark:${openId}`, platform: "lark", adapterId, remoteUserId: openId },
    channel: { id: `lark:${adapterId}:oc_1`, kind: "private" },
    segments: [{ type: "text", text: "hello" }],
    plainText: "hello",
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: {},
    ...(options.identityScope ? { channelData: { identityScope: options.identityScope } } : {}),
  }
}

async function seedAdapter(settings: Record<string, unknown> = {}): Promise<string> {
  const row = await createAdapterInstance({
    type: "lark",
    displayName: "Lark Bot",
    enabled: true,
    transportMode: "stub",
    settings,
    credentialsRef: { keyringService: "test", accounts: [] },
    trigger: AUTO_TRIGGER,
    defaultMode: "auto",
  })
  getBus().registerAdapter(makeAdapter(row.id))
  return row.id
}

const SCOPE = { tenantKey: "tk_a", appId: "cli_1" }

async function seedRegistry(openId = "ou_alice", accountId = getActiveRuntimeAccountId()) {
  await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: accountId })
  return createFeishuPrincipal({
    tenantKey: "tk_a",
    appId: "cli_1",
    openId,
    cogniaAccountId: accountId,
    cogniaUserId: accountId,
  })
}

async function flushTurns(): Promise<void> {
  // Route-handler turns run detached from dispatchInboundFull — drain them.
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function jobRows() {
  return getDb().connectorInboundJobs.toArray()
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  __resetBusForTesting()
  __resetPruneCounterForTesting()
}, 30_000)

describe("bus inbound Step 2.5 — principal resolution", () => {
  it("flag off: dispatches without touching the registry", async () => {
    const adapterId = await seedAdapter({ larkPrincipalRegistry: false })
    const handled: NormalizedInboundEvent[] = []
    getBus().routeHandler = async (event) => {
      handled.push(event)
    }

    await getBus().dispatchInboundFull(larkEvent(adapterId, "om_legacy", { identityScope: SCOPE }))
    await flushTurns()

    expect(handled).toHaveLength(1)
    const [job] = await jobRows()
    expect(job.accountId).toBeUndefined()
    expect(job.principalId).toBeUndefined()
  })

  it("flag on + registered sender: handler runs, job and event carry the principal stamp", async () => {
    const adapterId = await seedAdapter({ larkPrincipalRegistry: true })
    const principal = await seedRegistry()
    const handled: NormalizedInboundEvent[] = []
    getBus().routeHandler = async (event) => {
      handled.push(event)
    }

    await getBus().dispatchInboundFull(larkEvent(adapterId, "om_ok", { identityScope: SCOPE }))
    await flushTurns()

    expect(handled).toHaveLength(1)
    expect(handled[0].channelData?.resolvedPrincipal).toEqual({
      principalId: principal.id,
      accountId: getActiveRuntimeAccountId(),
    })
    const [job] = await jobRows()
    expect(job.principalId).toBe(principal.id)
    expect(job.accountId).toBe(getActiveRuntimeAccountId())
  })

  it("flag on + unregistered sender: fail closed with audit and one bind-code reply", async () => {
    const adapterId = await seedAdapter({ larkPrincipalRegistry: true })
    const handled: NormalizedInboundEvent[] = []
    getBus().routeHandler = async (event) => {
      handled.push(event)
    }

    await getBus().dispatchInboundFull(larkEvent(adapterId, "om_unbound", { identityScope: SCOPE }))
    await flushTurns()

    expect(handled).toHaveLength(0)
    const [job] = await jobRows()
    expect(job.status).toBe("history_only")
    expect(job.recoveryReason).toBe("principal_unbound")

    const audits = await listRecent(adapterId, 20)
    expect(audits.some((row) => row.kind === "principal.unbound")).toBe(true)
    // The raw open_id must never land in the audit trail.
    expect(JSON.stringify(audits)).not.toContain("ou_alice")

    const outbound = await getDb().outboundQueue.toArray()
    expect(outbound).toHaveLength(1)
    expect(JSON.stringify(outbound[0].request.segments)).toContain("fb_")

    const bindRequests = await getDb().feishuPrincipalBindRequests.toArray()
    expect(bindRequests).toHaveLength(1)
  })

  it("missing tenantKey with flag on is unbound — never guessed from whoami", async () => {
    const adapterId = await seedAdapter({ larkPrincipalRegistry: true })
    await seedRegistry()
    const handled: NormalizedInboundEvent[] = []
    getBus().routeHandler = async (event) => {
      handled.push(event)
    }

    await getBus().dispatchInboundFull(larkEvent(adapterId, "om_noscope"))
    await flushTurns()

    expect(handled).toHaveLength(0)
    const [job] = await jobRows()
    expect(job.status).toBe("history_only")
  })

  it("a principal disabled after its first turn is rejected on the next event", async () => {
    const adapterId = await seedAdapter({ larkPrincipalRegistry: true })
    const principal = await seedRegistry()
    const handled: string[] = []
    getBus().routeHandler = async (event) => {
      handled.push(event.messageId)
    }

    await getBus().dispatchInboundFull(larkEvent(adapterId, "om_first", { identityScope: SCOPE }))
    await flushTurns()
    expect(handled).toEqual(["om_first"])

    await setFeishuPrincipalStatus(principal.id, "disabled")
    await getBus().dispatchInboundFull(larkEvent(adapterId, "om_second", { identityScope: SCOPE }))
    await flushTurns()

    expect(handled).toEqual(["om_first"])
    const jobs = await jobRows()
    const second = jobs.find((row) => row.sourceMessageId === "om_second")
    expect(second?.status).toBe("history_only")
    expect(second?.recoveryReason).toBe("principal_principal_disabled")
    // Disabled senders get no self-service bind reply (the welcome card from
    // the first legitimate turn is unrelated and may exist).
    const outbound = await getDb().outboundQueue.toArray()
    expect(outbound.some((row) => row.idempotencyKey?.startsWith("principal-unbound:"))).toBe(false)
  })

  it("cross-account principals are rejected, never executed under the local account", async () => {
    const adapterId = await seedAdapter({ larkPrincipalRegistry: true })
    await seedRegistry("ou_alice", "acct_someone_else")
    const handled: string[] = []
    getBus().routeHandler = async (event) => {
      handled.push(event.messageId)
    }

    await getBus().dispatchInboundFull(larkEvent(adapterId, "om_cross", { identityScope: SCOPE }))
    await flushTurns()

    expect(handled).toHaveLength(0)
    const [job] = await jobRows()
    expect(job.status).toBe("history_only")
    expect(job.recoveryReason).toBe("principal_cross_account")
    const audits = await listRecent(adapterId, 20)
    const rejected = audits.find((row) => row.kind === "principal.rejected")
    expect(rejected?.fields?.declaredAccountId).toBe("acct_someone_else")
  })
})
