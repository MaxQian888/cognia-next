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
 *   (e) cross-account principals never execute under this runtime's account;
 *   (f) the signed-in owner, once they confirmed a principal as themselves,
 *       reaches the profile's other bots in the tenant without another code;
 *       the identity plane's word alone admits nobody, and a union id from a
 *       token-only webhook is not even recorded.
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
import { linkExternalIdentity } from "@/lib/db/identity"
import { CogniaAccountRegistryDB } from "@/lib/accounts/account-db"
import { UserBindingRegistry } from "@/lib/identity/user-binding"
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

function makeAdapter(id: string, transportModes: readonly string[] = ["stub"]): PlatformAdapter {
  return {
    id,
    meta: {
      type: "lark",
      displayName: `Bot ${id}`,
      version: "1.0.0",
      capabilities: [],
      transportModes,
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
  options: {
    openId?: string
    identityScope?: { tenantKey?: string; appId?: string; unionId?: string }
  } = {}
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

async function seedAdapter(
  settings: Record<string, unknown> = {},
  transportModes: readonly string[] = ["stub"]
): Promise<string> {
  const row = await createAdapterInstance({
    type: "lark",
    displayName: "Lark Bot",
    enabled: true,
    transportMode: "stub",
    settings,
    credentialsRef: { keyringService: "test", accounts: [] },
    trigger: AUTO_TRIGGER,
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
  })
  getBus().registerAdapter(makeAdapter(row.id, transportModes))
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
  await new CogniaAccountRegistryDB().delete()
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

  /** The owner signed in, and approved their principal in app `cli_0` as themselves. */
  async function ownerConfirmedElsewhere() {
    const accountId = getActiveRuntimeAccountId()
    await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: accountId })
    await new UserBindingRegistry().bind({
      localAccountId: accountId,
      userId: "usr_owner",
      logtoSubject: "sub_owner",
      logtoIssuer: "https://id.example/oidc",
    })
    await createFeishuPrincipal({
      tenantKey: "tk_a",
      appId: "cli_0",
      openId: "ou_owner_app0",
      unionId: "on_owner",
      cogniaAccountId: accountId,
      cogniaUserId: "usr_owner",
      ownerConfirmedAt: 1,
    })
  }

  async function ownerPrincipal() {
    return getDb()
      .feishuPrincipals.where("[tenantKey+appId+openId]")
      .equals(["tk_a", "cli_1", "ou_owner"])
      .first()
  }

  it("admits the confirmed owner on a long connection instead of handing them a code", async () => {
    const adapterId = await seedAdapter({ larkPrincipalRegistry: true }, ["gateway"])
    await ownerConfirmedElsewhere()
    const handled: NormalizedInboundEvent[] = []
    getBus().routeHandler = async (event) => {
      handled.push(event)
    }

    await getBus().dispatchInboundFull(
      larkEvent(adapterId, "om_owner", {
        openId: "ou_owner",
        identityScope: { ...SCOPE, unionId: "on_owner" },
      })
    )
    await flushTurns()

    expect(handled).toHaveLength(1)
    expect(await ownerPrincipal()).toMatchObject({
      cogniaUserId: "usr_owner",
      unionId: "on_owner",
      logtoSubject: "sub_owner",
      status: "active",
    })
    expect((await ownerPrincipal())?.selfBoundAt).toBeDefined()
    expect(await getDb().feishuPrincipalBindRequests.count()).toBe(0)
    const outbound = await getDb().outboundQueue.toArray()
    expect(outbound.some((row) => row.idempotencyKey?.startsWith("principal-unbound:"))).toBe(false)
  })

  it("re-admits a self-bound principal that a sign-out unlinked", async () => {
    const adapterId = await seedAdapter({ larkPrincipalRegistry: true }, ["gateway"])
    await ownerConfirmedElsewhere()
    getBus().routeHandler = async () => {}
    const send = (messageId: string) =>
      getBus().dispatchInboundFull(
        larkEvent(adapterId, messageId, {
          openId: "ou_owner",
          identityScope: { ...SCOPE, unionId: "on_owner" },
        })
      )

    await send("om_first")
    await flushTurns()
    const principal = await ownerPrincipal()
    await setFeishuPrincipalStatus(principal!.id, "unlinked")

    await send("om_back")
    await flushTurns()

    expect((await ownerPrincipal())?.status).toBe("active")
    const jobs = await jobRows()
    expect(jobs.every((job) => job.status !== "history_only")).toBe(true)
  })

  it("admits nobody on the identity plane's word alone", async () => {
    const adapterId = await seedAdapter({ larkPrincipalRegistry: true }, ["gateway"])
    const accountId = getActiveRuntimeAccountId()
    await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: accountId })
    await new UserBindingRegistry().bind({
      localAccountId: accountId,
      userId: "usr_owner",
      logtoSubject: "sub_owner",
      logtoIssuer: "https://id.example/oidc",
    })
    // The sign-in filed this union id on the owner, but no principal was ever
    // confirmed as them.
    await linkExternalIdentity({
      userId: "usr_owner",
      provider: "lark",
      subject: "on_owner",
      tenant: "tk_a",
    })
    getBus().routeHandler = async () => {}

    await getBus().dispatchInboundFull(
      larkEvent(adapterId, "om_claimed", {
        openId: "ou_owner",
        identityScope: { ...SCOPE, unionId: "on_owner" },
      })
    )
    await flushTurns()

    const [job] = await jobRows()
    expect(job.recoveryReason).toBe("principal_unbound")
    expect(await ownerPrincipal()).toBeUndefined()
    // The request records the union id so the approver can see it is theirs.
    const [request] = await getDb().feishuPrincipalBindRequests.toArray()
    expect(request.unionId).toBe("on_owner")
  })

  it("does not believe a union id from a token-only webhook", async () => {
    const adapterId = await seedAdapter({ larkPrincipalRegistry: true }, ["webhook"])
    await ownerConfirmedElsewhere()
    getBus().routeHandler = async () => {}

    await getBus().dispatchInboundFull(
      larkEvent(adapterId, "om_forged", {
        openId: "ou_attacker",
        identityScope: { ...SCOPE, unionId: "on_owner" },
      })
    )
    await flushTurns()

    const [job] = await jobRows()
    expect(job.recoveryReason).toBe("principal_unbound")
    const [request] = await getDb().feishuPrincipalBindRequests.toArray()
    expect(request.unionId).toBeUndefined()
    expect(
      await getDb()
        .feishuPrincipals.where("[tenantKey+appId+openId]")
        .equals(["tk_a", "cli_1", "ou_attacker"])
        .first()
    ).toBeUndefined()
  })
})
