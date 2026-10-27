/** Display-only IM portraits. Provider credentials and URLs stay out of the DOM and prompts. */
import type { PlatformBinding } from "@/types/connectors/binding"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { evaluateFetchTarget } from "@cognia/network-guard"
import { getDb } from "@/lib/db/schema"
import { getAdapterInstance, listAdapterInstancesByType } from "@/lib/db/adapter-instances"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { getCredentialsGeneration } from "@/lib/connectors/credentials-events"
import { fetchAttachment } from "@/lib/connectors/attachment-fetcher"
import {
  connectorsAttachmentRead,
  connectorsHttpRequest,
  connectorsKeyringGet,
} from "@/lib/connectors/tauri/commands"
import { sniffImageMediaType } from "@/lib/connectors/adapters/_shared/inbound-media"
import { discordAvatarUrl } from "@/lib/connectors/adapters/discord/avatar"

export const AVATAR_TTL_MS = 6 * 60 * 60 * 1000
export const AVATAR_RETRY_MS = 5 * 60 * 1000
const MAX_AVATAR_BYTES = 512 * 1024
const MAX_CACHE_ENTRIES = 64

export interface PlatformAvatarTarget {
  platform: PlatformKind
  adapterId: string
  kind: "user" | "group" | "channel"
  remoteId: string
  remoteIdType?: string
  actorKind?: "bot"
  avatarUrl?: string
  sessionId?: string
  onebotPlatform?: string
  configKey?: string
  credentialGeneration?: string
}

export function avatarConfigKey(adapter: AdapterInstanceRow): string {
  return JSON.stringify([
    adapter.type,
    adapter.settings?.homeserver ?? "",
    adapter.settings?.appId ?? "",
  ])
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}
function id(value: unknown): string | undefined {
  return (
    str(value) ??
    (typeof value === "number" && Number.isSafeInteger(value) ? String(value) : undefined)
  )
}

export function messagePlatformAvatarTarget(message: {
  metadata?: unknown
}): PlatformAvatarTarget | null {
  const meta = record(message.metadata)
  const platformMessage = record(meta?.platformMessage)
  const sender = record(platformMessage?.sender)
  const platform = str(sender?.platform) ?? str(platformMessage?.platform)
  const adapterId = str(sender?.adapterId) ?? str(platformMessage?.adapterId)
  const remoteId = id(sender?.remoteUserId)
  if (!platform || !adapterId || !remoteId) return null
  return {
    platform: platform as PlatformKind,
    adapterId,
    kind: platform === "telegram" && remoteId.startsWith("-") ? "channel" : "user",
    remoteId,
    ...(str(sender?.remoteIdType) ? { remoteIdType: str(sender?.remoteIdType) } : {}),
    ...(sender?.kind === "bot" ? { actorKind: "bot" as const } : {}),
    ...(str(sender?.avatarUrl) ? { avatarUrl: str(sender?.avatarUrl) } : {}),
    ...(str(meta?.sessionId) ? { sessionId: str(meta?.sessionId) } : {}),
  }
}

/** Old bindings predate deliveryTarget; read their adapter-owned structured reference, never the key. */
export function conversationPlatformAvatarTarget(
  binding: PlatformBinding | undefined
): PlatformAvatarTarget | null {
  if (!binding) return null
  const ref = record(binding.conversationRef) ?? {}
  const address = binding.deliveryTarget?.address
  const base = { platform: binding.platform, adapterId: binding.adapterId }
  if (binding.platform === "onebot") {
    const detail = str(ref.messageType) ?? str(ref.detailType)
    const self = record(ref.self)
    const onebotPlatform = str(self?.platform) ?? (ref.messageType ? "qq" : undefined)
    const kind = detail === "private" ? "user" : detail === "group" ? "group" : null
    const remoteId = kind === "user" ? id(ref.userId) : id(ref.groupId)
    return kind && remoteId ? { ...base, kind, remoteId, onebotPlatform } : null
  }
  if (binding.platform === "dingtalk") {
    const remoteId = id(ref.userId)
    return String(ref.conversationType) === "1" && remoteId
      ? { ...base, kind: "user", remoteId, remoteIdType: "staff_id" }
      : null
  }
  if (binding.platform === "qq-official") {
    const remoteId = id(ref.sceneId)
    return ref.scene === "channel" && remoteId ? { ...base, kind: "channel", remoteId } : null
  }
  const remoteId = address?.containerId ?? id(ref.chatId) ?? id(ref.channelId) ?? id(ref.roomId)
  if (!remoteId) return null
  const kind =
    binding.platform === "telegram"
      ? remoteId.startsWith("-")
        ? "group"
        : "user"
      : address?.scopeKind === "private" &&
          binding.platform !== "lark" &&
          binding.platform !== "slack" &&
          binding.platform !== "discord"
        ? "user"
        : "channel"
  return { ...base, kind, remoteId }
}

export function inlineAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > (MAX_AVATAR_BYTES * 4) / 3 + 100) return undefined
  const match = /^data:(image\/(?:png|jpeg|gif|webp|bmp));base64,([A-Za-z0-9+/=]+)$/.exec(value)
  return match && sniffImageMediaType(match[2]) === match[1] ? value : undefined
}

export function qqAvatarUrl(remoteId: string, kind: "user" | "group"): string | undefined {
  if (!/^[1-9]\d{0,19}$/.test(remoteId)) return undefined
  return kind === "group"
    ? `https://p.qlogo.cn/gh/${remoteId}/${remoteId}/100`
    : `https://q1.qlogo.cn/g?b=qq&nk=${remoteId}&s=100`
}

const AVATAR_HOSTS: Partial<Record<PlatformKind, readonly string[]>> = {
  onebot: ["qlogo.cn"],
  "qq-official": ["qlogo.cn", "qqchannel-profile-1251316161.file.myqcloud.com"],
  discord: ["cdn.discordapp.com", "media.discordapp.net"],
  slack: ["slack-edge.com", "secure.gravatar.com"],
  lark: [
    "feishucdn.com",
    "larksuitecdn.com",
    "byteimg.com",
    "feishu.cn",
    "sf1-ttcdn-tos.pstatp.com",
  ],
  wecom: ["qpic.cn", "qlogo.cn"],
  "wechat-personal": ["qpic.cn", "qlogo.cn"],
  "wechat-oa": ["qpic.cn", "qlogo.cn"],
  dingtalk: ["dingtalk.com", "alicdn.com"],
}
function publicUrl(
  platform: PlatformKind,
  value: unknown,
  providerResponse = false
): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined
  try {
    const url = new URL(value)
    const trusted = AVATAR_HOSTS[platform]?.some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`)
    )
    if (
      (!trusted && !providerResponse) ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !evaluateFetchTarget(value).allowed
    )
      return undefined
    return url.href
  } catch {
    return undefined
  }
}

interface AvatarSource {
  url: string
  headers?: Record<string, string>
  revision?: string
}
async function jsonRequest(
  url: string,
  headers?: Record<string, string>,
  body?: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const response = await connectorsHttpRequest({
    url,
    method: body ? "POST" : "GET",
    headers: { ...headers, "X-Cognia-Avatar-Policy": "1" },
    timeoutMs: 8000,
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (response.status < 200 || response.status >= 300) return undefined
  return record(JSON.parse(response.body))
}
function discordUrl(
  user: Record<string, unknown>,
  member?: Record<string, unknown>,
  guildId?: string
): string | undefined {
  const userId = id(user.id)
  return userId
    ? discordAvatarUrl(
        {
          id: userId,
          avatar: user.avatar === null ? null : str(user.avatar),
          discriminator: str(user.discriminator),
        },
        { avatar: member?.avatar === null ? null : str(member?.avatar) },
        guildId
      )
    : undefined
}

async function resolveSource(
  target: PlatformAvatarTarget,
  database: ReturnType<typeof getDb>,
  adapter: AdapterInstanceRow
): Promise<AvatarSource | undefined> {
  const active = () =>
    getDb() === database &&
    getCredentialsGeneration(target.adapterId) === target.credentialGeneration
  const request = async (
    url: string,
    headers?: Record<string, string>,
    body?: Record<string, unknown>
  ) => {
    if (!active()) return undefined
    const result = await jsonRequest(url, headers, body)
    return active() ? result : undefined
  }
  const conversationRef = async () => {
    if (!target.sessionId || !active()) return undefined
    const binding = (await database.sessions.get(target.sessionId))?.platformBinding
    return binding?.platform === target.platform && binding.adapterId === target.adapterId
      ? record(binding.conversationRef)
      : undefined
  }
  const provided = publicUrl(target.platform, target.avatarUrl)
  if (provided) return { url: provided }
  const { platform, adapterId, kind, remoteId } = target
  if (platform === "onebot") {
    let upstream = target.onebotPlatform
    if (!upstream && target.sessionId) {
      const session = await database.sessions.get(target.sessionId)
      const ref = session?.platformBinding?.conversationRef
      upstream = str(record(ref?.self)?.platform) ?? (ref?.messageType ? "qq" : undefined)
    }
    const url = upstream === "qq" && kind !== "channel" ? qqAvatarUrl(remoteId, kind) : undefined
    return url ? { url } : undefined
  }
  if (!active()) return undefined
  const settings = record(adapter.settings) ?? {}
  const encode = encodeURIComponent
  if (platform === "lark") {
    const [appId, appSecret] = await Promise.all([
      connectorsKeyringGet(adapterId, "appId"),
      connectorsKeyringGet(adapterId, "appSecret"),
    ])
    if (!appId || !appSecret || !active()) return undefined
    const { larkTenantRequest } = await import("@/lib/connectors/adapters/lark/http")
    const tenantRequest = (path: string) =>
      larkTenantRequest({ appId, appSecret }, "GET", path, undefined, { avatarPolicy: true })
    if (target.actorKind === "bot" || target.remoteIdType === "app_id") {
      const whoami = record(adapter.lastWhoamiResult)
      const own = remoteId === appId || (whoami?.appId === appId && whoami.openId === remoteId)
      if (!own && target.remoteIdType !== "app_id") {
        const siblings = await listAdapterInstancesByType("lark")
        if (!active()) return undefined
        for (const sibling of siblings) {
          const identity = sibling.lastWhoamiResult
          if (identity?.openId !== remoteId || !identity.botAvatar) continue
          const confirmedAppId = await connectorsKeyringGet(sibling.id, "appId")
          if (!active()) return undefined
          const safe =
            confirmedAppId === identity.appId
              ? publicUrl(platform, identity.botAvatar, true)
              : undefined
          if (safe) return { url: safe }
        }
      }
      // Only the verified self bot may use bot/v3/info. Never substitute its
      // picture for an unknown bot's open_id or query contact users with app_id.
      if (own || target.remoteIdType !== "app_id") {
        const bot = record(record(await tenantRequest("/bot/v3/info"))?.bot)
        if (!active()) return undefined
        if (own || bot?.open_id === remoteId) {
          const safe = publicUrl(platform, bot?.avatar_url, true)
          return safe ? { url: safe } : undefined
        }
        return undefined
      }
      const app = record(
        record(
          record(await tenantRequest(`/application/v6/applications/${encode(remoteId)}?lang=zh_cn`))
            ?.data
        )?.app
      )
      const safe = publicUrl(platform, app?.avatar_url, true)
      return safe ? { url: safe } : undefined
    }
    const result = record(
      await tenantRequest(
        kind === "user"
          ? `/contact/v3/users/${encode(remoteId)}?user_id_type=open_id`
          : `/im/v1/chats/${encode(remoteId)}`
      )
    )
    const data = record(result?.data)
    const avatar = record(record(data?.user)?.avatar)
    const url =
      kind === "user"
        ? (str(avatar?.avatar_240) ?? str(avatar?.avatar_72) ?? str(avatar?.avatar_640))
        : data?.avatar
    const safe = publicUrl(platform, url, true)
    return safe ? { url: safe } : undefined
  }
  if (platform === "dingtalk") {
    if (kind !== "user") return undefined
    const ref = target.remoteIdType === "staff_id" ? undefined : await conversationRef()
    if (target.remoteIdType !== "staff_id" && id(ref?.userId) !== remoteId) return undefined
    const [appKey, appSecret] = await Promise.all([
      connectorsKeyringGet(adapterId, "appKey"),
      connectorsKeyringGet(adapterId, "appSecret"),
    ])
    if (!appKey || !appSecret || !active()) return undefined
    const { getDingTalkAccessToken } = await import("@/lib/connectors/adapters/dingtalk/auth")
    const token = await getDingTalkAccessToken(appKey, appSecret)
    const result = await request(
      `https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${encode(token)}`,
      { "Content-Type": "application/json" },
      { userid: remoteId }
    )
    const safe =
      result?.errcode === 0 ? publicUrl(platform, record(result.result)?.avatar, true) : undefined
    return safe ? { url: safe } : undefined
  }
  if (platform === "qq-official") {
    const ref = await conversationRef()
    const channelId =
      kind === "channel" ? remoteId : ref?.scene === "channel" ? id(ref.sceneId) : undefined
    if (!channelId) return undefined
    const [appId, clientSecret] = await Promise.all([
      connectorsKeyringGet(adapterId, "appId"),
      connectorsKeyringGet(adapterId, "clientSecret"),
    ])
    if (!appId || !clientSecret || !active()) return undefined
    const { getQQAccessToken, qqAuthHeaders, QQ_API_BASE } =
      await import("@/lib/connectors/adapters/qq-official/auth")
    const token = await getQQAccessToken(appId, clientSecret)
    const headers = qqAuthHeaders(token)
    const channel = await request(`${QQ_API_BASE}/channels/${encode(channelId)}`, headers)
    const guildId = id(channel?.guild_id)
    if (!guildId) return undefined
    const result = await request(
      kind === "channel"
        ? `${QQ_API_BASE}/guilds/${encode(guildId)}`
        : `${QQ_API_BASE}/guilds/${encode(guildId)}/members/${encode(remoteId)}`,
      headers
    )
    const safe = publicUrl(
      platform,
      kind === "channel" ? result?.icon : record(result?.user)?.avatar,
      true
    )
    return safe ? { url: safe } : undefined
  }
  if (!["slack", "discord", "telegram", "matrix"].includes(platform)) return undefined
  const token = await connectorsKeyringGet(
    adapterId,
    platform === "matrix" ? "accessToken" : "botToken"
  )
  if (!token || !active()) return undefined
  if (platform === "slack") {
    const headers = { Authorization: `Bearer ${token}` }
    let userId = remoteId
    if (kind !== "user") {
      const result = await request(
        `https://slack.com/api/conversations.info?channel=${encode(remoteId)}`,
        headers
      )
      const channel = record(result?.channel)
      if (result?.ok !== true || channel?.is_im !== true || !str(channel.user)) return undefined
      userId = str(channel.user)!
    }
    const result = await request(`https://slack.com/api/users.info?user=${encode(userId)}`, headers)
    const profile = record(record(result?.user)?.profile)
    const url =
      result?.ok === true
        ? publicUrl(platform, str(profile?.image_192) ?? profile?.image_72, true)
        : undefined
    return url ? { url } : undefined
  }
  if (platform === "discord") {
    const headers = { Authorization: `Bot ${token}` }
    if (kind === "user") {
      const guildId = id((await conversationRef())?.guildId)
      if (guildId) {
        const member = await request(
          `https://discord.com/api/v10/guilds/${encode(guildId)}/members/${encode(remoteId)}`,
          headers
        )
        const url = member && discordUrl(record(member.user) ?? { id: remoteId }, member, guildId)
        if (url) return { url }
      }
    }
    const result = await request(
      `https://discord.com/api/v10/${kind === "user" ? "users" : "channels"}/${encode(remoteId)}`,
      headers
    )
    if (!result) return undefined
    const recipients = Array.isArray(result.recipients) ? result.recipients : []
    const url =
      kind === "user"
        ? discordUrl(result)
        : result.type === 1 && recipients.length === 1
          ? discordUrl(record(recipients[0]) ?? {})
          : str(result.icon) && /^[a-f0-9_]+$/i.test(String(result.icon))
            ? `https://cdn.discordapp.com/channel-icons/${encode(remoteId)}/${result.icon}.png?size=128`
            : undefined
    return url ? { url } : undefined
  }
  if (platform === "telegram") {
    if (!/^-?[1-9]\d{0,19}$/.test(remoteId)) return undefined
    const api = `https://api.telegram.org/bot${token}/`
    const result = await request(
      kind === "user"
        ? `${api}getUserProfilePhotos?user_id=${encode(remoteId)}&limit=1`
        : `${api}getChat?chat_id=${encode(remoteId)}`
    )
    if (result?.ok !== true) return undefined
    const data = record(result.result)
    const photos = data?.photos
    const variants = Array.isArray(photos) && Array.isArray(photos[0]) ? photos[0] : []
    const fileId =
      kind === "user" ? str(record(variants[0])?.file_id) : str(record(data?.photo)?.small_file_id)
    if (!fileId) return undefined
    const file = await request(`${api}getFile?file_id=${encode(fileId)}`)
    const path = str(record(file?.result)?.file_path)
    if (file?.ok !== true || !path || !/^[\w./-]+$/.test(path) || path.split("/").includes(".."))
      return undefined
    return { url: `https://api.telegram.org/file/bot${token}/${path}`, revision: fileId }
  }
  if (platform === "matrix") {
    const { normalizeHomeserver } = await import("@/lib/connectors/adapters/matrix/auth")
    const homeserver = normalizeHomeserver(str(settings.homeserver) ?? "")
    if (!homeserver) return undefined
    const headers = { Authorization: `Bearer ${token}` }
    const roomId = kind === "user" ? id((await conversationRef())?.roomId) : undefined
    const member = roomId
      ? await request(
          `${homeserver}/_matrix/client/v3/rooms/${encode(roomId)}/state/m.room.member/${encode(remoteId)}`,
          headers
        )
      : undefined
    const result = str(member?.avatar_url)
      ? member
      : await request(
          kind === "user"
            ? `${homeserver}/_matrix/client/v3/profile/${encode(remoteId)}/avatar_url`
            : `${homeserver}/_matrix/client/v3/rooms/${encode(remoteId)}/state/m.room.avatar`,
          headers
        )
    const mxc = str(result?.avatar_url ?? result?.url)
    const match = mxc && /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(mxc)
    if (!match) return undefined
    return {
      url: `${homeserver}/_matrix/client/v1/media/download/${encode(match[1])}/${encode(match[2])}`,
      headers,
      revision: mxc,
    }
  }
  return undefined
}

interface CachedAvatar {
  url?: string
  expiresAt: number
}
const caches = new WeakMap<ReturnType<typeof getDb>, Map<string, CachedAvatar>>()
const pending = new WeakMap<ReturnType<typeof getDb>, Map<string, Promise<string | undefined>>>()

export async function resolvePlatformAvatar(
  target: PlatformAvatarTarget
): Promise<string | undefined> {
  const inline = inlineAvatarUrl(target.avatarUrl)
  if (inline) return inline
  const database = getDb()
  const credentialGeneration = getCredentialsGeneration(target.adapterId)
  if (
    target.credentialGeneration !== undefined &&
    target.credentialGeneration !== credentialGeneration
  )
    return undefined
  const adapter = await getAdapterInstance(target.adapterId)
  if (
    !adapter ||
    adapter.type !== target.platform ||
    getDb() !== database ||
    getCredentialsGeneration(target.adapterId) !== credentialGeneration
  )
    return undefined
  const configKey = avatarConfigKey(adapter)
  if (target.configKey !== undefined && target.configKey !== configKey) return undefined
  const key = JSON.stringify([target, configKey, credentialGeneration])
  const cache = caches.get(database) ?? new Map<string, CachedAvatar>()
  caches.set(database, cache)
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.url
  const requests = pending.get(database) ?? new Map<string, Promise<string | undefined>>()
  pending.set(database, requests)
  const existing = requests.get(key)
  if (existing) return existing
  if (requests.size >= MAX_CACHE_ENTRIES) return undefined
  const request = (async () => {
    let url: string | undefined
    try {
      const source = await resolveSource({ ...target, credentialGeneration }, database, adapter)
      if (
        source &&
        getDb() === database &&
        getCredentialsGeneration(target.adapterId) === credentialGeneration
      ) {
        const generationHash = await crypto.subtle
          .digest(
            "SHA-256",
            new TextEncoder().encode(JSON.stringify([configKey, credentialGeneration]))
          )
          .then((value) =>
            Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, "0")).join("")
          )
        const revision = await crypto.subtle
          .digest("SHA-256", new TextEncoder().encode(source.revision ?? source.url))
          .then((value) =>
            Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, "0")).join("")
          )
        const remoteRef = `avatar:v2:${database.name}:${target.platform}:${target.kind}:${target.remoteId}:${generationHash}:${revision}`
        const result = await fetchAttachment({
          adapterId: target.adapterId,
          remoteRef,
          sourceUrl: source.url,
          headers: source.headers,
          ttlMs: AVATAR_TTL_MS,
        })
        if (result.ref.sizeBytes <= MAX_AVATAR_BYTES && getDb() === database) {
          const bytes = await connectorsAttachmentRead(
            target.adapterId,
            remoteRef,
            MAX_AVATAR_BYTES
          )
          const mime = bytes && sniffImageMediaType(bytes)
          if (bytes && mime && bytes.length <= (MAX_AVATAR_BYTES * 4) / 3 + 4)
            url = `data:${mime};base64,${bytes}`
        }
      }
    } catch {
      /* A missing portrait never blocks messages or replaces their identity. */
    }
    if (getDb() !== database || getCredentialsGeneration(target.adapterId) !== credentialGeneration)
      return undefined
    const currentAdapter = await getAdapterInstance(target.adapterId)
    if (!currentAdapter || avatarConfigKey(currentAdapter) !== configKey) return undefined
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!)
    cache.set(key, { url, expiresAt: Date.now() + (url ? AVATAR_TTL_MS : AVATAR_RETRY_MS) })
    return url
  })().finally(() => {
    requests.delete(key)
  })
  requests.set(key, request)
  return request
}
