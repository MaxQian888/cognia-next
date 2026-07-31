import { createLarkPresence } from "./presence"

interface Call {
  method: string
  urlPath: string
  body?: unknown
}

function harness(opts: { statusId?: string; createId?: string } = {}) {
  const calls: Call[] = []
  let storedId: string | undefined = opts.statusId
  const presence = createLarkPresence({
    adapterId: "lark-1",
    request: async (method, urlPath, body) => {
      calls.push({ method, urlPath, body })
      if (method === "POST" && urlPath === "/personal_settings/v1/system_statuses") {
        return { data: { system_status: { system_status_id: opts.createId ?? "st-1" } } }
      }
      return { code: 0 }
    },
    getStatusId: async () => storedId,
    setStatusId: async (id) => {
      storedId = id
    },
  })
  return { presence, calls, getStored: () => storedId }
}

describe("createLarkPresence.setPresenceStatus", () => {
  it("creates the system status lazily, persists the id, and opens for targets", async () => {
    const { presence, calls, getStored } = harness()
    await presence.setPresenceStatus({
      text: "AI 1.2M $3.4",
      targetUserIds: ["ou_a", "ou_b"],
      expiresAt: 1_800_000_000_000,
    })
    expect(getStored()).toBe("st-1")
    const paths = calls.map((c) => `${c.method} ${c.urlPath}`)
    expect(paths).toEqual([
      "POST /personal_settings/v1/system_statuses",
      "POST /personal_settings/v1/system_statuses/st-1/batch_close?user_id_type=open_id",
      "POST /personal_settings/v1/system_statuses/st-1/batch_open?user_id_type=open_id",
    ])
    const open = calls[2].body as { user_list: Array<{ user_id: string; end_time: string }> }
    expect(open.user_list).toEqual([
      { user_id: "ou_a", end_time: "1800000000" },
      { user_id: "ou_b", end_time: "1800000000" },
    ])
  })

  it("patches the title then cycles close→open when the status already exists", async () => {
    const { presence, calls } = harness({ statusId: "st-9" })
    await presence.setPresenceStatus({ text: "AI 5k $0.1", targetUserIds: ["ou_a"] })
    const paths = calls.map((c) => `${c.method} ${c.urlPath}`)
    expect(paths).toEqual([
      "PATCH /personal_settings/v1/system_statuses/st-9",
      "POST /personal_settings/v1/system_statuses/st-9/batch_close?user_id_type=open_id",
      "POST /personal_settings/v1/system_statuses/st-9/batch_open?user_id_type=open_id",
    ])
    const patch = calls[0].body as { system_status: { title: string }; update_fields: string[] }
    expect(patch.system_status.title).toBe("AI 5k $0.1")
    expect(patch.update_fields).toEqual(["TITLE", "I18N_TITLE"])
  })

  it("hard-truncates the title to the 20-unit Lark budget (CJK = 2)", async () => {
    const { presence, calls } = harness({ statusId: "st-9" })
    await presence.setPresenceStatus({ text: "用量统计超长标题一二三四五六七" })
    const patch = calls[0].body as { system_status: { title: string } }
    expect(patch.system_status.title).toBe("用量统计超长标题一二")
  })

  it("skips user cycling when no targets are configured", async () => {
    const { presence, calls } = harness({ statusId: "st-9" })
    await presence.setPresenceStatus({ text: "AI 1k" })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe("PATCH")
  })

  it("no-ops on empty text", async () => {
    const { presence, calls } = harness()
    await presence.setPresenceStatus({ text: "" })
    expect(calls).toHaveLength(0)
  })

  it("chunks user lists beyond the 50-user batch cap", async () => {
    const { presence, calls } = harness({ statusId: "st-9" })
    const users = Array.from({ length: 60 }, (_, i) => `ou_${i}`)
    await presence.setPresenceStatus({ text: "AI 1k", targetUserIds: users })
    // 1 patch + 2×(close+open)
    expect(calls).toHaveLength(5)
    const firstOpen = calls[2].body as { user_list: unknown[] }
    const secondOpen = calls[4].body as { user_list: unknown[] }
    expect(firstOpen.user_list).toHaveLength(50)
    expect(secondOpen.user_list).toHaveLength(10)
  })

  it("throws when create returns no id", async () => {
    const calls: Call[] = []
    const presence = createLarkPresence({
      adapterId: "lark-1",
      request: async (method, urlPath, body) => {
        calls.push({ method, urlPath, body })
        return { data: {} }
      },
      getStatusId: async () => undefined,
      setStatusId: async () => {},
    })
    await expect(presence.setPresenceStatus({ text: "AI" })).rejects.toThrow(/no id/)
  })
})

describe("createLarkPresence.pinMessage", () => {
  it("POSTs /im/v1/pins with the message id", async () => {
    const { presence, calls } = harness()
    await presence.pinMessage("lark:conv", "om_123")
    expect(calls).toEqual([
      { method: "POST", urlPath: "/im/v1/pins", body: { message_id: "om_123" } },
    ])
  })
})

describe("createLarkPresence.unpinMessage", () => {
  it("DELETEs /im/v1/pins/<message_id>", async () => {
    const { presence, calls } = harness()
    await presence.unpinMessage("om_123")
    expect(calls).toEqual([{ method: "DELETE", urlPath: "/im/v1/pins/om_123", body: undefined }])
  })
})

describe("createLarkPresence create payload", () => {
  it("includes a valid icon_key (Feishu now requires it)", async () => {
    const { presence, calls } = harness()
    await presence.setPresenceStatus({ text: "AI", targetUserIds: [] })
    const create = calls.find(
      (c) => c.method === "POST" && c.urlPath === "/personal_settings/v1/system_statuses"
    )
    expect((create?.body as { icon_key?: string }).icon_key).toBe("GeneralWorkFromHome")
  })
})
