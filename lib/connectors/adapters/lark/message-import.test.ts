/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { findImportBySourceHash, computeImportSourceHash } from "@/lib/db/lark-message-imports"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import {
  buildImportedContextBlock,
  importLarkMessages,
  type ImportMessagesDependencies,
} from "./message-import"

const ADAPTER_ID = "lark-import-1"
const CHAT_ID = "oc_import_1"
const IDENTITY = { openId: "ou_alice", tenantKey: "tk_a", appId: "cli_1" }

function adapterRow(settings: Record<string, unknown> = { larkMessageShortcut: true }) {
  return { id: ADAPTER_ID, platform: "lark", settings } as unknown as AdapterInstanceRow
}

function rawMessage(id: string, overrides: Record<string, unknown> = {}) {
  return {
    message_id: id,
    chat_id: CHAT_ID,
    chat_type: "group",
    msg_type: "text",
    body: { content: JSON.stringify({ text: `hello from ${id}` }) },
    sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
    create_time: "1714900000000",
    ...overrides,
  }
}

function makeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    tenantRequest: jest.fn(async (_c: unknown, _m: string, path: string) => {
      const id = decodeURIComponent(path.split("/").pop() ?? "")
      return { data: { items: [rawMessage(id)] } }
    }),
    keyringGet: jest.fn(async (_a: string, cred: string) =>
      cred === "appId" ? "cli_1" : "secret"
    ),
    getAdapter: jest.fn(async () => adapterRow()),
    isMember: jest.fn(async () => true),
    audit: jest.fn(async () => undefined),
    metric: jest.fn(),
    now: () => 1_700_000_000_000,
    ...overrides,
  } as unknown as Partial<ImportMessagesDependencies> & {
    tenantRequest: jest.Mock
    isMember: jest.Mock
    audit: jest.Mock
    metric: jest.Mock
  }
}

describe("importLarkMessages", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })
  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("denies when the larkMessageShortcut flag is off", async () => {
    const deps = makeDeps({ getAdapter: jest.fn(async () => adapterRow({})) })
    const outcome = await importLarkMessages(
      { adapterId: ADAPTER_ID, chatId: CHAT_ID, messageIds: ["om_1"], verifiedIdentity: IDENTITY },
      deps
    )
    expect(outcome).toEqual({ ok: false, error: "feature_disabled" })
    expect(deps.metric).toHaveBeenCalledWith("lark_message_import_denied_total")
    expect((deps.audit.mock.calls[0][0] as { kind: string }).kind).toBe("shortcut.import_denied")
  })

  it("denies non-members before touching any message", async () => {
    const deps = makeDeps({ isMember: jest.fn(async () => false) })
    const outcome = await importLarkMessages(
      { adapterId: ADAPTER_ID, chatId: CHAT_ID, messageIds: ["om_1"], verifiedIdentity: IDENTITY },
      deps
    )
    expect(outcome).toEqual({ ok: false, error: "membership_denied" })
    expect(deps.tenantRequest).not.toHaveBeenCalled()
  })

  it("imports verified messages into a fresh session with one delimited block", async () => {
    const deps = makeDeps()
    const outcome = await importLarkMessages(
      {
        adapterId: ADAPTER_ID,
        chatId: CHAT_ID,
        messageIds: ["om_1", "om_2"],
        verifiedIdentity: IDENTITY,
        triggerId: "trig_9",
      },
      deps
    )
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.error}`)
    expect(outcome.imported).toBe(2)
    expect(outcome.replay).toBe(false)
    expect(outcome.conversationKey).toBe(`lark:${ADAPTER_ID}:${CHAT_ID}`)

    const session = await getDb().sessions.get(outcome.sessionId)
    expect(session?.platformConversationKey).toBe(outcome.conversationKey)

    const messages = await getDb().messages.where("sessionId").equals(outcome.sessionId).toArray()
    expect(messages).toHaveLength(1)
    const text = (messages[0].parts[0] as { text: string }).text
    expect(text).toContain("Imported from Feishu / 从飞书导入")
    expect(text).toContain("hello from om_1")
    expect(text).toContain("hello from om_2")
    const importMeta = (messages[0].metadata as { larkImport: { triggerId?: string } }).larkImport
    expect(importMeta.triggerId).toBe("trig_9")

    expect(deps.metric).toHaveBeenCalledWith("lark_message_imports_total")
    const kinds = deps.audit.mock.calls.map((c) => (c[0] as { kind: string }).kind)
    expect(kinds).toContain("shortcut.import")

    const stored = await findImportBySourceHash(
      await computeImportSourceHash(ADAPTER_ID, CHAT_ID, ["om_1", "om_2"])
    )
    expect(stored?.sessionId).toBe(outcome.sessionId)
  })

  it("replays the same selection onto the original session", async () => {
    const deps = makeDeps()
    const input = {
      adapterId: ADAPTER_ID,
      chatId: CHAT_ID,
      messageIds: ["om_1", "om_2"],
      verifiedIdentity: IDENTITY,
    }
    const first = await importLarkMessages(input, deps)
    // Same ids in a different order — the hash is order-independent.
    const second = await importLarkMessages({ ...input, messageIds: ["om_2", "om_1"] }, makeDeps())
    if (!first.ok || !second.ok) throw new Error("expected both ok")
    expect(second.replay).toBe(true)
    expect(second.sessionId).toBe(first.sessionId)
    const sessions = await getDb().sessions.toArray()
    expect(sessions).toHaveLength(1)
  })

  it("skips smuggled, recalled, and empty messages with reasons", async () => {
    const deps = makeDeps({
      tenantRequest: jest.fn(async (_c: unknown, _m: string, path: string) => {
        const id = decodeURIComponent(path.split("/").pop() ?? "")
        if (id === "om_other_chat") {
          return { data: { items: [rawMessage(id, { chat_id: "oc_OTHER" })] } }
        }
        if (id === "om_recalled") {
          return { data: { items: [rawMessage(id, { deleted: true })] } }
        }
        if (id === "om_gone") return { data: { items: [] } }
        return { data: { items: [rawMessage(id)] } }
      }),
    })
    const outcome = await importLarkMessages(
      {
        adapterId: ADAPTER_ID,
        chatId: CHAT_ID,
        messageIds: ["om_ok", "om_other_chat", "om_recalled", "om_gone"],
        verifiedIdentity: IDENTITY,
      },
      deps
    )
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.error}`)
    expect(outcome.imported).toBe(1)
    expect(outcome.skipped).toEqual([
      { messageId: "om_other_chat", reason: "chat_mismatch" },
      { messageId: "om_recalled", reason: "recalled" },
      { messageId: "om_gone", reason: "not_found" },
    ])
  })

  it("denies when every message fails verification", async () => {
    const deps = makeDeps({
      tenantRequest: jest.fn(async () => ({ data: { items: [] } })),
    })
    const outcome = await importLarkMessages(
      { adapterId: ADAPTER_ID, chatId: CHAT_ID, messageIds: ["om_x"], verifiedIdentity: IDENTITY },
      deps
    )
    expect(outcome).toEqual({ ok: false, error: "no_importable_messages" })
  })

  it("enforces the 20-message cap after dedupe", async () => {
    const deps = makeDeps()
    const outcome = await importLarkMessages(
      {
        adapterId: ADAPTER_ID,
        chatId: CHAT_ID,
        messageIds: Array.from({ length: 21 }, (_, i) => `om_${i}`),
        verifiedIdentity: IDENTITY,
      },
      deps
    )
    expect(outcome).toEqual({ ok: false, error: "message_count_invalid" })
  })
})

describe("importLarkMessages failure arms", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })
  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("skips messages whose platform fetch throws", async () => {
    const deps = makeDeps({
      tenantRequest: jest.fn(async (_c: unknown, _m: string, path: string) => {
        if (path.endsWith("om_boom")) throw new Error("api down")
        const id = decodeURIComponent(path.split("/").pop() ?? "")
        return { data: { items: [rawMessage(id)] } }
      }),
    })
    const outcome = await importLarkMessages(
      {
        adapterId: ADAPTER_ID,
        chatId: CHAT_ID,
        messageIds: ["om_ok", "om_boom"],
        verifiedIdentity: IDENTITY,
      },
      deps
    )
    if (!outcome.ok) throw new Error("expected ok")
    expect(outcome.skipped).toEqual([{ messageId: "om_boom", reason: "fetch_failed" }])
  })

  it("denies with membership_check_failed when the member API throws", async () => {
    const deps = makeDeps({
      isMember: jest.fn(async () => {
        throw new Error("members api down")
      }),
    })
    expect(
      await importLarkMessages(
        {
          adapterId: ADAPTER_ID,
          chatId: CHAT_ID,
          messageIds: ["om_1"],
          verifiedIdentity: IDENTITY,
        },
        deps
      )
    ).toEqual({ ok: false, error: "membership_check_failed" })
  })

  it("denies with credentials_unavailable when the keyring is empty", async () => {
    const deps = makeDeps({ keyringGet: jest.fn(async () => null) })
    expect(
      await importLarkMessages(
        {
          adapterId: ADAPTER_ID,
          chatId: CHAT_ID,
          messageIds: ["om_1"],
          verifiedIdentity: IDENTITY,
        },
        deps
      )
    ).toEqual({ ok: false, error: "credentials_unavailable" })
  })
})

describe("buildImportedContextBlock", () => {
  it("wraps sender-attributed lines in explicit delimiters", () => {
    const block = buildImportedContextBlock(
      [
        {
          sender: { displayName: "Alice", remoteUserId: "ou_a" },
          plainText: "first",
        },
        { sender: { remoteUserId: "ou_b" }, plainText: "second" },
      ] as never,
      { chatId: "oc_1", importedAt: 0 }
    )
    expect(block).toContain("2 message(s)")
    expect(block).toContain("Alice: first")
    expect(block).toContain("ou_b: second")
    expect(block.startsWith("[Imported from Feishu")).toBe(true)
    expect(block.endsWith("[End of imported messages / 导入结束]")).toBe(true)
  })
})
