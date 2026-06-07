// Coverage for the schema module — Dexie instance lifecycle, lazy seeding,
// and the test reset helper. Also exercises the v5 (members[]) and v7
// (appsEnabled={}) upgrade hooks indirectly: the seeder runs against a
// freshly opened DB, which means the latest schema version opens cleanly.

import "fake-indexeddb/auto"
import { CogniaDB, __resetDbForTesting, getDb, whenSeeded } from "./schema"
import type { OutboundJobRow } from "./connector-types"

/** Minimal valid `outboundQueue` row for index-behaviour tests. */
function makeOutboundRow(
  id: string,
  over: Partial<OutboundJobRow> & Pick<OutboundJobRow, "status" | "nextAttemptAt">
): OutboundJobRow {
  return {
    id,
    adapterId: "tg-v51",
    conversationKey: "telegram:tg-v51:1",
    request: {
      conversationRef: { platform: "telegram", adapterId: "tg-v51" },
      segments: [{ type: "text", text: "hi" }],
      metadata: { idempotencyKey: id },
    },
    attempts: 0,
    createdAt: Date.now(),
    idempotencyKey: id,
    source: "ai-run",
    ...over,
  }
}

describe("getDb", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("returns a CogniaDB instance with every advertised table wired", () => {
    const db = getDb()
    expect(db).toBeInstanceOf(CogniaDB)
    expect(db.sessions).toBeDefined()
    expect(db.messages).toBeDefined()
    expect(db.settings).toBeDefined()
    expect(db.promptPresets).toBeDefined()
    expect(db.mcpServers).toBeDefined()
    expect(db.characters).toBeDefined()
    expect(db.skills).toBeDefined()
    expect(db.skillResources).toBeDefined()
    expect(db.teams).toBeDefined()
    expect(db.trustedWorkspaces).toBeDefined()
    expect(db.backupHistory).toBeDefined()
    expect(db.notifications).toBeDefined()
    expect(db.canvasDocuments).toBeDefined()
    expect(db.canvasVersions).toBeDefined()
    expect(db.canvasComments).toBeDefined()
    expect(db.canvasSessions).toBeDefined()
    expect(db.sessionState).toBeDefined()
    expect(db.tts_provider_keys).toBeDefined()
    // §A-Schema (v15) — the five plugin tables added by the plugin port.
    expect(db.plugins).toBeDefined()
    expect(db.pluginPermissions).toBeDefined()
    expect(db.pluginReviews).toBeDefined()
    expect(db.pluginAnalytics).toBeDefined()
    expect(db.pluginScheduledJobs).toBeDefined()
    // v17 — External Bridge (LLM Wiki + MCP audit) tables.
    expect(db.wikiArticles).toBeDefined()
    expect(db.wikiSections).toBeDefined()
    expect(db.wikiManifest).toBeDefined()
    expect(db.mcpAuditLog).toBeDefined()
    // v18 — Platform Connectors tables.
    expect(db.adapterInstances).toBeDefined()
    expect(db.platformIdentities).toBeDefined()
    expect(db.inboundLedger).toBeDefined()
    expect(db.outboundQueue).toBeDefined()
    expect(db.conversationOverrides).toBeDefined()
    expect(db.connectorAudit).toBeDefined()
    expect(db.connectorDrafts).toBeDefined()
    expect(db.connectorAttachments).toBeDefined()
    // v51 — Heartbeats split out of connectorAudit into their own table.
    expect(db.connectorHeartbeats).toBeDefined()
    // v27 — Plugin Dexie table registry (M0 platform feature).
    expect(db.pluginDexieMeta).toBeDefined()
    // v49 — Inbox telemetry ring buffer.
    expect(db.inboxTelemetryEvents).toBeDefined()
  })

  // v49 — Inbox optimization pass: messages.platformMessageId index + new
  // telemetry table. Verify the messages table accepts a row with the
  // denormalized field and the index resolves it; the telemetry table
  // accepts inserts via its primary key.
  it("v49 messages.platformMessageId index + inboxTelemetryEvents round-trip", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(49)
    const now = Date.now()

    // Messages row carries the new denormalized field + matching metadata.
    await db.messages.put({
      id: "m-v49",
      sessionId: "s-v49",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
      platformMessageId: "tg:msg-42",
      metadata: {
        platformMessage: {
          messageId: "tg:msg-42",
          platform: "telegram",
          sender: {
            id: "u-alice",
            platform: "telegram",
            adapterId: "tg-1",
            remoteUserId: "999",
            displayName: "Alice",
          },
        },
      },
      createdAt: now,
    })
    const byIndex = await db.messages.where("platformMessageId").equals("tg:msg-42").toArray()
    expect(byIndex).toHaveLength(1)
    expect(byIndex[0].id).toBe("m-v49")

    // Rows without platformMessageId still index-skip cleanly.
    await db.messages.put({
      id: "m-v49-no-pm",
      sessionId: "s-v49",
      role: "assistant",
      parts: [{ type: "text", text: "reply" }],
      createdAt: now,
    })
    expect(await db.messages.where("platformMessageId").equals("tg:msg-42").count()).toBe(1)

    // Telemetry table inserts via primary key + lists newest-first via the
    // `at` index.
    await db.inboxTelemetryEvents.bulkPut([
      { id: "te-1", kind: "inbound.received", at: 100, adapterId: "tg-1" },
      { id: "te-2", kind: "outbound.sent", at: 200, adapterId: "tg-1" },
      { id: "te-3", kind: "breaker.open", at: 300, adapterId: "tg-1" },
    ])
    const newest = await db.inboxTelemetryEvents.orderBy("at").reverse().limit(2).toArray()
    expect(newest.map((r) => r.id)).toEqual(["te-3", "te-2"])
  })

  // v49 upgrade hook backfills platformMessageId from
  // metadata.platformMessage.messageId on pre-existing rows.
  it("v49 upgrade hook backfills platformMessageId on legacy messages", async () => {
    const Dexie = (await import("dexie")).default
    const legacy = new Dexie("cognia-claude")
    // Open at v48 — last pre-bump version that already had senderId column.
    legacy.version(48).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
    })
    await legacy.open()
    await legacy.table("messages").put({
      id: "m-legacy",
      sessionId: "s-legacy",
      role: "user",
      parts: [{ type: "text", text: "old" }],
      metadata: {
        platformMessage: {
          messageId: "discord:msg-7",
          platform: "discord",
          sender: { remoteUserId: "u7", displayName: "Bob" },
        },
      },
      createdAt: 0,
    })
    // Row that never went through a connector — no platformMessage metadata.
    await legacy.table("messages").put({
      id: "m-legacy-direct",
      sessionId: "s-legacy",
      role: "assistant",
      parts: [{ type: "text", text: "direct" }],
      createdAt: 0,
    })
    legacy.close()

    // Re-open through production schema — v49 upgrade hook fires.
    const db = getDb()
    await db.open()
    const backfilled = await db.messages.get("m-legacy")
    expect(backfilled?.platformMessageId).toBe("discord:msg-7")
    const direct = await db.messages.get("m-legacy-direct")
    expect(direct?.platformMessageId).toBeUndefined()

    // The new index can locate the backfilled row.
    const byIndex = await db.messages.where("platformMessageId").equals("discord:msg-7").first()
    expect(byIndex?.id).toBe("m-legacy")
  })

  // v50 — Built-in characters → first-party character pack (ADR-0030
  // Amendment). The legacy `char_builtin_*` Dexie rows must pick up
  // `sourcePluginId`, `sourcePackId`, `clonedFromPackCharacterId`, and
  // `packVersionAtClone` so the new clone-hides-overlay dedupe rule
  // treats them as user clones of the overlay. User customisations
  // (e.g. a tampered systemPrompt) must survive verbatim.
  it("v50 upgrade hook tags legacy built-in character rows with overlay attribution", async () => {
    const Dexie = (await import("dexie")).default
    const legacy = new Dexie("cognia-claude")
    legacy.version(48).stores({
      characters: "id, name, updatedAt, isBuiltIn",
    })
    await legacy.open()
    await legacy.table("characters").bulkPut([
      {
        id: "char_builtin_coding",
        name: "Coding Assistant",
        avatarColor: "x",
        systemPrompt: "USER TAMPERED",
        isBuiltIn: true,
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: "char_builtin_writer",
        name: "Writing Editor",
        avatarColor: "x",
        systemPrompt: "y",
        isBuiltIn: true,
        createdAt: 0,
        updatedAt: 0,
      },
      // A user-created character — must not be tagged.
      {
        id: "char_user_demo",
        name: "User",
        avatarColor: "x",
        systemPrompt: "z",
        createdAt: 0,
        updatedAt: 0,
      },
    ])
    legacy.close()

    const db = getDb()
    await db.open()
    const coding = await db.characters.get("char_builtin_coding")
    expect(coding?.sourcePluginId).toBe("cognia-builtin-characters")
    expect(coding?.sourcePackId).toBe("builtin")
    expect(coding?.clonedFromPackCharacterId).toBe(
      "cognia-pack:cognia-builtin-characters:builtin:coding"
    )
    expect(coding?.packVersionAtClone).toBe("1.0.0")
    // The systemPrompt the user had tampered with must not be touched by
    // the upgrade hook itself — the seeder may re-stamp on next open, but
    // the upgrade hook's job is attribution-only.
    expect(coding?.systemPrompt).toBe("USER TAMPERED")

    const writer = await db.characters.get("char_builtin_writer")
    expect(writer?.clonedFromPackCharacterId).toBe(
      "cognia-pack:cognia-builtin-characters:builtin:writer"
    )

    // Non-builtin rows are left strictly alone.
    const user = await db.characters.get("char_user_demo")
    expect(user?.sourcePluginId).toBeUndefined()
    expect(user?.clonedFromPackCharacterId).toBeUndefined()
  })

  it("v50 upgrade hook is idempotent — rows already tagged are not re-tagged", async () => {
    const Dexie = (await import("dexie")).default
    const legacy = new Dexie("cognia-claude")
    legacy.version(48).stores({
      characters: "id, name, updatedAt, isBuiltIn",
    })
    await legacy.open()
    // Already-tagged row (simulates a previous v50 run + manual edit).
    await legacy.table("characters").put({
      id: "char_builtin_coding",
      name: "Coding Assistant",
      avatarColor: "x",
      systemPrompt: "y",
      isBuiltIn: true,
      sourcePluginId: "third-party-imposter",
      sourcePackId: "evil",
      clonedFromPackCharacterId: "cognia-pack:third-party-imposter:evil:coding",
      packVersionAtClone: "9.9.9",
      createdAt: 0,
      updatedAt: 0,
    })
    legacy.close()

    const db = getDb()
    await db.open()
    const coding = await db.characters.get("char_builtin_coding")
    // The pre-existing attribution must survive verbatim — the upgrade
    // hook's `if (row.sourcePluginId) return` clause protects rows that
    // were already attributed (whether by this hook or a manual edit).
    expect(coding?.sourcePluginId).toBe("third-party-imposter")
    expect(coding?.packVersionAtClone).toBe("9.9.9")
  })

  // v78 — Skills installed from the defunct SkillsMP marketplace lose their
  // provenance fields (canonicalId / marketplaceSkillId) and survive as
  // plain local skills; everything else is untouched.
  it("v78 upgrade hook detaches skillsmp:* installs and leaves others alone", async () => {
    const Dexie = (await import("dexie")).default
    const legacy = new Dexie("cognia-claude")
    legacy.version(77).stores({
      skills: "&id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
    })
    await legacy.open()
    await legacy.table("skills").bulkPut([
      {
        id: "skill-mp",
        name: "Old SkillsMP install",
        content: "x",
        source: "marketplace",
        canonicalId: "skillsmp:42",
        marketplaceSkillId: "42",
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: "skill-registry",
        name: "Registry install",
        content: "y",
        source: "marketplace",
        canonicalId: "registry:ai-elements",
        marketplaceSkillId: "ai-elements",
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: "skill-local",
        name: "Local skill",
        content: "z",
        source: "custom",
        createdAt: 0,
        updatedAt: 0,
      },
    ])
    legacy.close()

    const db = getDb()
    await db.open()
    const detached = await db.skills.get("skill-mp")
    expect(detached?.canonicalId).toBeUndefined()
    expect(detached?.marketplaceSkillId).toBeUndefined()
    expect(detached?.name).toBe("Old SkillsMP install")
    // Registry installs and plain local skills survive verbatim.
    const registry = await db.skills.get("skill-registry")
    expect(registry?.canonicalId).toBe("registry:ai-elements")
    expect(registry?.marketplaceSkillId).toBe("ai-elements")
    const local = await db.skills.get("skill-local")
    expect(local?.canonicalId).toBeUndefined()
  })

  it("opens at schema v41 (IM connector complete gap closure)", async () => {
    const db = getDb()
    await db.open()
    // Dexie's `verno` reflects the highest version block registered.
    expect(db.verno).toBeGreaterThanOrEqual(41)
  })

  // v45 — IM connector Lark-first completeness pass. All changes are
  // additive optional columns on `adapterInstances`; verify they
  // round-trip through the declared row type and that pre-v45 rows
  // (without the fields) still read fine.
  it("v45 Lark guardrail fields round-trip on adapterInstances", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(45)
    const now = Date.now()

    // A Lark adapter row carrying every v45 field.
    await db.adapterInstances.put({
      id: "lark-v45",
      type: "lark",
      displayName: "Lark Workspace",
      enabled: true,
      transportMode: "webhook",
      settings: {},
      credentialsRef: {
        keyringService: "com.cognia.platforms",
        accounts: ["lark-v45:appSecret", "lark-v45:verificationToken"],
      },
      trigger: {
        rules: [{ kind: "private-default" }],
        blockers: [],
        storeUnmatchedInDraftMode: false,
      },
      defaultMode: "auto",
      atResponseStrategy: "mention_only",
      chatAllowlist: ["oc_team_eng", "oc_team_pm"],
      chatBlocklist: ["oc_spam_chat"],
      lastWhoamiAt: now,
      lastWhoamiResult: {
        botName: "Cognia Bot",
        botAvatar: "https://avatars.feishu.cn/abc.png",
        appId: "cli_v45",
        openId: "ou_bot_open_id",
        tenantKey: "tnt_v45",
        scopes: ["im:message", "bot:info", "im:resource"],
        activateStatus: 2,
      },
      userTokenStoredAt: now - 60_000,
      createdAt: now,
      updatedAt: now,
    })
    const row = await db.adapterInstances.get("lark-v45")
    expect(row?.atResponseStrategy).toBe("mention_only")
    expect(row?.chatAllowlist).toEqual(["oc_team_eng", "oc_team_pm"])
    expect(row?.chatBlocklist).toEqual(["oc_spam_chat"])
    expect(row?.lastWhoamiAt).toBe(now)
    expect(row?.lastWhoamiResult?.botName).toBe("Cognia Bot")
    expect(row?.lastWhoamiResult?.tenantKey).toBe("tnt_v45")
    expect(row?.lastWhoamiResult?.scopes).toContain("bot:info")
    expect(row?.userTokenStoredAt).toBe(now - 60_000)

    // Pre-v45 row (no new fields) still reads back fine — every new
    // column is optional, so absence is the same as "not configured".
    await db.adapterInstances.put({
      id: "lark-pre-v45",
      type: "lark",
      displayName: "Pre-v45 row",
      enabled: false,
      transportMode: "webhook",
      settings: {},
      credentialsRef: { keyringService: "com.cognia.platforms", accounts: [] },
      trigger: {
        rules: [{ kind: "private-default" }],
        blockers: [],
        storeUnmatchedInDraftMode: false,
      },
      defaultMode: "manual",
      createdAt: now,
      updatedAt: now,
    })
    const legacy = await db.adapterInstances.get("lark-pre-v45")
    expect(legacy?.atResponseStrategy).toBeUndefined()
    expect(legacy?.chatAllowlist).toBeUndefined()
    expect(legacy?.chatBlocklist).toBeUndefined()
    expect(legacy?.lastWhoamiAt).toBeUndefined()
    expect(legacy?.lastWhoamiResult).toBeUndefined()
    expect(legacy?.userTokenStoredAt).toBeUndefined()
  })

  // v45 — `adapter.heartbeat` AuditKind is accepted by the
  // `connectorAudit` table writer and the index can filter it out.
  it("v45 adapter.heartbeat audit rows round-trip and are filterable by kind", async () => {
    const db = getDb()
    await db.open()
    const now = Date.now()

    await db.connectorAudit.bulkPut([
      { id: "h-1", adapterId: "lark-v45", kind: "adapter.heartbeat", at: now - 60_000 },
      { id: "h-2", adapterId: "lark-v45", kind: "adapter.heartbeat", at: now - 30_000 },
      { id: "h-3", adapterId: "lark-v45", kind: "adapter.started", at: now - 90_000 },
    ])

    const heartbeats = await db.connectorAudit.where("kind").equals("adapter.heartbeat").toArray()
    expect(heartbeats).toHaveLength(2)
    expect(heartbeats.every((r) => r.adapterId === "lark-v45")).toBe(true)

    const nonHeartbeat = await db.connectorAudit.where("kind").equals("adapter.started").toArray()
    expect(nonHeartbeat).toHaveLength(1)
    expect(nonHeartbeat[0].kind).toBe("adapter.started")
  })

  // v51 — the new compound indexes and the dedicated heartbeat table.
  it("v51 outboundQueue [status+nextAttemptAt] index drives a due-job range query", async () => {
    const db = getDb()
    await db.open()
    const now = Date.now()
    await db.outboundQueue.bulkPut([
      makeOutboundRow("due-pending", { status: "pending", nextAttemptAt: now - 1_000 }),
      makeOutboundRow("future-pending", { status: "pending", nextAttemptAt: now + 60_000 }),
      makeOutboundRow("due-failed", { status: "failed", nextAttemptAt: now - 500 }),
      makeOutboundRow("sent", { status: "sent", nextAttemptAt: now - 5_000 }),
    ])

    const duePending = await db.outboundQueue
      .where("[status+nextAttemptAt]")
      .between(["pending", -Infinity], ["pending", now])
      .toArray()
    expect(duePending.map((r) => r.id)).toEqual(["due-pending"])

    const dueFailed = await db.outboundQueue
      .where("[status+nextAttemptAt]")
      .between(["failed", -Infinity], ["failed", now])
      .toArray()
    expect(dueFailed.map((r) => r.id)).toEqual(["due-failed"])
  })

  it("v51 connectorAudit [adapterId+kind+at] index isolates one adapter+kind stream", async () => {
    const db = getDb()
    await db.open()
    const now = Date.now()
    await db.connectorAudit.bulkPut([
      { id: "i-1", adapterId: "lark-v51", kind: "inbound.received", at: now - 10_000 },
      { id: "i-2", adapterId: "lark-v51", kind: "inbound.received", at: now - 5_000 },
      { id: "i-3", adapterId: "lark-v51", kind: "delivery.success", at: now - 1_000 },
      { id: "i-4", adapterId: "other-v51", kind: "inbound.received", at: now - 2_000 },
    ])

    const lastInbound = await db.connectorAudit
      .where("[adapterId+kind+at]")
      .between(
        ["lark-v51", "inbound.received", -Infinity],
        ["lark-v51", "inbound.received", Infinity]
      )
      .last()
    expect(lastInbound?.id).toBe("i-2")
  })

  it("v51 connectorHeartbeats round-trips and prunes by [adapterId+at]", async () => {
    const db = getDb()
    await db.open()
    const now = Date.now()
    await db.connectorHeartbeats.bulkPut([
      { id: "hb-1", adapterId: "lark-v51", kind: "adapter.heartbeat", at: now - 90_000 },
      { id: "hb-2", adapterId: "lark-v51", kind: "adapter.heartbeat", at: now - 1_000 },
      { id: "hb-3", adapterId: "other-v51", kind: "adapter.heartbeat", at: now - 90_000 },
    ])

    await db.connectorHeartbeats
      .where("[adapterId+at]")
      .between(["lark-v51", -Infinity], ["lark-v51", now - 60_000])
      .delete()

    const remaining = await db.connectorHeartbeats.toArray()
    expect(remaining.map((r) => r.id).sort()).toEqual(["hb-2", "hb-3"])
  })

  // v43 — Built-in skills tier + lark-cli bridge (ADR-0026). All changes
  // are additive optional columns; verify they round-trip through the
  // declared row types and that the `kind` widening accepts the new
  // `"skill_invoke"` discriminator.
  it("v43 built-in-skill fields round-trip on the affected tables", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(43)
    const now = Date.now()

    // connectorCallbackBindings: new `"skill_invoke"` kind + payload.
    await db.connectorCallbackBindings.put({
      id: "lark-1:skinv-42",
      adapterId: "lark-1",
      actionId: "skinv-42",
      kind: "skill_invoke",
      surfaceId: "sfc_confirm",
      componentId: "btn_yes",
      conversationKey: "lark:lark-1:oc_x",
      createdAt: now,
      expiresAt: now + 7 * 24 * 3600 * 1000,
      payload: {
        skillId: "lark.calendar.create_event",
        args: { title: "Q4 review", start: "2026-06-01T15:00:00", end: "2026-06-01T16:00:00" },
      },
    })
    const bindings = await db.connectorCallbackBindings
      .where("kind")
      .equals("skill_invoke")
      .toArray()
    expect(bindings).toHaveLength(1)
    expect(bindings[0].payload?.skillId).toBe("lark.calendar.create_event")

    // conversationOverrides: per-channel built-in skill gating.
    await db.conversationOverrides.put({
      id: "co-v43-1",
      conversationKey: "lark:lark-1:oc_y",
      sessionId: "s_v43_1",
      allowedBuiltInSkillIds: ["lark.calendar.list_events", "lark.doc.search"],
      requireHitlForWrites: false,
      createdAt: now,
      updatedAt: now,
    })
    const co = await db.conversationOverrides.get("co-v43-1")
    expect(co?.allowedBuiltInSkillIds).toEqual(["lark.calendar.list_events", "lark.doc.search"])
    expect(co?.requireHitlForWrites).toBe(false)

    // conversationOverrides: "all" sentinel survives the put/get round-trip.
    await db.conversationOverrides.put({
      id: "co-v43-2",
      conversationKey: "lark:lark-1:oc_z",
      sessionId: "s_v43_2",
      allowedBuiltInSkillIds: "all",
      createdAt: now,
      updatedAt: now,
    })
    expect((await db.conversationOverrides.get("co-v43-2"))?.allowedBuiltInSkillIds).toBe("all")

    // adapterInstances: lastKnownSkillCapabilities cache column.
    await db.adapterInstances.put({
      id: "lark-1",
      type: "lark",
      displayName: "Lark Workspace",
      enabled: true,
      transportMode: "webhook",
      settings: {},
      credentialsRef: {
        keyringService: "com.cognia.platforms",
        accounts: ["lark-1:appSecret"],
      },
      trigger: {
        rules: [{ kind: "private-default" }],
        blockers: [],
        storeUnmatchedInDraftMode: false,
      },
      defaultMode: "auto",
      lastKnownSkillCapabilities: [
        { family: "lark.calendar", mutations: ["read", "write"] },
        { family: "lark.doc", mutations: ["read", "write", "destructive"] },
        { family: "lark.task", mutations: ["read", "write"] },
      ],
      createdAt: now,
      updatedAt: now,
    })
    const adapter = await db.adapterInstances.get("lark-1")
    expect(adapter?.lastKnownSkillCapabilities).toHaveLength(3)
    expect(adapter?.lastKnownSkillCapabilities?.[0].family).toBe("lark.calendar")
    expect(adapter?.lastKnownSkillCapabilities?.[1].mutations).toContain("destructive")
  })

  // v41 — IM connector complete gap closure (ADR-0009 v41,
  // im-a2ui-warm-eclipse plan). Round-trip the five additive fields so a
  // future contributor can't accidentally trim them in a downstream type
  // refactor.
  it("v41 connector + automation fields round-trip and indexes accept inserts", async () => {
    const db = getDb()
    const now = Date.now()

    // connectorCallbackBindings: new `kind` column + index.
    await db.connectorCallbackBindings.put({
      id: "tg-1:msg-42",
      adapterId: "tg-1",
      actionId: "msg-42",
      kind: "force_reply",
      surfaceId: "sfc_form",
      componentId: "txt_name",
      conversationKey: "telegram:tg-1:1",
      createdAt: now,
    })
    const bindings = await db.connectorCallbackBindings
      .where("kind")
      .equals("force_reply")
      .toArray()
    expect(bindings).toHaveLength(1)
    expect(bindings[0].kind).toBe("force_reply")

    // adapterInstances: new `implMetadata` column.
    await db.adapterInstances.put({
      id: "ob-1",
      type: "onebot",
      displayName: "QQ via NapCat",
      enabled: true,
      transportMode: "reverse-ws",
      settings: {},
      credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["ob-1:onebotBearer"] },
      trigger: {
        rules: [{ kind: "private-default" }],
        blockers: [],
        storeUnmatchedInDraftMode: false,
      },
      defaultMode: "manual",
      implMetadata: {
        impl: "napcat",
        version: "4.2.1",
        features: ["markdown-card", "upload_group_file", "set_msg_emoji_like"],
      },
      createdAt: now,
      updatedAt: now,
    })
    const ob = await db.adapterInstances.get("ob-1")
    expect(ob?.implMetadata?.impl).toBe("napcat")
    expect(ob?.implMetadata?.features).toContain("markdown-card")

    // conversationOverrides: provider/model override columns.
    await db.conversationOverrides.put({
      id: "co-v41",
      conversationKey: "slack:slk-1:C123",
      sessionId: "s_v41",
      providerOverride: "codex",
      modelOverride: "gpt-5",
      createdAt: now,
      updatedAt: now,
    })
    const co = await db.conversationOverrides.get("co-v41")
    expect(co?.providerOverride).toBe("codex")
    expect(co?.modelOverride).toBe("gpt-5")

    // outboundQueue: source + sourceWorkflow.
    await db.outboundQueue.put({
      id: "ob-v41-wf",
      adapterId: "tg-1",
      conversationKey: "telegram:tg-1:1",
      request: {
        conversationRef: { platform: "telegram", adapterId: "tg-1" },
        segments: [{ type: "text", text: "from workflow" }],
        metadata: { idempotencyKey: "k_wf" },
      },
      status: "pending",
      attempts: 0,
      createdAt: now,
      nextAttemptAt: now,
      idempotencyKey: "k_wf",
      source: "workflow",
      sourceWorkflow: { workflowId: "wf_1", runId: "run_1", nodeId: "n_send" },
    })
    const wfJob = await db.outboundQueue.get("ob-v41-wf")
    expect(wfJob?.source).toBe("workflow")
    expect(wfJob?.sourceWorkflow?.workflowId).toBe("wf_1")

    // automationAuditLog: conversationKey column + index.
    await db.automationAuditLog.put({
      id: "aud-v41-1",
      ts: now,
      surface: "computerUse",
      pluginId: null,
      command: "screen.capture",
      processName: null,
      windowTitle: null,
      decision: "allow",
      reason: null,
      durationMs: 12,
      error: null,
      conversationKey: "discord:dc-1:9999",
    })
    const audits = await db.automationAuditLog
      .where("conversationKey")
      .equals("discord:dc-1:9999")
      .toArray()
    expect(audits).toHaveLength(1)
    expect(audits[0].decision).toBe("allow")
  })

  // §A-Schema migration check for v18: Platform Connectors tables open
  // cleanly on a fresh database (Dexie auto-applies all version blocks up to
  // 18). Verify round-trips through each new table to prove the per-row type
  // compiles and the declared indexes accept inserts.
  it("v18 connector tables accept inserts and reads round-trip", async () => {
    const db = getDb()
    const now = Date.now()

    await db.adapterInstances.put({
      id: "tg-1",
      type: "telegram",
      displayName: "My Telegram bot",
      enabled: true,
      transportMode: "longpoll",
      settings: { pollIntervalMs: 1000 },
      credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["tg-1:botToken"] },
      trigger: {
        rules: [{ kind: "private-default" }],
        blockers: [],
        storeUnmatchedInDraftMode: true,
      },
      defaultMode: "auto",
      createdAt: now,
      updatedAt: now,
    })
    expect((await db.adapterInstances.get("tg-1"))?.type).toBe("telegram")

    await db.platformIdentities.put({
      id: "pi-1",
      platform: "telegram",
      adapterId: "tg-1",
      remoteUserId: "999",
      displayName: "Alice",
      lastSeenAt: now,
    })
    expect(
      (
        await db.platformIdentities
          .where("[platform+remoteUserId]")
          .equals(["telegram", "999"])
          .first()
      )?.id
    ).toBe("pi-1")

    await db.inboundLedger.put({
      id: "tg-1:inbound:m-1",
      adapterId: "tg-1",
      namespace: "inbound",
      platformMessageId: "m-1",
      receivedAt: now,
    })
    expect((await db.inboundLedger.get("tg-1:inbound:m-1"))?.adapterId).toBe("tg-1")

    await db.outboundQueue.put({
      id: "ob-1",
      adapterId: "tg-1",
      conversationKey: "telegram:tg-1:1",
      request: {
        conversationRef: { platform: "telegram", adapterId: "tg-1" },
        segments: [{ type: "text", text: "hi" }],
        metadata: { idempotencyKey: "k1" },
      },
      status: "pending",
      attempts: 0,
      createdAt: now,
      nextAttemptAt: now,
      idempotencyKey: "k1",
      source: "ai-run",
    })
    expect((await db.outboundQueue.get("ob-1"))?.status).toBe("pending")

    await db.conversationOverrides.put({
      id: "co-1",
      conversationKey: "telegram:tg-1:1",
      sessionId: "s1",
      mode: "manual",
      createdAt: now,
      updatedAt: now,
    })
    expect(
      (await db.conversationOverrides.where("conversationKey").equals("telegram:tg-1:1").first())
        ?.mode
    ).toBe("manual")

    await db.connectorAudit.put({
      id: "a-1",
      adapterId: "tg-1",
      kind: "delivery.success",
      at: now,
    })
    expect((await db.connectorAudit.get("a-1"))?.kind).toBe("delivery.success")

    await db.connectorDrafts.put({
      id: "d-1",
      conversationKey: "telegram:tg-1:1",
      sessionId: "s1",
      segments: [{ type: "text", text: "draft" }],
      status: "pending",
      createdAt: now,
    })
    expect((await db.connectorDrafts.get("d-1"))?.status).toBe("pending")

    await db.connectorAttachments.put({
      id: "att-1",
      adapterId: "tg-1",
      remoteRef: "tg-file-id",
      localPath: "/tmp/xyz.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      fetchedAt: now,
    })
    expect((await db.connectorAttachments.get("att-1"))?.mimeType).toBe("image/png")
  })

  // §A-Schema migration check for v17: tables open cleanly on a fresh
  // database (Dexie auto-applies all version blocks up to 17). Verify
  // round-trips through each new table to prove the per-row type compiles
  // and the declared indexes accept inserts.
  it("v17 wiki + audit tables accept inserts and reads round-trip", async () => {
    const db = getDb()
    const now = Date.now()

    await db.wikiArticles.put({
      id: "wka_1",
      slug: "lib-foo",
      title: "lib/foo overview",
      module: "lib/foo",
      scope: "cognia-self",
      pageRank: 0.42,
      summary: "summary",
      sectionIds: ["wks_1"],
      sourceRefs: [{ filePath: "lib/foo/index.ts", lineStart: 1, lineEnd: 10, sha: "abc" }],
      contentMd: "# heading\n\nbody",
      embedding: [0.1, 0.2],
      generatedAt: now,
      generatorVersion: "v1",
      fileHashes: { "lib/foo/index.ts": "abc" },
    })

    await db.wikiSections.put({
      id: "wks_1",
      articleId: "wka_1",
      sectionIndex: 0,
      headingPath: ["overview"],
      bodyMd: "section",
      sourceRefs: [],
    })

    await db.wikiManifest.put({
      scope: "cognia-self",
      fileHashes: { "lib/foo/index.ts": "abc" },
      lastBuildAt: now,
      articleCount: 1,
      generatorVersion: "v1",
    })

    await db.mcpAuditLog.put({
      id: "mau_1",
      ts: now,
      tool: "wiki_search",
      scope: "wiki:cognia",
      allowed: true,
      latencyMs: 5,
    })

    expect(await db.wikiArticles.get("wka_1")).toMatchObject({ slug: "lib-foo" })
    expect(await db.wikiSections.get("wks_1")).toMatchObject({ articleId: "wka_1" })
    expect(await db.wikiManifest.get("cognia-self")).toMatchObject({ articleCount: 1 })
    expect(await db.mcpAuditLog.get("mau_1")).toMatchObject({ tool: "wiki_search" })

    // Composite index on `wikiArticles[scope+module]` drives the wiki_search
    // module-filter path — verify the composite key returns the row.
    const byModule = await db.wikiArticles
      .where(["scope", "module"])
      .equals(["cognia-self", "lib/foo"])
      .toArray()
    expect(byModule).toHaveLength(1)
  })

  // §A-Schema migration check: Dexie auto-applies all version blocks up to
  // the latest when the schema bumps. Verify v15 opens cleanly on a fresh
  // database and that we can write/read a row through each new table — that
  // proves both the index declarations and the per-row type compile.
  it("v15 plugin tables accept inserts and reads round-trip", async () => {
    const db = getDb()
    const now = Date.now()

    await db.plugins.put({
      id: "p1",
      name: "Test Plugin",
      version: "1.0.0",
      status: "enabled",
      source: "builtin",
      type: "frontend",
      enabled: true,
      capabilities: ["tools", "commands"],
      path: "<builtin>/p1",
      manifest: { id: "p1", name: "Test Plugin", version: "1.0.0" },
      createdAt: now,
      updatedAt: now,
    })

    await db.pluginPermissions.put({
      pluginId: "p1",
      permission: "shell:execute",
      decision: "allow",
      grantedAt: now,
    })

    await db.pluginReviews.put({
      id: "rev-1",
      pluginId: "p1",
      rating: 5,
      title: "Great",
      createdAt: now,
    })

    await db.pluginAnalytics.put({
      pluginId: "p1",
      key: "tool.git_status.invocations",
      count: 7,
      lastEventAt: now,
    })

    await db.pluginScheduledJobs.put({
      id: "job-1",
      pluginId: "p1",
      cron: "0 * * * *",
      handler: "syncRepo",
      status: "active",
      createdAt: now,
      updatedAt: now,
    })

    expect(await db.plugins.get("p1")).toMatchObject({ name: "Test Plugin", enabled: true })
    expect(await db.pluginPermissions.get(["p1", "shell:execute"])).toMatchObject({
      decision: "allow",
    })
    expect(await db.pluginReviews.get(["p1", "rev-1"])).toMatchObject({ rating: 5 })
    expect(await db.pluginAnalytics.get(["p1", "tool.git_status.invocations"])).toMatchObject({
      count: 7,
    })
    expect(await db.pluginScheduledJobs.get("job-1")).toMatchObject({ status: "active" })
  })

  it("v15 plugin indexes drive filtered queries (multi-entry capabilities)", async () => {
    const db = getDb()
    const now = Date.now()
    await db.plugins.bulkPut([
      {
        id: "a",
        name: "A",
        version: "1",
        status: "enabled",
        source: "builtin",
        type: "frontend",
        enabled: true,
        capabilities: ["tools", "commands"],
        path: "x",
        manifest: {},
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "b",
        name: "B",
        version: "1",
        status: "enabled",
        source: "builtin",
        type: "frontend",
        enabled: true,
        capabilities: ["modes", "themes"],
        path: "x",
        manifest: {},
        createdAt: now,
        updatedAt: now,
      },
    ])

    // The `*capabilities` multi-entry index supports `where("capabilities").equals(...)`
    // queries — exactly the lookup the Settings → Plugins capability filter uses.
    const toolsPlugins = await db.plugins.where("capabilities").equals("tools").toArray()
    expect(toolsPlugins.map((p) => p.id)).toEqual(["a"])
    const themesPlugins = await db.plugins.where("capabilities").equals("themes").toArray()
    expect(themesPlugins.map((p) => p.id)).toEqual(["b"])
  })

  it("returns the same instance on repeat calls (memoised)", () => {
    const a = getDb()
    const b = getDb()
    expect(a).toBe(b)
  })

  it("__resetDbForTesting drops the cached instance", () => {
    const a = getDb()
    __resetDbForTesting()
    const b = getDb()
    expect(a).not.toBe(b)
  })

  // SSR guard (`typeof window === "undefined"`) cannot be exercised under
  // jsdom — `window` is a non-configurable global and `typeof` resolves
  // against the binding regardless of `globalThis.window`. The branch is
  // covered indirectly by every other test calling `getDb()` and observing
  // the "happy path" return value: the false branch of that conditional is
  // hit in every spec. Documenting here so a future maintainer knows why
  // we don't claim to exercise the throw.
})

describe("whenSeeded", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("resolves once and reflects seeded built-in characters", async () => {
    getDb()
    await whenSeeded()
    const built = await getDb().characters.where("isBuiltIn").equals(1).count()
    // Boolean indexing is unreliable across IDB shims; fall back to filter.
    const all = await getDb().characters.toArray()
    const builtIns = all.filter((c) => c.isBuiltIn)
    expect(builtIns.length + built).toBeGreaterThan(0)
  })

  it("returns a resolved promise when no seed run is pending", async () => {
    // Without calling getDb first, _seedPromise is null — whenSeeded must
    // gracefully kick off a seed via getDb(), then resolve.
    await expect(whenSeeded()).resolves.toBeUndefined()
  })
})

describe("schema upgrade hooks (round-trip via the latest version)", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("opens at v12 with the documented promptPresets indexes", async () => {
    const db = getDb()
    // Verify the table is queryable by the new boolean-ish indexes added in v12.
    await db.promptPresets.put({
      id: "p_test",
      name: "T",
      content: "x",
      isBuiltIn: false,
      isFavorite: true,
      sortOrder: 5,
      usageCount: 0,
      createdAt: 0,
      updatedAt: 0,
    })
    const fetched = await db.promptPresets.get("p_test")
    expect(fetched?.isFavorite).toBe(true)
    // Index on sortOrder is queryable
    const ordered = await db.promptPresets.orderBy("sortOrder").toArray()
    expect(ordered.find((p) => p.id === "p_test")?.sortOrder).toBe(5)
  })

  it("v5 upgrade hook normalises legacy team rows (memberCharacterIds → members[])", async () => {
    // Open Dexie at v4 (before the team-shape change), write a legacy row,
    // close, then re-open through the cached `getDb()` which routes through
    // every version up to v12.
    const Dexie = (await import("dexie")).default
    const legacy = new Dexie("cognia-claude")
    legacy.version(4).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
    })
    await legacy.open()
    // Wrap the three puts in one explicit transaction so they all commit
    // atomically before `legacy.close()` runs. Under fake-indexeddb the
    // implicit per-put auto-commit transactions can race with the close
    // and lose rows; this transaction guarantees the rows land before
    // the connection is torn down for the v28 reopen below.
    await legacy.transaction(
      "rw",
      legacy.table("teams"),
      legacy.table("mcpServers"),
      legacy.table("skills"),
      async () => {
        await legacy.table("teams").put({
          id: "team_legacy",
          name: "Legacy",
          memberCharacterIds: ["c1", "c2"],
          orchestration: "round_robin",
          avatarColor: "x",
          createdAt: 0,
          updatedAt: 0,
        })
        // Legacy mcpServers row missing appsEnabled — v7 hook should backfill {}
        await legacy.table("mcpServers").put({
          id: "mcp_legacy",
          name: "old",
          enabled: true,
          transport: "stdio",
          config: {},
        })
        // Legacy skills row missing source/status/category — v8 hook backfills.
        await legacy.table("skills").put({
          id: "skill_legacy",
          name: "old",
          content: "x",
          isBuiltIn: false,
          createdAt: 0,
          updatedAt: 0,
        })
      }
    )
    legacy.close()

    // Now open through the production schema: every upgrade hook runs.
    const db = getDb()
    await db.open()
    const team = await db.teams.get("team_legacy")
    expect(Array.isArray(team?.members)).toBe(true)
    expect(team?.members.map((m) => m.characterId)).toEqual(["c1", "c2"])
    // memberCharacterIds was deleted by the upgrade hook.
    expect((team as unknown as { memberCharacterIds?: unknown }).memberCharacterIds).toBeUndefined()

    const mcp = await db.mcpServers.get("mcp_legacy")
    expect(mcp?.appsEnabled).toEqual({})

    const skill = await db.skills.get("skill_legacy")
    expect(skill?.source).toBe("custom")
    expect(skill?.status).toBe("enabled")
    expect(skill?.category).toBe("custom")
    expect(skill?.usageCount).toBe(0)
  })

  it("v5 hook defaults to [] when memberCharacterIds is missing entirely", async () => {
    const Dexie = (await import("dexie")).default
    const legacy = new Dexie("cognia-claude")
    legacy.version(4).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
    })
    await legacy.open()
    await legacy.table("teams").put({
      id: "team_no_members_field",
      name: "Bare",
      // Neither memberCharacterIds nor members.
      orchestration: "manual",
      avatarColor: "x",
      createdAt: 0,
      updatedAt: 0,
    })
    legacy.close()
    const db = getDb()
    await db.open()
    const team = await db.teams.get("team_no_members_field")
    expect(team?.members).toEqual([])
  })

  it("v5 hook leaves rows that already use members[] alone", async () => {
    const Dexie = (await import("dexie")).default
    const legacy = new Dexie("cognia-claude")
    legacy.version(4).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
    })
    await legacy.open()
    await legacy.table("teams").put({
      id: "team_already_modern",
      name: "Modern",
      // Already has members[] — hook must short-circuit.
      members: [{ characterId: "x" }],
      orchestration: "manual",
      avatarColor: "x",
      createdAt: 0,
      updatedAt: 0,
    })
    legacy.close()
    const db = getDb()
    await db.open()
    const team = await db.teams.get("team_already_modern")
    expect(team?.members).toEqual([{ characterId: "x" }])
  })

  it("v7 hook leaves mcpServers rows that already have appsEnabled alone", async () => {
    const Dexie = (await import("dexie")).default
    const legacy = new Dexie("cognia-claude")
    legacy.version(6).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
    })
    await legacy.open()
    await legacy.table("mcpServers").put({
      id: "mcp_modern",
      name: "modern",
      enabled: true,
      transport: "stdio",
      config: {},
      appsEnabled: { codex: true },
    })
    legacy.close()
    const db = getDb()
    await db.open()
    const mcp = await db.mcpServers.get("mcp_modern")
    expect(mcp?.appsEnabled).toEqual({ codex: true })
  })

  it("v8 hook respects existing skill source/status/category fields", async () => {
    const Dexie = (await import("dexie")).default
    const legacy = new Dexie("cognia-claude")
    legacy.version(7).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
    })
    await legacy.open()
    await legacy.table("skills").put({
      id: "skill_with_meta",
      name: "withmeta",
      content: "x",
      isBuiltIn: true,
      source: "marketplace",
      status: "disabled",
      category: "development",
      usageCount: 7,
      createdAt: 0,
      updatedAt: 0,
    })
    legacy.close()
    const db = getDb()
    await db.open()
    const skill = await db.skills.get("skill_with_meta")
    // None of those fields should be overwritten by the upgrade hook.
    expect(skill?.source).toBe("marketplace")
    expect(skill?.status).toBe("disabled")
    expect(skill?.category).toBe("development")
    expect(skill?.usageCount).toBe(7)
  })

  it("seed catch handler swallows DatabaseClosedError silently", async () => {
    // Trigger the .catch(...) branch in getDb's seed kickoff. We do this by
    // racing a db.delete() against the inflight seed; Dexie throws
    // DatabaseClosedError which the schema's catch handler short-circuits.
    const db = getDb()
    const seedDeletePromise = db.delete()
    // Wait for the seed promise to settle (the catch should fire).
    await whenSeeded()
    await seedDeletePromise
    // No assertion needed beyond "did not reject" — test passes if we got
    // here without an unhandled rejection.
    expect(true).toBe(true)
  })

  it("seed catch handler logs unrelated errors", async () => {
    // Force the inner seed to reject with a non-DatabaseClosed error so we
    // hit the `console.error` branch. We achieve this by mocking
    // `seedBuiltIns` via jest.doMock with a fresh module load.
    await jest.isolateModulesAsync(async () => {
      jest.doMock("./seed", () => ({
        seedBuiltIns: () => Promise.reject(new Error("boom")),
      }))
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
      const fresh = await import("./schema")
      fresh.__resetDbForTesting()
      fresh.getDb()
      await fresh.whenSeeded()
      expect(errSpy).toHaveBeenCalledWith("seedBuiltIns failed", expect.any(Error))
      errSpy.mockRestore()
      fresh.__resetDbForTesting()
    })
  })

  it("v16 upgrade hook migrates customThemes[].colors to tokens.{light,dark}", async () => {
    // Open Dexie at v15 (before the dual-variant rewrite), seed the singleton
    // settings row with a legacy customTheme, close, then re-open through the
    // production schema. The v16 upgrade hook should walk the blob and
    // promote the legacy `{colors, isDark}` pair to `{tokens, baseVariant}`
    // while leaving the legacy fields in place for rollback safety.
    const Dexie = (await import("dexie")).default
    const legacy = new Dexie("cognia-claude")
    legacy.version(15).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets:
        "id, updatedAt, isBuiltIn, isDefault, isFavorite, sortOrder, category, lastUsedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
      skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
      tts_provider_keys: "id",
      backupHistory: "id, completedAt, type, success",
      canvasDocuments: "id, title, language, type, updatedAt, createdAt",
      canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave",
      canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt",
      canvasSessions: "id, documentId, ownerId, createdAt",
      a2uiApps: "id, name, updatedAt, createdAt, isBuiltIn, category, isFavorite, sortOrder",
      a2uiSurfaces: "id, appId, sessionId, updatedAt, createdAt, type",
      a2uiTemplates: "id, name, category, updatedAt, source",
      a2uiEventHistory: "id, surfaceId, [surfaceId+timestamp], timestamp, type",
      twinSources: "&id, twinId, kind, format, status, fingerprint, [twinId+kind], [twinId+status]",
      twinChunks: "&id, twinId, sourceId, vectorDocId, [twinId+sourceId], [twinId+createdAt]",
      twinProfile: "&id, twinId",
      twinDrafts: "&id, twinId, jobId, kind, status, [twinId+status], [twinId+kind]",
      twinJobs: "&id, twinId, status, queuedAt, [twinId+status], [twinId+kind]",
      plugins: "id, name, version, status, source, type, enabled, lastUsedAt, *capabilities",
      pluginPermissions: "[pluginId+permission], pluginId, permission, decision, expiresAt",
      pluginReviews: "[pluginId+id], pluginId, rating, createdAt",
      pluginAnalytics: "[pluginId+key], pluginId, key, lastEventAt",
      pluginScheduledJobs: "id, pluginId, cron, lastRunAt, nextRunAt, status",
    })
    await legacy.open()
    await legacy.table("settings").put({
      id: "singleton",
      customThemes: [
        {
          id: "legacy-1",
          name: "Legacy Theme",
          isDark: true,
          colors: {
            background: "#0b0b0b",
            foreground: "#ffffff",
            primary: "#ff00ff",
            primaryForeground: "#000000",
            secondary: "#222222",
            secondaryForeground: "#dddddd",
            accent: "#00ffff",
            accentForeground: "#000000",
            muted: "#1a1a1a",
            mutedForeground: "#aaaaaa",
            card: "#101010",
            cardForeground: "#fafafa",
            popover: "#0d0d0d",
            popoverForeground: "#fafafa",
            input: "#222222",
            border: "#333333",
            ring: "#ff00ff",
            destructive: "#ff4040",
            destructiveForeground: "#ffffff",
            sidebar: "#0a0a0a",
            sidebarForeground: "#fafafa",
            sidebarPrimary: "#ff00ff",
            sidebarBorder: "#222222",
          },
        },
      ],
    })
    legacy.close()

    // Re-open through the production schema — v16 upgrade hook fires.
    const db = getDb()
    await db.open()
    const row = (await db.settings.get("singleton" as never)) as unknown as {
      customThemes?: Array<Record<string, unknown>>
    }
    const t = row?.customThemes?.[0] as Record<string, unknown> | undefined
    expect(t).toBeDefined()
    expect(t?.baseVariant).toBe("dark")
    expect(t?.derivedVariant).toBe("light")
    const tokens = t?.tokens as { light: Record<string, string>; dark: Record<string, string> }
    expect(tokens).toBeDefined()
    // The dark side carries the original palette verbatim.
    expect(tokens.dark.primary).toBe("#ff00ff")
    expect(tokens.dark.background).toBe("#0b0b0b")
    // The light side was synthesized via OKLCH derivation; we don't pin a
    // specific value (Task 6 owns the algorithm), only that something was
    // produced for each of the originally-defined keys.
    expect(typeof tokens.light.primary).toBe("string")
    expect(tokens.light.primary.length).toBeGreaterThan(0)
    expect(typeof tokens.light.background).toBe("string")
    // Legacy fields preserved for one-release rollback safety.
    expect(t?.colors).toBeDefined()
    expect(t?.isDark).toBe(true)
  })

  it("v16 upgrade hook is idempotent — already-migrated rows untouched", async () => {
    // A row that already carries the dual-variant shape must be left alone
    // (no re-derivation, no overwriting hand-edited tokens). We seed with
    // a sentinel `light.primary` value the OKLCH derivation would never
    // produce, then assert it survives intact.
    const Dexie = (await import("dexie")).default
    const legacy = new Dexie("cognia-claude")
    legacy.version(15).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets:
        "id, updatedAt, isBuiltIn, isDefault, isFavorite, sortOrder, category, lastUsedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
      skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
      tts_provider_keys: "id",
      backupHistory: "id, completedAt, type, success",
      canvasDocuments: "id, title, language, type, updatedAt, createdAt",
      canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave",
      canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt",
      canvasSessions: "id, documentId, ownerId, createdAt",
      a2uiApps: "id, name, updatedAt, createdAt, isBuiltIn, category, isFavorite, sortOrder",
      a2uiSurfaces: "id, appId, sessionId, updatedAt, createdAt, type",
      a2uiTemplates: "id, name, category, updatedAt, source",
      a2uiEventHistory: "id, surfaceId, [surfaceId+timestamp], timestamp, type",
      twinSources: "&id, twinId, kind, format, status, fingerprint, [twinId+kind], [twinId+status]",
      twinChunks: "&id, twinId, sourceId, vectorDocId, [twinId+sourceId], [twinId+createdAt]",
      twinProfile: "&id, twinId",
      twinDrafts: "&id, twinId, jobId, kind, status, [twinId+status], [twinId+kind]",
      twinJobs: "&id, twinId, status, queuedAt, [twinId+status], [twinId+kind]",
      plugins: "id, name, version, status, source, type, enabled, lastUsedAt, *capabilities",
      pluginPermissions: "[pluginId+permission], pluginId, permission, decision, expiresAt",
      pluginReviews: "[pluginId+id], pluginId, rating, createdAt",
      pluginAnalytics: "[pluginId+key], pluginId, key, lastEventAt",
      pluginScheduledJobs: "id, pluginId, cron, lastRunAt, nextRunAt, status",
    })
    await legacy.open()
    await legacy.table("settings").put({
      id: "singleton",
      customThemes: [
        {
          id: "already-migrated",
          name: "Modern",
          baseVariant: "light",
          derivedVariant: "dark",
          tokens: {
            light: { primary: "#sentinel-light", background: "#fff" },
            dark: { primary: "#sentinel-dark", background: "#000" },
          },
          // No `colors`/`isDark` — already on the new shape.
        },
      ],
    })
    legacy.close()

    const db = getDb()
    await db.open()
    const row = (await db.settings.get("singleton" as never)) as unknown as {
      customThemes?: Array<Record<string, unknown>>
    }
    const t = row?.customThemes?.[0] as Record<string, unknown> | undefined
    const tokens = t?.tokens as { light: Record<string, string>; dark: Record<string, string> }
    // Sentinel values must survive — proves the hook short-circuited.
    expect(tokens.light.primary).toBe("#sentinel-light")
    expect(tokens.dark.primary).toBe("#sentinel-dark")
    expect(t?.baseVariant).toBe("light")
    expect(t?.derivedVariant).toBe("dark")
  })

  it("v16 upgrade hook tolerates a settings row with no customThemes field", async () => {
    // Defensive: the singleton row may exist before any custom theme has
    // been created. The hook must not crash on `customThemes === undefined`.
    const Dexie = (await import("dexie")).default
    const legacy = new Dexie("cognia-claude")
    legacy.version(15).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets:
        "id, updatedAt, isBuiltIn, isDefault, isFavorite, sortOrder, category, lastUsedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
      skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
      tts_provider_keys: "id",
      backupHistory: "id, completedAt, type, success",
      canvasDocuments: "id, title, language, type, updatedAt, createdAt",
      canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave",
      canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt",
      canvasSessions: "id, documentId, ownerId, createdAt",
      a2uiApps: "id, name, updatedAt, createdAt, isBuiltIn, category, isFavorite, sortOrder",
      a2uiSurfaces: "id, appId, sessionId, updatedAt, createdAt, type",
      a2uiTemplates: "id, name, category, updatedAt, source",
      a2uiEventHistory: "id, surfaceId, [surfaceId+timestamp], timestamp, type",
      twinSources: "&id, twinId, kind, format, status, fingerprint, [twinId+kind], [twinId+status]",
      twinChunks: "&id, twinId, sourceId, vectorDocId, [twinId+sourceId], [twinId+createdAt]",
      twinProfile: "&id, twinId",
      twinDrafts: "&id, twinId, jobId, kind, status, [twinId+status], [twinId+kind]",
      twinJobs: "&id, twinId, status, queuedAt, [twinId+status], [twinId+kind]",
      plugins: "id, name, version, status, source, type, enabled, lastUsedAt, *capabilities",
      pluginPermissions: "[pluginId+permission], pluginId, permission, decision, expiresAt",
      pluginReviews: "[pluginId+id], pluginId, rating, createdAt",
      pluginAnalytics: "[pluginId+key], pluginId, key, lastEventAt",
      pluginScheduledJobs: "id, pluginId, cron, lastRunAt, nextRunAt, status",
    })
    await legacy.open()
    await legacy.table("settings").put({ id: "singleton", colorTheme: "default" })
    legacy.close()

    const db = getDb()
    await expect(db.open()).resolves.toBeDefined()
    const row = (await db.settings.get("singleton" as never)) as unknown as {
      customThemes?: unknown
      colorTheme?: string
    }
    expect(row?.colorTheme).toBe("default")
    // No customThemes field was created; the hook should leave the row alone.
    expect(row?.customThemes).toBeUndefined()
  })

  it("v12 upgrade hook fills preset defaults on legacy rows", async () => {
    const Dexie = (await import("dexie")).default
    const legacy = new Dexie("cognia-claude")
    legacy.version(11).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
      skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
      tts_provider_keys: "id",
      backupHistory: "id, completedAt, type, success",
      canvasDocuments: "id, title, language, type, updatedAt, createdAt",
      canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave",
      canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt",
      canvasSessions: "id, documentId, ownerId, createdAt",
    })
    await legacy.open()
    await legacy.table("promptPresets").put({
      id: "p_legacy",
      name: "Legacy",
      content: "x",
      createdAt: 0,
      updatedAt: 0,
    })
    legacy.close()
    const db = getDb()
    await db.open()
    const p = await db.promptPresets.get("p_legacy")
    expect(p?.isBuiltIn).toBe(false)
    expect(p?.isFavorite).toBe(false)
    expect(p?.usageCount).toBe(0)
    expect(p?.sortOrder).toBe(0)
  })

  it("v68 notifications table exposes the dedupeKey/groupKey + compound indexes", async () => {
    const db = getDb()
    await db.open()
    const base = {
      title: "t",
      createdAt: 1,
      updatedAt: 1,
      count: 1,
      directed: false,
      deliveredVia: ["center"] as const,
    }
    await db.notifications.bulkPut([
      {
        id: "x",
        source: "connector",
        level: "info",
        readState: "unseen",
        dedupeKey: "k",
        groupKey: "g",
        ...base,
      },
      {
        id: "y",
        source: "scheduler",
        level: "error",
        readState: "read",
        ...base,
        createdAt: 2,
        updatedAt: 2,
      },
    ] as never)
    // Single-property indexes are queryable.
    expect((await db.notifications.where("dedupeKey").equals("k").toArray())[0]?.id).toBe("x")
    expect((await db.notifications.where("groupKey").equals("g").toArray())[0]?.id).toBe("x")
    // Compound [readState+createdAt] index is usable (newest-unread feed).
    const unseen = await db.notifications
      .where("[readState+createdAt]")
      .between(["unseen", -Infinity], ["unseen", Infinity])
      .toArray()
    expect(unseen.map((r) => r.id)).toEqual(["x"])
    // Compound [source+createdAt] index is usable (per-source feed).
    const sched = await db.notifications
      .where("[source+createdAt]")
      .between(["scheduler", -Infinity], ["scheduler", Infinity])
      .toArray()
    expect(sched.map((r) => r.id)).toEqual(["y"])
  })
})

describe("v79 loop tables (/loop command)", () => {
  it("registers loops + loopEvents with their indexes", async () => {
    const db = getDb()
    await whenSeeded()
    expect(db.verno).toBeGreaterThanOrEqual(79)
    await db.loops.add({
      id: "lp_1",
      sessionId: "ses_a",
      mode: "interval",
      rawPrompt: "check deploy",
      safePrompt: "check deploy",
      redactionMapEnc: "",
      isSlashCommand: false,
      status: "active",
      iterations: 0,
      tokensUsed: 0,
      generationId: "gen-1",
      config: {
        maxIterations: 100,
        maxTokens: 1_000_000,
        minDelayMs: 60_000,
        maxDelayMs: 3_600_000,
        maxParseFailures: 3,
      },
      parseFailureCount: 0,
      scheduledTaskId: "task_1",
      createdAt: 1,
      updatedAt: 1,
    })
    await db.loopEvents.add({
      id: "lev_1",
      loopId: "lp_1",
      kind: "loop_created",
      ts: 1,
      payload: {
        kind: "loop_created",
        mode: "interval",
        safePrompt: "check deploy",
        config: {
          maxIterations: 100,
          maxTokens: 1_000_000,
          minDelayMs: 60_000,
          maxDelayMs: 3_600_000,
          maxParseFailures: 3,
        },
      },
    })
    // Compound [sessionId+status] serves the one-active-per-session lookup.
    const active = await db.loops.where("[sessionId+status]").equals(["ses_a", "active"]).first()
    expect(active?.id).toBe("lp_1")
    // scheduledTaskId is indexed for scheduler-side reverse lookups.
    expect((await db.loops.where("scheduledTaskId").equals("task_1").first())?.id).toBe("lp_1")
    // [loopId+ts] serves the reverse-chrono activity feed.
    const events = await db.loopEvents
      .where("[loopId+ts]")
      .between(["lp_1", -Infinity], ["lp_1", Infinity])
      .toArray()
    expect(events).toHaveLength(1)
  })
})
