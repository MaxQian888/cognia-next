import {
  AVATAR_RETRY_MS,
  AVATAR_TTL_MS,
  conversationPlatformAvatarTarget,
  inlineAvatarUrl,
  messagePlatformAvatarTarget,
  qqAvatarUrl,
  resolvePlatformAvatar,
  type PlatformAvatarTarget,
} from "./platform-avatar"
import { getAdapterInstance, listAdapterInstancesByType } from "@/lib/db/adapter-instances"
import { emitCredentialsRotated } from "@/lib/connectors/credentials-events"
import { getCredentialsGeneration } from "@/lib/connectors/credentials-events"
import { fetchAttachment } from "@/lib/connectors/attachment-fetcher"
import {
  connectorsAttachmentRead,
  connectorsHttpRequest,
  connectorsKeyringGet,
} from "@/lib/connectors/tauri/commands"

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII="
let mockDb = { name: "account-a", sessions: { get: jest.fn() } }
jest.mock("@/lib/db/schema", () => ({ getDb: () => mockDb }))
jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: jest.fn(),
  listAdapterInstancesByType: jest.fn(),
}))
jest.mock("@/lib/connectors/attachment-fetcher", () => ({ fetchAttachment: jest.fn() }))
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsAttachmentRead: jest.fn(),
  connectorsHttpRequest: jest.fn(),
  connectorsKeyringGet: jest.fn(),
}))
jest.mock("@/lib/connectors/adapters/lark/http", () => ({ larkTenantRequest: jest.fn() }))
jest.mock("@/lib/connectors/credentials-events", () => {
  const actual = jest.requireActual("@/lib/connectors/credentials-events")
  return { ...actual, getCredentialsGeneration: jest.fn(actual.getCredentialsGeneration) }
})
jest.mock("@/lib/connectors/adapters/dingtalk/auth", () => ({ getDingTalkAccessToken: jest.fn() }))
jest.mock("@/lib/connectors/adapters/qq-official/auth", () => ({
  getQQAccessToken: jest.fn(),
  QQ_API_BASE: "https://api.bot.qq.com",
  qqAuthHeaders: (token: string) => ({ Authorization: `QQBot ${token}` }),
}))
const target: PlatformAvatarTarget = {
  platform: "onebot",
  adapterId: "adapter-a",
  kind: "user",
  remoteId: "12345",
  onebotPlatform: "qq",
}
const http = (value: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(value) })

beforeEach(() => {
  jest.resetAllMocks()
  jest
    .mocked(getCredentialsGeneration)
    .mockImplementation(
      jest.requireActual("@/lib/connectors/credentials-events").getCredentialsGeneration
    )
  mockDb = { name: "account-a", sessions: { get: jest.fn() } }
  jest.mocked(fetchAttachment).mockResolvedValue({
    ref: {
      cacheKey: "cached",
      remoteRef: "avatar",
      sizeBytes: 100,
      createdAt: 0,
      lastAccessedAt: 0,
      cached: true,
    },
    cached: true,
  })
  jest.mocked(connectorsAttachmentRead).mockResolvedValue(PNG)
  jest.mocked(connectorsKeyringGet).mockResolvedValue("PRIVATE_TEST_TOKEN")
  jest.mocked(listAdapterInstancesByType).mockResolvedValue([])
  jest
    .mocked(getAdapterInstance)
    .mockImplementation(
      async (adapterId) =>
        ({ type: adapterId.startsWith("adapter-") ? "onebot" : "slack", settings: {} }) as never
    )
})
afterEach(() => {
  jest.restoreAllMocks()
})

it("reads a persisted IM sender without confusing sender and group identity", () => {
  expect(
    messagePlatformAvatarTarget({
      metadata: {
        sessionId: "s",
        platformMessage: {
          sender: {
            platform: "onebot",
            adapterId: "a",
            remoteUserId: "123",
            avatarUrl: "https://q1.qlogo.cn/g?b=qq&nk=123&s=100",
          },
        },
      },
    })
  ).toMatchObject({ kind: "user", remoteId: "123", sessionId: "s" })
  expect(messagePlatformAvatarTarget({ metadata: { platformMessage: {} } })).toBeNull()
})

it("uses structured QQ group/private references and rejects unknown v12 platforms", async () => {
  const group = conversationPlatformAvatarTarget({
    platform: "onebot",
    adapterId: "a",
    conversationKey: "opaque",
    conversationRef: {
      platform: "onebot",
      adapterId: "a",
      messageType: "group",
      groupId: 999,
      userId: 123,
    },
  })
  expect(group).toEqual({
    platform: "onebot",
    adapterId: "a",
    kind: "group",
    remoteId: "999",
    onebotPlatform: "qq",
  })
  const privateTarget = conversationPlatformAvatarTarget({
    platform: "onebot",
    adapterId: "a",
    conversationKey: "opaque",
    conversationRef: {
      platform: "onebot",
      adapterId: "a",
      messageType: "private",
      userId: 123,
      groupId: 999,
    },
  })
  expect(privateTarget).toMatchObject({ kind: "user", remoteId: "123" })
  expect(qqAvatarUrl("123/../456", "user")).toBeUndefined()
  expect(qqAvatarUrl("0", "group")).toBeUndefined()
  expect(
    await resolvePlatformAvatar({ ...target, onebotPlatform: "other-platform" })
  ).toBeUndefined()
  expect(fetchAttachment).not.toHaveBeenCalled()
})

it("keeps group identity for other adapters instead of using the most recent sender", () => {
  expect(
    conversationPlatformAvatarTarget({
      platform: "lark",
      adapterId: "a",
      conversationKey: "opaque",
      conversationRef: { platform: "lark", adapterId: "a", chatId: "oc_group" },
    })
  ).toMatchObject({ kind: "channel", remoteId: "oc_group" })
  expect(
    conversationPlatformAvatarTarget({
      platform: "telegram",
      adapterId: "a",
      conversationKey: "opaque",
      conversationRef: { platform: "telegram", adapterId: "a", chatId: -123 },
    })
  ).toMatchObject({ kind: "group", remoteId: "-123" })
  expect(conversationPlatformAvatarTarget(undefined)).toBeNull()
  expect(
    messagePlatformAvatarTarget({
      metadata: {
        platformMessage: {
          sender: { platform: "telegram", adapterId: "tg", remoteUserId: "-100123" },
        },
      },
    })
  ).toMatchObject({ kind: "channel", remoteId: "-100123" })
})

it("does not treat a QQ Official openid as a native QQ number or read unused credentials", async () => {
  jest.mocked(getAdapterInstance).mockResolvedValue({ type: "qq-official", settings: {} } as never)
  expect(
    await resolvePlatformAvatar({
      platform: "qq-official",
      adapterId: "qq-official",
      kind: "user",
      remoteId: "12345",
    })
  ).toBeUndefined()
  expect(connectorsKeyringGet).not.toHaveBeenCalled()
  expect(fetchAttachment).not.toHaveBeenCalled()
})

it("accepts bounded raster data only", () => {
  expect(inlineAvatarUrl(`data:image/png;base64,${PNG}`)).toBe(`data:image/png;base64,${PNG}`)
  expect(inlineAvatarUrl(`data:image/jpeg;base64,${PNG}`)).toBeUndefined()
  expect(inlineAvatarUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBeUndefined()
  expect(inlineAvatarUrl("javascript:alert(1)")).toBeUndefined()
})

it("loads a historical QQ author using the session's confirmed v11 binding", async () => {
  mockDb.sessions.get.mockResolvedValue({
    platformBinding: { conversationRef: { messageType: "group", groupId: 999 } },
  })
  expect(
    await resolvePlatformAvatar({ ...target, onebotPlatform: undefined, sessionId: "session" })
  ).toBe(`data:image/png;base64,${PNG}`)
  expect(fetchAttachment).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceUrl: "https://q1.qlogo.cn/g?b=qq&nk=12345&s=100",
      ttlMs: AVATAR_TTL_MS,
    })
  )
  expect(await resolvePlatformAvatar({ ...target, kind: "group", remoteId: "999" })).toBe(
    `data:image/png;base64,${PNG}`
  )
  expect(fetchAttachment).toHaveBeenLastCalledWith(
    expect.objectContaining({ sourceUrl: "https://p.qlogo.cn/gh/999/999/100" })
  )
})

it("deduplicates concurrent/repeated lookups and renews the TTL through the native cache", async () => {
  const now = jest.spyOn(Date, "now").mockReturnValue(1000)
  await Promise.all([resolvePlatformAvatar(target), resolvePlatformAvatar(target)])
  await resolvePlatformAvatar(target)
  expect(fetchAttachment).toHaveBeenCalledTimes(1)
  now.mockReturnValue(1000 + AVATAR_TTL_MS + 1)
  await resolvePlatformAvatar(target)
  expect(fetchAttachment).toHaveBeenCalledTimes(2)
})

it("backs off failures without throwing or retaining a permanently failed result", async () => {
  const now = jest.spyOn(Date, "now").mockReturnValue(1000)
  jest.mocked(fetchAttachment).mockRejectedValueOnce(new Error("offline"))
  expect(await resolvePlatformAvatar(target)).toBeUndefined()
  expect(await resolvePlatformAvatar(target)).toBeUndefined()
  expect(fetchAttachment).toHaveBeenCalledTimes(1)
  now.mockReturnValue(1000 + AVATAR_RETRY_MS + 1)
  expect(await resolvePlatformAvatar(target)).toContain("data:image/png")
})

it("does not share portraits across adapter or active-account boundaries", async () => {
  await resolvePlatformAvatar(target)
  await resolvePlatformAvatar({ ...target, adapterId: "adapter-b" })
  mockDb = { name: "account-b", sessions: { get: jest.fn() } }
  await resolvePlatformAvatar(target)
  expect(fetchAttachment).toHaveBeenCalledTimes(3)
  expect(jest.mocked(fetchAttachment).mock.calls.map(([input]) => input.remoteRef)).toEqual(
    expect.arrayContaining([
      expect.stringContaining("account-a"),
      expect.stringContaining("account-b"),
    ])
  )
})

it("invalidates memory and native cache identity when credentials/config change", async () => {
  jest
    .mocked(getAdapterInstance)
    .mockResolvedValue({ type: "slack", settings: { homeserver: "old" } } as never)
  jest.mocked(connectorsHttpRequest).mockResolvedValue(
    http({
      ok: true,
      user: { profile: { image_192: "https://avatars.slack-edge.com/user.png" } },
    })
  )
  const peer: PlatformAvatarTarget = {
    platform: "slack",
    adapterId: "sl-rotate",
    kind: "user",
    remoteId: "U1",
  }
  await resolvePlatformAvatar(peer)
  emitCredentialsRotated(peer.adapterId)
  await resolvePlatformAvatar(peer)
  jest
    .mocked(getAdapterInstance)
    .mockResolvedValue({ type: "slack", settings: { homeserver: "new" } } as never)
  await resolvePlatformAvatar(peer)
  expect(fetchAttachment).toHaveBeenCalledTimes(3)
  expect(
    new Set(jest.mocked(fetchAttachment).mock.calls.map(([input]) => input.remoteRef)).size
  ).toBe(3)
  jest.mocked(getAdapterInstance).mockResolvedValue(undefined)
  expect(await resolvePlatformAvatar(peer)).toBeUndefined()
  expect(fetchAttachment).toHaveBeenCalledTimes(3)
})

it("drops a result after an account switch and rejects oversized or nonimage bytes", async () => {
  jest.mocked(fetchAttachment).mockImplementationOnce(async () => {
    mockDb = { name: "new-account", sessions: { get: jest.fn() } }
    return { ref: { sizeBytes: 100 } } as never
  })
  expect(await resolvePlatformAvatar(target)).toBeUndefined()
  expect(connectorsAttachmentRead).not.toHaveBeenCalled()
  jest.mocked(fetchAttachment).mockResolvedValueOnce({ ref: { sizeBytes: 900000 } } as never)
  expect(await resolvePlatformAvatar(target)).toBeUndefined()
  mockDb = { name: "third-account", sessions: { get: jest.fn() } }
  jest.mocked(connectorsAttachmentRead).mockResolvedValueOnce(btoa("<html>not an image</html>"))
  expect(await resolvePlatformAvatar(target)).toBeUndefined()
})

it("never sends a bearer token to a supplied image host", async () => {
  const remote = {
    ...target,
    platform: "slack" as const,
    avatarUrl: "https://avatars.slack-edge.com/portrait.png",
  }
  expect(await resolvePlatformAvatar(remote)).toContain("data:image/png")
  expect(fetchAttachment).toHaveBeenCalledWith(expect.objectContaining({ headers: undefined }))
  expect(connectorsKeyringGet).not.toHaveBeenCalled()
  mockDb = { name: "new-account", sessions: { get: jest.fn() } }
  expect(
    await resolvePlatformAvatar({
      ...target,
      avatarUrl: "https://127.0.0.1/private",
      onebotPlatform: "other",
    })
  ).toBeUndefined()
  expect(fetchAttachment).toHaveBeenCalledTimes(1)
})

it("resolves Slack user portraits with bot credentials only on the official API", async () => {
  jest.mocked(connectorsHttpRequest).mockResolvedValue(
    http({
      ok: true,
      user: { profile: { image_192: "https://avatars.slack-edge.com/user.png" } },
    })
  )
  expect(
    await resolvePlatformAvatar({
      platform: "slack",
      adapterId: "slack",
      kind: "user",
      remoteId: "U123",
    })
  ).toContain("data:image/png")
  expect(connectorsHttpRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      url: "https://slack.com/api/users.info?user=U123",
      headers: { Authorization: "Bearer PRIVATE_TEST_TOKEN", "X-Cognia-Avatar-Policy": "1" },
    })
  )
  expect(fetchAttachment).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceUrl: "https://avatars.slack-edge.com/user.png",
      headers: undefined,
    })
  )
})

it("keeps Telegram token-bearing URLs inside the native cache boundary", async () => {
  jest.mocked(getAdapterInstance).mockResolvedValue({ type: "telegram", settings: {} } as never)
  jest
    .mocked(connectorsHttpRequest)
    .mockResolvedValueOnce(http({ ok: true, result: { photos: [[{ file_id: "photo_id" }]] } }))
    .mockResolvedValueOnce(http({ ok: true, result: { file_path: "photos/avatar.jpg" } }))
  const result = await resolvePlatformAvatar({
    platform: "telegram",
    adapterId: "tg",
    kind: "user",
    remoteId: "123",
  })
  expect(result).toContain("data:image/png")
  expect(result).not.toContain("PRIVATE_TEST_TOKEN")
  const input = jest.mocked(fetchAttachment).mock.calls[0][0]
  expect(input.sourceUrl).toBe(
    "https://api.telegram.org/file/botPRIVATE_TEST_TOKEN/photos/avatar.jpg"
  )
  expect(input.remoteRef).not.toContain("PRIVATE_TEST_TOKEN")
})

it("resolves Discord avatars from a validated native avatar hash", async () => {
  jest.mocked(getAdapterInstance).mockResolvedValue({ type: "discord", settings: {} } as never)
  jest.mocked(connectorsHttpRequest).mockResolvedValue(http({ id: "123", avatar: "a_abcd1234" }))
  expect(
    await resolvePlatformAvatar({
      platform: "discord",
      adapterId: "dc",
      kind: "user",
      remoteId: "123",
    })
  ).toContain("data:image/png")
  expect(fetchAttachment).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceUrl: "https://cdn.discordapp.com/avatars/123/a_abcd1234.png?size=128",
      headers: undefined,
    })
  )
})

it("uses Lark tenant auth for profiles and honors a missing avatar/scope", async () => {
  const { larkTenantRequest } = await import("@/lib/connectors/adapters/lark/http")
  jest.mocked(getAdapterInstance).mockResolvedValue({ type: "lark", settings: {} } as never)
  jest
    .mocked(connectorsKeyringGet)
    .mockImplementation(async (_adapterId, name) =>
      name === "appId" ? "app" : "PRIVATE_TEST_TOKEN"
    )
  jest.mocked(larkTenantRequest).mockResolvedValueOnce({
    data: { user: { avatar: { avatar_240: "https://cdn.feishucdn.com/avatar.png" } } },
  })
  expect(
    await resolvePlatformAvatar({
      platform: "lark",
      adapterId: "lk",
      kind: "user",
      remoteId: "ou_1",
    })
  ).toContain("data:image/png")
  expect(larkTenantRequest).toHaveBeenCalledWith(
    { appId: "app", appSecret: "PRIVATE_TEST_TOKEN" },
    "GET",
    "/contact/v3/users/ou_1?user_id_type=open_id",
    undefined,
    { avatarPolicy: true }
  )
  jest.mocked(larkTenantRequest).mockRejectedValueOnce(new Error("missing scope"))
  expect(
    await resolvePlatformAvatar({
      platform: "lark",
      adapterId: "lk",
      kind: "user",
      remoteId: "ou_2",
    })
  ).toBeUndefined()
})

it("loads Telegram group pictures without substituting a group member", async () => {
  jest.mocked(getAdapterInstance).mockResolvedValue({ type: "telegram", settings: {} } as never)
  jest
    .mocked(connectorsHttpRequest)
    .mockResolvedValueOnce(http({ ok: true, result: { photo: { small_file_id: "group-photo" } } }))
    .mockResolvedValueOnce(http({ ok: true, result: { file_path: "photos/group.jpg" } }))
  expect(
    await resolvePlatformAvatar({
      platform: "telegram",
      adapterId: "tg",
      kind: "group",
      remoteId: "-123",
    })
  ).toContain("data:image/png")
  expect(connectorsHttpRequest).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      url: "https://api.telegram.org/botPRIVATE_TEST_TOKEN/getChat?chat_id=-123",
    })
  )
})

it("looks up a Slack DM peer and retains the placeholder for channels without an avatar", async () => {
  jest
    .mocked(connectorsHttpRequest)
    .mockResolvedValueOnce(http({ ok: true, channel: { is_im: true, user: "U_PEER" } }))
    .mockResolvedValueOnce(
      http({
        ok: true,
        user: { profile: { image_192: "https://avatars.slack-edge.com/peer.png" } },
      })
    )
  expect(
    await resolvePlatformAvatar({
      platform: "slack",
      adapterId: "sl",
      kind: "channel",
      remoteId: "D_DM",
    })
  ).toContain("data:image/png")
  expect(connectorsHttpRequest).toHaveBeenLastCalledWith(
    expect.objectContaining({ url: "https://slack.com/api/users.info?user=U_PEER" })
  )
  jest
    .mocked(connectorsHttpRequest)
    .mockResolvedValueOnce(http({ ok: true, channel: { is_im: false } }))
  expect(
    await resolvePlatformAvatar({
      platform: "slack",
      adapterId: "sl",
      kind: "channel",
      remoteId: "C_GROUP",
    })
  ).toBeUndefined()
})

it("retrieves Lark group avatars from chat details", async () => {
  const { larkTenantRequest } = await import("@/lib/connectors/adapters/lark/http")
  jest.mocked(getAdapterInstance).mockResolvedValue({ type: "lark", settings: {} } as never)
  jest
    .mocked(connectorsKeyringGet)
    .mockImplementation(async (_adapterId, name) =>
      name === "appId" ? "app" : "PRIVATE_TEST_TOKEN"
    )
  jest
    .mocked(larkTenantRequest)
    .mockResolvedValue({ data: { avatar: "https://cdn.feishucdn.com/group.png" } })
  expect(
    await resolvePlatformAvatar({
      platform: "lark",
      adapterId: "lk",
      kind: "channel",
      remoteId: "oc_group",
    })
  ).toContain("data:image/png")
  expect(larkTenantRequest).toHaveBeenCalledWith(
    expect.anything(),
    "GET",
    "/im/v1/chats/oc_group",
    undefined,
    { avatarPolicy: true }
  )
})

it("keeps Matrix media authentication on the configured homeserver", async () => {
  jest.mocked(getAdapterInstance).mockResolvedValue({
    type: "matrix",
    settings: { homeserver: "https://matrix.example.com" },
  } as never)
  jest
    .mocked(connectorsHttpRequest)
    .mockResolvedValue(http({ avatar_url: "mxc://remote.example.org/media-id" }))
  expect(
    await resolvePlatformAvatar({
      platform: "matrix",
      adapterId: "mx",
      kind: "user",
      remoteId: "@peer:example.org",
    })
  ).toContain("data:image/png")
  expect(fetchAttachment).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceUrl:
        "https://matrix.example.com/_matrix/client/v1/media/download/remote.example.org/media-id",
      headers: { Authorization: "Bearer PRIVATE_TEST_TOKEN" },
    })
  )
})

it("does not reuse a pre-rotation native portrait after renderer generations reset", async () => {
  jest.mocked(getCredentialsGeneration).mockReturnValue("0")
  jest
    .mocked(connectorsHttpRequest)
    .mockResolvedValueOnce(
      http({ ok: true, user: { profile: { image_192: "https://avatars.slack-edge.com/old.png" } } })
    )
    .mockResolvedValueOnce(
      http({ ok: true, user: { profile: { image_192: "https://avatars.slack-edge.com/new.png" } } })
    )
  const peer: PlatformAvatarTarget = {
    platform: "slack",
    adapterId: "sl-reload",
    kind: "user",
    remoteId: "U1",
  }
  await resolvePlatformAvatar(peer)
  emitCredentialsRotated(peer.adapterId)
  mockDb = { name: "account-a", sessions: { get: jest.fn() } }
  await resolvePlatformAvatar(peer)
  const refs = jest.mocked(fetchAttachment).mock.calls.map(([input]) => input.remoteRef)
  expect(refs).toHaveLength(2)
  expect(refs[0]).not.toBe(refs[1])
  expect(refs.every((ref) => !ref.includes("PRIVATE_TEST_TOKEN"))).toBe(true)
})

it("retains the adapter-reported bot identity namespace", () => {
  expect(
    messagePlatformAvatarTarget({
      metadata: {
        sessionId: "s",
        platformMessage: {
          sender: {
            platform: "lark",
            adapterId: "lk",
            remoteUserId: "cli_other",
            remoteIdType: "app_id",
            kind: "bot",
          },
        },
      },
    })
  ).toMatchObject({ actorKind: "bot", remoteIdType: "app_id", remoteId: "cli_other" })
})

it("separates DingTalk staff identity and QQ channel identity from opaque conversation IDs", () => {
  expect(
    conversationPlatformAvatarTarget({
      platform: "dingtalk",
      adapterId: "dt",
      conversationKey: "opaque",
      conversationRef: {
        platform: "dingtalk",
        adapterId: "dt",
        conversationType: "1",
        userId: "staff",
        openConversationId: "cid",
      },
    })
  ).toMatchObject({ kind: "user", remoteId: "staff", remoteIdType: "staff_id" })
  expect(
    conversationPlatformAvatarTarget({
      platform: "qq-official",
      adapterId: "qq",
      conversationKey: "opaque",
      conversationRef: {
        platform: "qq-official",
        adapterId: "qq",
        scene: "direct",
        sceneId: "dms-guild",
      },
    })
  ).toBeNull()
})

it("uses the self-bot endpoint for a confirmed Feishu app instead of contact users", async () => {
  const { larkTenantRequest } = await import("@/lib/connectors/adapters/lark/http")
  jest.mocked(getAdapterInstance).mockResolvedValue({ type: "lark", settings: {} } as never)
  jest
    .mocked(connectorsKeyringGet)
    .mockImplementation(async (_id, name) => (name === "appId" ? "cli_self" : "PRIVATE_TEST_TOKEN"))
  jest.mocked(larkTenantRequest).mockResolvedValue({
    bot: { open_id: "ou_self", avatar_url: "https://cdn.feishucdn.com/self.png" },
  })
  expect(
    await resolvePlatformAvatar({
      platform: "lark",
      adapterId: "lk",
      kind: "user",
      remoteId: "cli_self",
      remoteIdType: "app_id",
      actorKind: "bot",
    })
  ).toContain("data:image/png")
  expect(larkTenantRequest).toHaveBeenCalledWith(
    expect.anything(),
    "GET",
    "/bot/v3/info",
    undefined,
    { avatarPolicy: true }
  )
  expect(
    jest.mocked(larkTenantRequest).mock.calls.some((call) => call[2].startsWith("/contact/"))
  ).toBe(false)
})

it("queries another app with its explicit app_id and required language parameter", async () => {
  const { larkTenantRequest } = await import("@/lib/connectors/adapters/lark/http")
  jest.mocked(getAdapterInstance).mockResolvedValue({ type: "lark", settings: {} } as never)
  jest
    .mocked(connectorsKeyringGet)
    .mockImplementation(async (_id, name) => (name === "appId" ? "cli_self" : "PRIVATE_TEST_TOKEN"))
  jest.mocked(larkTenantRequest).mockResolvedValue({
    data: { app: { avatar_url: "https://sf1-ttcdn-tos.pstatp.com/img/avatar/app.jpg" } },
  })
  expect(
    await resolvePlatformAvatar({
      platform: "lark",
      adapterId: "lk",
      kind: "user",
      remoteId: "cli_other",
      remoteIdType: "app_id",
      actorKind: "bot",
    })
  ).toContain("data:image/png")
  expect(larkTenantRequest).toHaveBeenCalledWith(
    expect.anything(),
    "GET",
    "/application/v6/applications/cli_other?lang=zh_cn",
    undefined,
    { avatarPolicy: true }
  )
})

it("never substitutes this app's picture for an unknown bot open_id", async () => {
  const { larkTenantRequest } = await import("@/lib/connectors/adapters/lark/http")
  jest.mocked(getAdapterInstance).mockResolvedValue({ type: "lark", settings: {} } as never)
  jest
    .mocked(connectorsKeyringGet)
    .mockImplementation(async (_id, name) => (name === "appId" ? "cli_self" : "PRIVATE_TEST_TOKEN"))
  jest.mocked(larkTenantRequest).mockResolvedValue({
    bot: { open_id: "ou_self", avatar_url: "https://cdn.feishucdn.com/self.png" },
  })
  expect(
    await resolvePlatformAvatar({
      platform: "lark",
      adapterId: "lk",
      kind: "user",
      remoteId: "ou_other",
      remoteIdType: "open_id",
      actorKind: "bot",
    })
  ).toBeUndefined()
  expect(fetchAttachment).not.toHaveBeenCalled()
  expect(larkTenantRequest).toHaveBeenCalledTimes(1)
  expect(jest.mocked(larkTenantRequest).mock.calls[0][2]).toBe("/bot/v3/info")
})

it("matches a configured sibling bot only to its confirmed stored app identity", async () => {
  jest.mocked(getAdapterInstance).mockResolvedValue({ type: "lark", settings: {} } as never)
  jest
    .mocked(connectorsKeyringGet)
    .mockImplementation(async (id, name) =>
      name === "appId" ? (id === "sibling" ? "cli_sibling" : "cli_self") : "PRIVATE_TEST_TOKEN"
    )
  jest.mocked(listAdapterInstancesByType).mockResolvedValue([
    {
      id: "sibling",
      type: "lark",
      lastWhoamiResult: {
        appId: "cli_sibling",
        openId: "ou_sibling",
        botName: "Other",
        botAvatar: "https://cdn.feishucdn.com/sibling.png",
      },
    },
  ] as never)
  expect(
    await resolvePlatformAvatar({
      platform: "lark",
      adapterId: "lk",
      kind: "user",
      remoteId: "ou_sibling",
      remoteIdType: "open_id",
      actorKind: "bot",
    })
  ).toContain("data:image/png")
  expect(fetchAttachment).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceUrl: "https://cdn.feishucdn.com/sibling.png",
      headers: undefined,
    })
  )
})

it("rejects a sibling's stale bot identity after its keyring app ID rotates", async () => {
  const { larkTenantRequest } = await import("@/lib/connectors/adapters/lark/http")
  jest.mocked(getAdapterInstance).mockResolvedValue({ type: "lark", settings: {} } as never)
  jest
    .mocked(connectorsKeyringGet)
    .mockImplementation(async (id, name) =>
      name === "appId" ? (id === "sibling" ? "cli_rotated" : "cli_self") : "PRIVATE_TEST_TOKEN"
    )
  jest.mocked(listAdapterInstancesByType).mockResolvedValue([
    {
      id: "sibling",
      type: "lark",
      lastWhoamiResult: {
        appId: "cli_sibling",
        openId: "ou_sibling",
        botName: "Other",
        botAvatar: "https://cdn.feishucdn.com/stale.png",
      },
    },
  ] as never)
  jest.mocked(larkTenantRequest).mockResolvedValue({
    bot: { open_id: "ou_self", avatar_url: "https://cdn.feishucdn.com/self.png" },
  })
  expect(
    await resolvePlatformAvatar({
      platform: "lark",
      adapterId: "lk",
      kind: "user",
      remoteId: "ou_sibling",
      remoteIdType: "open_id",
      actorKind: "bot",
    })
  ).toBeUndefined()
  expect(fetchAttachment).not.toHaveBeenCalled()
  expect(jest.mocked(larkTenantRequest).mock.calls.map((call) => call[2])).toEqual(["/bot/v3/info"])
})

it("accepts a public image origin granted by an authenticated profile without forwarding credentials", async () => {
  jest.mocked(connectorsHttpRequest).mockResolvedValue(
    http({
      ok: true,
      user: { profile: { image_192: "https://custom-provider-cdn.example/user.png" } },
    })
  )
  expect(
    await resolvePlatformAvatar({
      platform: "slack",
      adapterId: "sl",
      kind: "user",
      remoteId: "U1",
    })
  ).toContain("data:image/png")
  expect(fetchAttachment).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceUrl: "https://custom-provider-cdn.example/user.png",
      headers: undefined,
    })
  )
})

it("does not reuse one Discord user's member portrait across guild scopes", async () => {
  jest.mocked(getAdapterInstance).mockResolvedValue({ type: "discord", settings: {} } as never)
  mockDb.sessions.get
    .mockResolvedValueOnce({
      platformBinding: {
        platform: "discord",
        adapterId: "dc",
        conversationRef: { guildId: "456" },
      },
    })
    .mockResolvedValueOnce({
      platformBinding: {
        platform: "discord",
        adapterId: "dc",
        conversationRef: { guildId: "789" },
      },
    })
  jest
    .mocked(connectorsHttpRequest)
    .mockResolvedValue(http({ user: { id: "123", avatar: null }, avatar: "abcd" }))
  const peer: PlatformAvatarTarget = {
    platform: "discord",
    adapterId: "dc",
    kind: "user",
    remoteId: "123",
    sessionId: "s1",
  }
  await resolvePlatformAvatar(peer)
  await resolvePlatformAvatar({ ...peer, sessionId: "s2" })
  const inputs = jest.mocked(fetchAttachment).mock.calls.map(([input]) => input)
  expect(inputs.map((i) => i.sourceUrl)).toEqual([
    "https://cdn.discordapp.com/guilds/456/users/123/avatars/abcd.png?size=128",
    "https://cdn.discordapp.com/guilds/789/users/123/avatars/abcd.png?size=128",
  ])
  expect(inputs[0].remoteRef).not.toBe(inputs[1].remoteRef)
})

it("uses the official default Discord avatar after a member lookup is unavailable", async () => {
  jest.mocked(getAdapterInstance).mockResolvedValue({ type: "discord", settings: {} } as never)
  mockDb.sessions.get.mockResolvedValue({
    platformBinding: { platform: "discord", adapterId: "dc", conversationRef: { guildId: "456" } },
  })
  jest
    .mocked(connectorsHttpRequest)
    .mockResolvedValueOnce({ status: 403, headers: {}, body: "{}" })
    .mockResolvedValueOnce(http({ id: "123", avatar: null, discriminator: "1337" }))
  expect(
    await resolvePlatformAvatar({
      platform: "discord",
      adapterId: "dc",
      kind: "user",
      remoteId: "123",
      sessionId: "s",
    })
  ).toContain("data:image/png")
  expect(fetchAttachment).toHaveBeenCalledWith(
    expect.objectContaining({ sourceUrl: "https://cdn.discordapp.com/embed/avatars/2.png" })
  )
})

it("reads a Matrix room member avatar before its global profile", async () => {
  jest.mocked(getAdapterInstance).mockResolvedValue({
    type: "matrix",
    settings: { homeserver: "https://matrix.example" },
  } as never)
  mockDb.sessions.get.mockResolvedValue({
    platformBinding: {
      platform: "matrix",
      adapterId: "mx",
      conversationRef: { roomId: "!room:example" },
    },
  })
  jest
    .mocked(connectorsHttpRequest)
    .mockResolvedValue(http({ avatar_url: "mxc://matrix.example/roomAvatar" }))
  expect(
    await resolvePlatformAvatar({
      platform: "matrix",
      adapterId: "mx",
      kind: "user",
      remoteId: "@peer:example",
      sessionId: "s",
    })
  ).toContain("data:image/png")
  expect(connectorsHttpRequest).toHaveBeenCalledTimes(1)
  expect(jest.mocked(connectorsHttpRequest).mock.calls[0][0].url).toContain(
    "/state/m.room.member/%40peer%3Aexample"
  )
})

it("queries a real DingTalk staff id with the existing app grant and keeps its token out of image data", async () => {
  const { getDingTalkAccessToken } = await import("@/lib/connectors/adapters/dingtalk/auth")
  jest.mocked(getAdapterInstance).mockResolvedValue({ type: "dingtalk", settings: {} } as never)
  jest.mocked(getDingTalkAccessToken).mockResolvedValue("PRIVATE_APP_TOKEN")
  jest
    .mocked(connectorsHttpRequest)
    .mockResolvedValue(http({ errcode: 0, result: { avatar: "https://cdn.alicdn.com/user.png" } }))
  expect(
    await resolvePlatformAvatar({
      platform: "dingtalk",
      adapterId: "dt",
      kind: "user",
      remoteId: "staff",
      remoteIdType: "staff_id",
    })
  ).toContain("data:image/png")
  expect(connectorsHttpRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ userid: "staff" }),
      headers: { "Content-Type": "application/json", "X-Cognia-Avatar-Policy": "1" },
    })
  )
  const input = jest.mocked(fetchAttachment).mock.calls[0][0]
  expect(input.sourceUrl).not.toContain("PRIVATE_APP_TOKEN")
  expect(input.remoteRef).not.toContain("PRIVATE_APP_TOKEN")
  expect(input.headers).toBeUndefined()
})

it("does not send an opaque DingTalk sender id to the employee API", async () => {
  jest.mocked(getAdapterInstance).mockResolvedValue({ type: "dingtalk", settings: {} } as never)
  expect(
    await resolvePlatformAvatar({
      platform: "dingtalk",
      adapterId: "dt",
      kind: "user",
      remoteId: "$:LWCP_v1:$opaque",
      remoteIdType: "opaque_id",
    })
  ).toBeUndefined()
  expect(connectorsKeyringGet).not.toHaveBeenCalled()
  expect(connectorsHttpRequest).not.toHaveBeenCalled()
})

it("keeps no-photo DingTalk employees on fallback", async () => {
  const { getDingTalkAccessToken } = await import("@/lib/connectors/adapters/dingtalk/auth")
  jest.mocked(getAdapterInstance).mockResolvedValue({ type: "dingtalk", settings: {} } as never)
  jest.mocked(getDingTalkAccessToken).mockResolvedValue("PRIVATE_APP_TOKEN")
  jest.mocked(connectorsHttpRequest).mockResolvedValue(http({ errcode: 0, result: {} }))
  expect(
    await resolvePlatformAvatar({
      platform: "dingtalk",
      adapterId: "dt",
      kind: "user",
      remoteId: "staff",
      remoteIdType: "staff_id",
    })
  ).toBeUndefined()
  expect(fetchAttachment).not.toHaveBeenCalled()
})

it("retains official QQ channel portraits without interpreting the opaque user as a UIN", async () => {
  jest.mocked(getAdapterInstance).mockResolvedValue({ type: "qq-official", settings: {} } as never)
  expect(
    await resolvePlatformAvatar({
      platform: "qq-official",
      adapterId: "qq",
      kind: "user",
      remoteId: "opaque",
      avatarUrl: "https://qqchannel-profile-1251316161.file.myqcloud.com/user.png",
    })
  ).toContain("data:image/png")
  expect(connectorsKeyringGet).not.toHaveBeenCalled()
})

it("uses QQ channel metadata for the server portrait and strips API auth from the image download", async () => {
  const { getQQAccessToken } = await import("@/lib/connectors/adapters/qq-official/auth")
  jest.mocked(getAdapterInstance).mockResolvedValue({ type: "qq-official", settings: {} } as never)
  jest.mocked(getQQAccessToken).mockResolvedValue("PRIVATE_APP_TOKEN")
  jest
    .mocked(connectorsHttpRequest)
    .mockResolvedValueOnce(http({ guild_id: "guild" }))
    .mockResolvedValueOnce(http({ icon: "https://official-qq-cdn.example/guild.png" }))
  expect(
    await resolvePlatformAvatar({
      platform: "qq-official",
      adapterId: "qq",
      kind: "channel",
      remoteId: "channel",
    })
  ).toContain("data:image/png")
  expect(fetchAttachment).toHaveBeenCalledWith(
    expect.objectContaining({
      headers: undefined,
      sourceUrl: "https://official-qq-cdn.example/guild.png",
    })
  )
})

it.each(["wecom", "wechat-oa", "wechat-personal"] as const)(
  "keeps %s fallback without inventing a profile API",
  async (platform) => {
    jest.mocked(getAdapterInstance).mockResolvedValue({ type: platform, settings: {} } as never)
    expect(
      await resolvePlatformAvatar({
        platform,
        adapterId: "unsupported",
        kind: "user",
        remoteId: "opaque",
      })
    ).toBeUndefined()
    expect(connectorsKeyringGet).not.toHaveBeenCalled()
    expect(connectorsHttpRequest).not.toHaveBeenCalled()
  }
)

it("resolves a Discord partial member before accepting its supplied global fallback", async () => {
  const { parseDiscordDispatch } = await import("@/lib/connectors/adapters/discord/parse")
  const event = parseDiscordDispatch("dc", "999", {
    op: 0,
    t: "MESSAGE_CREATE",
    d: {
      id: "m",
      channel_id: "channel",
      guild_id: "456",
      author: { id: "123", username: "Peer", avatar: "abcd" },
      content: "hello",
      timestamp: "2026-10-26T00:00:00Z",
      mentions: [],
      attachments: [],
    },
  })!
  expect(event.sender.avatarUrl).toBeUndefined()
  jest.mocked(getAdapterInstance).mockResolvedValue({ type: "discord", settings: {} } as never)
  mockDb.sessions.get.mockResolvedValue({
    platformBinding: {
      platform: "discord",
      adapterId: "dc",
      conversationRef: event.conversationRef,
    },
  })
  jest
    .mocked(connectorsHttpRequest)
    .mockResolvedValue(http({ user: { id: "123", avatar: "abcd" }, avatar: "beef" }))
  const target = messagePlatformAvatarTarget({
    metadata: { sessionId: "s", platformMessage: { sender: event.sender } },
  })!
  expect(await resolvePlatformAvatar(target)).toContain("data:image/png")
  expect(fetchAttachment).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceUrl: "https://cdn.discordapp.com/guilds/456/users/123/avatars/beef.png?size=128",
    })
  )
})
