const mockCdnFetch = jest.fn()
jest.mock("@/lib/network/proxy-fetch", () => ({
  proxyFetch: (...args: unknown[]) => mockCdnFetch(...args),
}))
import { createWechatPersonalAdapter } from "./index"
import type { AdapterContext } from "@/types/connectors/adapter"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { WechatPersonalConversationRef } from "./parse"
import { ILINK_ITEM, ILINK_MSG } from "./protocol"
import { encryptIlinkMedia } from "./media"
import { isTauri } from "@/lib/platform/detect"
import type { ConnectorCommandInvoker } from "@/lib/connectors/tauri/commands"
jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: jest.fn(),
  commitWechatPersonalCheckpoint: jest.fn(),
}))
import { getAdapterInstance, commitWechatPersonalCheckpoint } from "@/lib/db/adapter-instances"
const mockGetAdapterInstance = getAdapterInstance as jest.Mock
const mockCommitCheckpoint = commitWechatPersonalCheckpoint as jest.Mock

const mockAttachmentRead = jest.fn(async (..._args: unknown[]): Promise<string | null> => null)
jest.mock("@/lib/connectors/tauri/commands", () => ({
  ...jest.requireActual("@/lib/connectors/tauri/commands"),
  connectorsAttachmentRead: (...args: unknown[]) => mockAttachmentRead(...args),
}))

const mockGate = jest.fn(async (..._a: unknown[]) => true)
jest.mock("@/lib/connectors/at-gate", () => ({
  gateInboundEvent: (...a: unknown[]) => mockGate(...a),
}))

const tick = () => new Promise((r) => setTimeout(r, 0))

const mockNumericReceipts = new Set<string>()
jest.mock("@/lib/connectors/dedup", () => ({
  isRecordedInbound: jest.fn(
    async (adapter: string, id: string, namespace: string, scope: string) =>
      mockNumericReceipts.has(JSON.stringify([adapter, id, namespace, scope]))
  ),
  recordAndCheckInbound: jest.fn(
    async (adapter: string, id: string, namespace: string, scope: string) => {
      const key = JSON.stringify([adapter, id, namespace, scope])
      const fresh = !mockNumericReceipts.has(key)
      mockNumericReceipts.add(key)
      return fresh
    }
  ),
}))

type HttpResp = { status: number; headers: Record<string, string>; body: string }

/** Build a ctx whose httpRequest routes by URL (getupdates vs sendmessage). */
function makeCtx(opts: {
  emit: jest.Mock
  getUpdates: () => unknown
  sendMessage?: () => unknown
  fetchAttachment?: jest.Mock
}): { ctx: AdapterContext; http: jest.Mock; warn: jest.Mock; abort: AbortController } {
  const http = jest.fn(async (req: { url: string }): Promise<HttpResp> => {
    const body = req.url.includes("getupdates")
      ? opts.getUpdates()
      : (opts.sendMessage?.() ?? { ret: 0 })
    // A string body is passed through raw so tests can feed non-JSON.
    return {
      status: 200,
      headers: {},
      body: typeof body === "string" ? body : JSON.stringify(body),
    }
  })
  const warn = jest.fn()
  const abort = new AbortController()
  const ctx = {
    emit: opts.emit as unknown as AdapterContext["emit"],
    tauri: {
      httpRequest: http,
      fetchAttachment:
        opts.fetchAttachment ?? jest.fn(async () => ({ localUrl: "file:///x", remoteRef: "r" })),
    } as unknown as AdapterContext["tauri"],
    secrets: {} as AdapterContext["secrets"],
    logger: { debug() {}, info() {}, warn, error() {} },
    signal: abort.signal,
    adapterId: "wx1",
  }
  return { ctx, http, warn, abort }
}

/** Flush pending microtasks without relying on timers (fake-timer safe). */
async function flushMicrotasks(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

function adapter() {
  return createWechatPersonalAdapter({
    id: "wx1",
    displayName: "My WeChat",
    token: async () => "tok",
    baseUrl: async () => "https://base",
    _backoffBaseMs: 1,
  })
}

const userMsg = (text: string, ctxToken = "ctx-1") => ({
  from_user_id: "alice@im.wechat",
  to_user_id: "bot@im.bot",
  message_type: ILINK_MSG.fromUser,
  context_token: ctxToken,
  session_id: "s1",
  item_list: [{ type: ILINK_ITEM.text, text_item: { text } }],
})

beforeEach(() => {
  mockGetAdapterInstance.mockReset().mockResolvedValue({ settings: {} })
  mockCommitCheckpoint
    .mockReset()
    .mockImplementation(
      async (
        id: string,
        _expected: unknown,
        next: Record<string, unknown>,
        isCurrent: () => boolean
      ) => {
        const row = await mockGetAdapterInstance(id)
        if (!row || !isCurrent()) return false
        Object.assign(row.settings, { ilinkCheckpoint: next })
        return true
      }
    )
  mockNumericReceipts.clear()
  mockAttachmentRead.mockReset()
  mockAttachmentRead.mockResolvedValue(null)
  mockGate.mockClear()
  mockGate.mockResolvedValue(true)
})

describe("createWechatPersonalAdapter — inbound long-poll", () => {
  it("decrypts inbound images through the headless command invoker without a Tauri marker", async () => {
    expect(isTauri()).toBe(false)
    const commands = jest.requireActual<typeof import("@/lib/connectors/tauri/commands")>(
      "@/lib/connectors/tauri/commands"
    )
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
    const key = new Uint8Array(16)
    const encrypted = encryptIlinkMedia(new Uint8Array(Buffer.from(png, "base64")), key)
    const invoke = jest.fn(async (name: string, args?: Record<string, unknown>) => {
      if (name === "connectors_attachment_read") return Buffer.from(encrypted).toString("base64")
      if (name === "connectors_attachment_fetch")
        return {
          cacheKey: "headless",
          remoteRef: args?.remoteRef,
          sizeBytes: encrypted.length,
          createdAt: 1,
          lastAccessedAt: 1,
          cached: false,
        }
      throw new Error(`Unexpected command ${name}`)
    })
    const previous = commands.setConnectorCommandInvoker(invoke as ConnectorCommandInvoker)
    mockAttachmentRead.mockImplementation(async (...args: unknown[]) =>
      commands.connectorsAttachmentRead(args[0] as string, args[1] as string, args[2] as number)
    )
    const emit = jest.fn(async (_event: NormalizedInboundEvent) => undefined)
    let polls = 0
    const { ctx } = makeCtx({
      emit,
      fetchAttachment: jest.fn(async (adapterId: string, remoteRef: string) =>
        commands.connectorsAttachmentFetch(adapterId, remoteRef, remoteRef)
      ),
      getUpdates: () =>
        ++polls === 1
          ? {
              ret: 0,
              msgs: [
                {
                  ...userMsg(""),
                  item_list: [
                    {
                      type: ILINK_ITEM.image,
                      image_item: {
                        media: {
                          full_url: "https://cdn/encrypted",
                          aes_key: Buffer.from(key).toString("base64"),
                        },
                      },
                    },
                  ],
                },
              ],
            }
          : { ret: -14 },
    })
    const a = adapter()
    try {
      await a.start(ctx)
      for (let i = 0; i < 30 && emit.mock.calls.length === 0; i++) await tick()
      expect(emit.mock.calls[0][0].segments).toEqual([
        expect.objectContaining({
          type: "image",
          url: `data:image/png;base64,${png}`,
          dataBase64: png,
          rawUrl: "https://cdn/encrypted",
        }),
      ])
      expect(invoke.mock.calls.map(([name]) => name)).toEqual([
        "connectors_attachment_fetch",
        "connectors_attachment_read",
      ])
    } finally {
      await a.stop()
      commands.setConnectorCommandInvoker(previous)
    }
  })

  it("does not let a stopped poll emit into a restarted adapter", async () => {
    let finish!: (response: HttpResp) => void
    const old = makeCtx({ emit: jest.fn(), getUpdates: () => ({ ret: -14 }) })
    old.http.mockImplementationOnce(
      () =>
        new Promise<HttpResp>((resolve) => {
          finish = resolve
        })
    )
    const current = makeCtx({ emit: jest.fn(), getUpdates: () => ({ ret: -14 }) })
    const a = adapter()
    await a.start(old.ctx)
    await tick()
    await a.stop()
    await a.start(current.ctx)
    await tick()
    finish({
      status: 200,
      headers: {},
      body: JSON.stringify({
        ret: 0,
        msgs: [userMsg("obsolete")],
        get_updates_buf: "obsolete-cursor",
      }),
    })
    await tick()
    expect(old.ctx.emit).not.toHaveBeenCalled()
    expect(current.ctx.emit).not.toHaveBeenCalled()
    expect(a.health().reason).toBe("session_expired_rescan")
    await a.stop()
  })

  it("matches media by typed occurrence instead of unrelated nested payloads", async () => {
    let polls = 0
    const fetchAttachment = jest.fn(async () => undefined)
    mockAttachmentRead.mockResolvedValue("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB")
    const emit = jest.fn(async (_event: NormalizedInboundEvent) => undefined)
    const { ctx } = makeCtx({
      emit,
      fetchAttachment,
      getUpdates: () =>
        ++polls === 1
          ? {
              ret: 0,
              msgs: [
                {
                  ...userMsg("caption"),
                  item_list: [
                    {
                      type: ILINK_ITEM.text,
                      text_item: { text: "caption" },
                      image_item: { url: "https://cdn/wrong" },
                    },
                    { type: ILINK_ITEM.image, image_item: { url: "https://cdn/right" } },
                  ],
                },
              ],
            }
          : { ret: -14 },
    })
    const a = adapter()
    await a.start(ctx)
    for (let i = 0; i < 20 && emit.mock.calls.length === 0; i++) await tick()
    await a.stop()
    expect(fetchAttachment.mock.calls.map((args: unknown[]) => args[1])).toEqual([
      "https://cdn/right",
    ])
    expect(emit.mock.calls[0][0].segments[1]).toMatchObject({
      type: "image",
      rawUrl: "https://cdn/right",
      mimeType: "image/png",
    })
  })

  it("persists accepted scoped cursors and resumes them in a fresh adapter", async () => {
    const row = { settings: { accountId: "bot-account", unrelated: "keep" } }
    mockGetAdapterInstance.mockResolvedValue(row)
    mockCommitCheckpoint.mockImplementation(
      async (_id: string, _expected: unknown, next: Record<string, unknown>) => {
        Object.assign(row.settings, { ilinkCheckpoint: next })
        return true
      }
    )
    let polls = 0
    const first = makeCtx({
      emit: jest.fn(async () => undefined),
      getUpdates: () =>
        ++polls === 1
          ? { ret: 0, msgs: [userMsg("accepted")], get_updates_buf: "accepted-cursor" }
          : { ret: -14 },
    })
    const a = adapter()
    await a.start(first.ctx)
    for (let i = 0; i < 30 && polls < 2; i++) await tick()
    await a.stop()
    expect(mockCommitCheckpoint).toHaveBeenCalledWith(
      "wx1",
      expect.objectContaining({ settings: expect.objectContaining({ accountId: "bot-account" }) }),
      expect.objectContaining({
        baseUrl: "https://base",
        cursor: "accepted-cursor",
        credentialHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.any(Function)
    )
    expect(JSON.stringify(row.settings)).not.toContain('"tok"')
    expect(row.settings.unrelated).toBe("keep")
    const second = makeCtx({ emit: jest.fn(), getUpdates: () => ({ ret: -14 }) })
    const restarted = adapter()
    await restarted.start(second.ctx)
    for (let i = 0; i < 30 && second.http.mock.calls.length === 0; i++) await tick()
    await restarted.stop()
    expect(JSON.parse(second.http.mock.calls[0][0].body).get_updates_buf).toBe("accepted-cursor")
  })

  it("does not checkpoint while acceptance waits and retries a failed checkpoint from the old cursor", async () => {
    mockGetAdapterInstance.mockResolvedValue({ settings: {} })
    mockCommitCheckpoint.mockRejectedValueOnce(new Error("storage failure"))
    let accept!: () => void
    const emit = jest.fn(async () => {
      if (emit.mock.calls.length === 1)
        await new Promise<void>((resolve) => {
          accept = resolve
        })
    })
    let polls = 0
    const { ctx, http } = makeCtx({
      emit,
      getUpdates: () =>
        ++polls <= 2
          ? {
              ret: 0,
              msgs: [{ ...userMsg("retained"), message_id: "same-source" }],
              get_updates_buf: "accepted-cursor",
            }
          : { ret: -14 },
    })
    const a = adapter()
    await a.start(ctx)
    for (let i = 0; i < 20 && emit.mock.calls.length === 0; i++) await tick()
    expect(mockCommitCheckpoint).not.toHaveBeenCalled()
    expect(polls).toBe(1)
    accept()
    for (let i = 0; i < 40 && polls < 3; i++) await tick()
    await a.stop()
    expect(
      http.mock.calls.slice(0, 3).map(([request]) => JSON.parse(request.body).get_updates_buf)
    ).toEqual(["", "", "accepted-cursor"])
    expect(mockCommitCheckpoint).toHaveBeenCalledTimes(2)
  })

  it("rereads a competing writer's checkpoint after a rejected commit", async () => {
    const { sha256Hex } = await import("@/lib/share/hash")
    const checkpoint = {
      baseUrl: "https://base",
      credentialHash: await sha256Hex("tok"),
      cursor: "initial-cursor",
    }
    let row = { settings: { ilinkCheckpoint: checkpoint } }
    mockGetAdapterInstance.mockImplementation(async () => row)
    mockCommitCheckpoint.mockImplementationOnce(async () => {
      row = { settings: { ilinkCheckpoint: { ...checkpoint, cursor: "competing-cursor" } } }
      return false
    })
    let polls = 0
    const { ctx, http } = makeCtx({
      emit: jest.fn(async () => undefined),
      getUpdates: () =>
        ++polls === 1
          ? { ret: 0, msgs: [userMsg("accepted")], get_updates_buf: "rejected-cursor" }
          : { ret: -14 },
    })
    const a = adapter()
    await a.start(ctx)
    for (let i = 0; i < 30 && polls < 2; i++) await tick()
    await a.stop()
    expect(
      http.mock.calls.slice(0, 2).map(([request]) => JSON.parse(request.body).get_updates_buf)
    ).toEqual(["initial-cursor", "competing-cursor"])
    expect(mockCommitCheckpoint).toHaveBeenCalledWith(
      "wx1",
      { settings: { ilinkCheckpoint: checkpoint } },
      expect.objectContaining({ cursor: "rejected-cursor" }),
      expect.any(Function)
    )
  })

  it("uses peer progress read before polling instead of its older in-memory cursor", async () => {
    const row = { settings: {} as Record<string, unknown> }
    mockGetAdapterInstance.mockResolvedValue(row)
    mockCommitCheckpoint.mockImplementationOnce(
      async (_id: string, _expected: unknown, next: Record<string, unknown>) => {
        row.settings.ilinkCheckpoint = { ...next, cursor: "peer-progress" }
        return true
      }
    )
    let polls = 0
    const { ctx, http } = makeCtx({
      emit: jest.fn(async () => undefined),
      getUpdates: () =>
        ++polls === 1
          ? { ret: 0, msgs: [userMsg("accepted")], get_updates_buf: "own-progress" }
          : { ret: -14 },
    })
    const a = adapter()
    await a.start(ctx)
    for (let i = 0; i < 30 && polls < 2; i++) await tick()
    await a.stop()
    expect(
      http.mock.calls.slice(0, 2).map(([request]) => JSON.parse(request.body).get_updates_buf)
    ).toEqual(["", "peer-progress"])
  })

  it.each(["HTTP", "gate"])(
    "rejects an unchanged token with a new credential revision during %s",
    async (stage) => {
      let revision = "revision-1"
      let finishHttp!: (response: HttpResp) => void
      let finishGate!: (allowed: boolean) => void
      let polls = 0
      const { ctx, http } = makeCtx({
        emit: jest.fn(),
        getUpdates: () =>
          ++polls === 1 && stage === "gate"
            ? { ret: 0, msgs: [userMsg("same-token-old-login")], get_updates_buf: "stale-cursor" }
            : { ret: -14 },
      })
      if (stage === "HTTP")
        http.mockImplementationOnce(
          () =>
            new Promise<HttpResp>((resolve) => {
              finishHttp = resolve
            })
        )
      if (stage === "gate")
        mockGate.mockImplementationOnce(
          () =>
            new Promise<boolean>((resolve) => {
              finishGate = resolve
            })
        )
      const options = {
        id: "wx1",
        displayName: "My WeChat",
        token: async () => "tok",
        tokenSnapshot: async () => ({ value: "tok", revision }),
        baseUrl: async () => "https://base",
        _backoffBaseMs: 1,
      }
      const a = createWechatPersonalAdapter(options)
      await a.start(ctx)
      for (let i = 0; i < 20 && !(finishHttp || finishGate); i++) await tick()
      revision = "revision-3"
      if (stage === "HTTP")
        finishHttp({
          status: 200,
          headers: {},
          body: JSON.stringify({
            ret: 0,
            msgs: [userMsg("same-token-old-login")],
            get_updates_buf: "stale-cursor",
          }),
        })
      else finishGate(true)
      for (let i = 0; i < 20; i++) await tick()
      await a.stop()
      expect(ctx.emit).not.toHaveBeenCalled()
      expect(mockCommitCheckpoint).not.toHaveBeenCalled()
    }
  )

  it("does not restore a prior credential revision's cursor after same-value login", async () => {
    const { sha256Hex } = await import("@/lib/share/hash")
    mockGetAdapterInstance.mockResolvedValue({
      settings: {
        ilinkCheckpoint: {
          baseUrl: "https://base",
          credentialHash: await sha256Hex("tok"),
          credentialRevision: "revision-1",
          cursor: "old-login-cursor",
        },
      },
    })
    const { ctx, http } = makeCtx({ emit: jest.fn(), getUpdates: () => ({ ret: -14 }) })
    const options = {
      id: "wx1",
      displayName: "My WeChat",
      token: async () => "tok",
      tokenSnapshot: async () => ({ value: "tok", revision: "revision-3" }),
      baseUrl: async () => "https://base",
      _backoffBaseMs: 1,
    }
    const a = createWechatPersonalAdapter(options)
    await a.start(ctx)
    for (let i = 0; i < 20 && http.mock.calls.length === 0; i++) await tick()
    await a.stop()
    expect(JSON.parse(http.mock.calls[0][0].body).get_updates_buf).toBe("")
  })

  it("halts a stale registry instance whose stored server changed before start", async () => {
    mockGetAdapterInstance.mockResolvedValue({ settings: { baseUrl: "https://replacement" } })
    const { ctx, http } = makeCtx({ emit: jest.fn(), getUpdates: () => ({ ret: -14 }) })
    const a = adapter()
    await a.start(ctx)
    for (let i = 0; i < 10; i++) await tick()
    expect(http).not.toHaveBeenCalled()
    expect(a.health().reason).toBe("configuration_changed")
    await a.stop()
  })

  it("uses only the atomic snapshot for inbound and persists its revision across restart", async () => {
    const row = { settings: {} as Record<string, unknown> }
    mockGetAdapterInstance.mockResolvedValue(row)
    const token = jest.fn(async () => {
      throw new Error("Legacy token read is not atomic")
    })
    const options = {
      id: "wx1",
      displayName: "My WeChat",
      token,
      tokenSnapshot: async () => ({ value: "snapshot-token", revision: "revision-1" }),
      baseUrl: async () => "https://base",
      _backoffBaseMs: 1,
    }
    let polls = 0
    const first = makeCtx({
      emit: jest.fn(async () => undefined),
      getUpdates: () =>
        ++polls === 1
          ? { ret: 0, msgs: [userMsg("accepted")], get_updates_buf: "snapshot-cursor" }
          : { ret: -14 },
    })
    const a = createWechatPersonalAdapter(options)
    await a.start(first.ctx)
    for (let i = 0; i < 20 && polls < 2; i++) await tick()
    await a.stop()
    expect(row.settings.ilinkCheckpoint).toMatchObject({
      credentialRevision: "revision-1",
      cursor: "snapshot-cursor",
    })
    expect(first.http.mock.calls[0][0].headers.Authorization).toBe("Bearer snapshot-token")
    const second = makeCtx({ emit: jest.fn(), getUpdates: () => ({ ret: -14 }) })
    const restarted = createWechatPersonalAdapter(options)
    await restarted.start(second.ctx)
    for (let i = 0; i < 20 && second.http.mock.calls.length === 0; i++) await tick()
    await restarted.stop()
    expect(JSON.parse(second.http.mock.calls[0][0].body).get_updates_buf).toBe("snapshot-cursor")
    expect(token).not.toHaveBeenCalled()
  })

  it("does not fall back to a legacy token after the atomic snapshot is revoked", async () => {
    const token = jest.fn(async () => "legacy-token")
    const options = {
      id: "wx1",
      displayName: "My WeChat",
      token,
      tokenSnapshot: async () => null,
      baseUrl: async () => "https://base",
      _backoffBaseMs: 1,
    }
    const { ctx, http } = makeCtx({ emit: jest.fn(), getUpdates: () => ({ ret: -14 }) })
    const a = createWechatPersonalAdapter(options)
    await a.start(ctx)
    for (let i = 0; i < 10; i++) await tick()
    expect(a.health().reason).toBe("token_missing")
    await a.stop()
    expect(token).not.toHaveBeenCalled()
    expect(http).not.toHaveBeenCalled()
  })

  it.each(["rotated-token", ""])(
    "discards an in-flight poll when its credential changes to %s",
    async (replacement) => {
      mockGetAdapterInstance.mockResolvedValue({ settings: {} })
      let token = "tok"
      let finish!: (response: HttpResp) => void
      const { ctx, http } = makeCtx({ emit: jest.fn(), getUpdates: () => ({ ret: -14 }) })
      http.mockImplementationOnce(
        () =>
          new Promise<HttpResp>((resolve) => {
            finish = resolve
          })
      )
      const a = createWechatPersonalAdapter({
        id: "wx1",
        displayName: "My WeChat",
        token: async () => token,
        baseUrl: async () => "https://base",
        _backoffBaseMs: 1,
      })
      await a.start(ctx)
      for (let i = 0; i < 20 && !finish; i++) await tick()
      token = replacement
      finish({
        status: 200,
        headers: {},
        body: JSON.stringify({
          ret: 0,
          msgs: [userMsg("old-account")],
          get_updates_buf: "old-account-cursor",
        }),
      })
      for (let i = 0; i < 20; i++) await tick()
      await a.stop()
      expect(ctx.emit).not.toHaveBeenCalled()
      expect(mockCommitCheckpoint).not.toHaveBeenCalled()
    }
  )

  it("discards a response if its base URL changes while the poll is in flight", async () => {
    mockGetAdapterInstance.mockResolvedValue({ settings: {} })
    let baseUrl = "https://base"
    let finish!: (response: HttpResp) => void
    const { ctx, http } = makeCtx({ emit: jest.fn(), getUpdates: () => ({ ret: -14 }) })
    http.mockImplementationOnce(
      () =>
        new Promise<HttpResp>((resolve) => {
          finish = resolve
        })
    )
    const a = createWechatPersonalAdapter({
      id: "wx1",
      displayName: "My WeChat",
      token: async () => "tok",
      baseUrl: async () => baseUrl,
      _backoffBaseMs: 1,
    })
    await a.start(ctx)
    for (let i = 0; i < 20 && !finish; i++) await tick()
    baseUrl = "https://replacement"
    finish({
      status: 200,
      headers: {},
      body: JSON.stringify({
        ret: 0,
        msgs: [userMsg("old-server")],
        get_updates_buf: "old-server-cursor",
      }),
    })
    for (let i = 0; i < 20 && http.mock.calls.length < 2; i++) await tick()
    await a.stop()
    expect(ctx.emit).not.toHaveBeenCalled()
    expect(mockCommitCheckpoint).not.toHaveBeenCalled()
    expect(http.mock.calls[1][0].url).toContain("https://replacement/")
    expect(JSON.parse(http.mock.calls[1][0].body).get_updates_buf).toBe("")
  })

  it("revalidates credentials after an asynchronous inbound gate", async () => {
    mockGetAdapterInstance.mockResolvedValue({ settings: {} })
    let token = "tok"
    let release!: (allowed: boolean) => void
    mockGate.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        })
    )
    let polls = 0
    const { ctx } = makeCtx({
      emit: jest.fn(),
      getUpdates: () =>
        ++polls === 1
          ? { ret: 0, msgs: [userMsg("old-account")], get_updates_buf: "stale-cursor" }
          : { ret: -14 },
    })
    const a = createWechatPersonalAdapter({
      id: "wx1",
      displayName: "My WeChat",
      token: async () => token,
      baseUrl: async () => "https://base",
      _backoffBaseMs: 1,
    })
    await a.start(ctx)
    for (let i = 0; i < 20 && !release; i++) await tick()
    token = "rotated-token"
    release(true)
    for (let i = 0; i < 20 && polls < 2; i++) await tick()
    await a.stop()
    expect(ctx.emit).not.toHaveBeenCalled()
    expect(mockCommitCheckpoint).not.toHaveBeenCalled()
  })

  it("does not checkpoint an accepted batch after its credential is revoked", async () => {
    mockGetAdapterInstance.mockResolvedValue({ settings: {} })
    let token = "tok"
    let accept!: () => void
    const emit = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve
        })
    )
    const { ctx } = makeCtx({
      emit,
      getUpdates: () => ({
        ret: 0,
        msgs: [userMsg("accepted-before-revoke")],
        get_updates_buf: "stale-cursor",
      }),
    })
    const a = createWechatPersonalAdapter({
      id: "wx1",
      displayName: "My WeChat",
      token: async () => token,
      baseUrl: async () => "https://base",
      _backoffBaseMs: 1,
    })
    await a.start(ctx)
    for (let i = 0; i < 20 && !accept; i++) await tick()
    token = ""
    accept()
    for (let i = 0; i < 20; i++) await tick()
    await a.stop()
    expect(emit).toHaveBeenCalledTimes(1)
    expect(mockCommitCheckpoint).not.toHaveBeenCalled()
  })

  it.each(["server", "account", "disabled", "removed"])(
    "fences an in-flight poll after its stored configuration is %s",
    async (change) => {
      const row = {
        enabled: true,
        settings: { baseUrl: "https://base", accountId: "old-account" },
      }
      mockGetAdapterInstance.mockResolvedValue(row)
      let finish!: (response: HttpResp) => void
      const { ctx, http } = makeCtx({ emit: jest.fn(), getUpdates: () => ({ ret: -14 }) })
      http.mockImplementationOnce(
        () =>
          new Promise<HttpResp>((resolve) => {
            finish = resolve
          })
      )
      // Like the production registry, these options retain the old row's
      // base URL until supervisor reconciliation builds a replacement.
      const a = adapter()
      await a.start(ctx)
      for (let i = 0; i < 20 && !finish; i++) await tick()
      if (change === "server") row.settings.baseUrl = "https://replacement"
      if (change === "account") row.settings.accountId = "replacement-account"
      if (change === "disabled") row.enabled = false
      if (change === "removed") mockGetAdapterInstance.mockResolvedValue(undefined)
      finish({
        status: 200,
        headers: {},
        body: JSON.stringify({
          ret: 0,
          msgs: [userMsg("old-configuration")],
          get_updates_buf: "stale-cursor",
        }),
      })
      for (let i = 0; i < 20; i++) await tick()
      await a.stop()
      expect(ctx.emit).not.toHaveBeenCalled()
      expect(mockCommitCheckpoint).not.toHaveBeenCalled()
      expect(http).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    ["server", "https://old-server", "tok"],
    ["credential", "https://base", "other-token"],
  ])("ignores a cursor from a different %s", async (_scope, baseUrl, token) => {
    const { sha256Hex } = await import("@/lib/share/hash")
    mockGetAdapterInstance.mockResolvedValue({
      settings: {
        ilinkCheckpoint: {
          baseUrl,
          credentialHash: await sha256Hex(token),
          cursor: "foreign-cursor",
        },
      },
    })
    const { ctx, http } = makeCtx({ emit: jest.fn(), getUpdates: () => ({ ret: -14 }) })
    const a = adapter()
    await a.start(ctx)
    for (let i = 0; i < 20 && http.mock.calls.length === 0; i++) await tick()
    await a.stop()
    expect(JSON.parse(http.mock.calls[0][0].body).get_updates_buf).toBe("")
  })

  it("does not restore a cursor stored for another configured account", async () => {
    const { sha256Hex } = await import("@/lib/share/hash")
    mockGetAdapterInstance.mockResolvedValue({
      settings: {
        accountId: "current-account",
        ilinkCheckpoint: {
          baseUrl: "https://base",
          credentialHash: await sha256Hex("tok"),
          accountId: "previous-account",
          cursor: "foreign-account-cursor",
        },
      },
    })
    const { ctx, http } = makeCtx({ emit: jest.fn(), getUpdates: () => ({ ret: -14 }) })
    const a = adapter()
    await a.start(ctx)
    for (let i = 0; i < 20 && http.mock.calls.length === 0; i++) await tick()
    await a.stop()
    expect(JSON.parse(http.mock.calls[0][0].body).get_updates_buf).toBe("")
  })

  it("isolates a malformed message and accepts the remaining batch before checkpointing", async () => {
    let polls = 0
    const emit = jest.fn(async (_event: NormalizedInboundEvent) => undefined)
    const { ctx, http } = makeCtx({
      emit,
      getUpdates: () =>
        ++polls === 1
          ? {
              ret: 0,
              msgs: [null, { ...userMsg("broken"), item_list: {} }, userMsg("kept")],
              get_updates_buf: "good-cursor",
            }
          : { ret: -14 },
    })
    const a = adapter()
    await a.start(ctx)
    for (let i = 0; i < 30 && polls < 2; i++) await tick()
    await a.stop()
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][0]).toMatchObject({ plainText: "kept" })
    expect(JSON.parse(http.mock.calls[1][0].body).get_updates_buf).toBe("good-cursor")
  })

  it("emits a parsed message then stops the loop on session expiry", async () => {
    const emit = jest.fn(async (_e: NormalizedInboundEvent) => undefined)
    let call = 0
    const { ctx } = makeCtx({
      emit,
      getUpdates: () => {
        call += 1
        if (call === 1) return { ret: 0, msgs: [userMsg("hello")], get_updates_buf: "cur2" }
        return { ret: -14, errcode: -14, errmsg: "session timeout" }
      },
    })
    const a = adapter()
    await a.start(ctx)
    for (let i = 0; i < 10 && emit.mock.calls.length === 0; i++) await tick()
    expect(emit).toHaveBeenCalledTimes(1)
    const ev = emit.mock.calls[0][0] as NormalizedInboundEvent
    expect(ev.platform).toBe("wechat-personal")
    expect(ev.plainText).toBe("hello")
    // Let the loop hit the -14 response.
    for (let i = 0; i < 10 && a.health().state !== "degraded"; i++) await tick()
    expect(a.health().state).toBe("degraded")
    expect(a.health().reason).toBe("session_expired_rescan")
    await a.stop()
  })

  it("does not emit when the gate denies", async () => {
    const emit = jest.fn(async (_e: NormalizedInboundEvent) => undefined)
    mockGate.mockResolvedValue(false)
    let call = 0
    const { ctx } = makeCtx({
      emit,
      getUpdates: () => {
        call += 1
        if (call === 1) return { ret: 0, msgs: [userMsg("blocked")] }
        return { ret: -14 }
      },
    })
    const a = adapter()
    await a.start(ctx)
    for (let i = 0; i < 12; i++) await tick()
    expect(emit).not.toHaveBeenCalled()
    await a.stop()
  })
})

describe("createWechatPersonalAdapter — outbound reply (reply-only)", () => {
  it("sends a text reply echoing the context_token", async () => {
    const emit = jest.fn(async () => undefined)
    const { ctx, http } = makeCtx({
      emit,
      getUpdates: () => ({ ret: -14 }), // end the loop immediately
      sendMessage: () => ({ ret: 0 }),
    })
    const a = adapter()
    await a.start(ctx)
    await tick()
    const ref: WechatPersonalConversationRef = {
      platform: "wechat-personal",
      adapterId: "wx1",
      userId: "alice@im.wechat",
      contextToken: "ctx-9",
    }
    const res = await a.send({
      conversationRef: ref,
      segments: [{ type: "text", text: "hi back" }],
      metadata: { idempotencyKey: "k1" },
    })
    expect(res.ok).toBe(true)
    const sendCall = http.mock.calls.find((c) =>
      (c[0] as { url: string }).url.includes("sendmessage")
    )
    expect(sendCall).toBeTruthy()
    const body = JSON.parse((sendCall![0] as { body: string }).body)
    expect(body.msg.context_token).toBe("ctx-9")
    expect(body.msg.to_user_id).toBe("alice@im.wechat")
    expect(body.msg.item_list[0].text_item.text).toBe("hi back")
    await a.stop()
  })

  it("marks the session dead and refuses retry when send hits ret -14", async () => {
    const emit = jest.fn(async () => undefined)
    const { ctx } = makeCtx({
      emit,
      getUpdates: () => ({ ret: -14 }), // end the loop immediately
      sendMessage: () => ({ ret: -14, errmsg: "session timeout" }),
    })
    const a = adapter()
    await a.start(ctx)
    await tick()
    // Park the adapter first so the health flip below is attributable to
    // send() alone (the poll loop is done and health() reads "down").
    await a.stop()
    expect(a.health().state).toBe("down")
    const ref: WechatPersonalConversationRef = {
      platform: "wechat-personal",
      adapterId: "wx1",
      userId: "alice@im.wechat",
      contextToken: "ctx-9",
    }
    const res = await a.send({
      conversationRef: ref,
      segments: [{ type: "text", text: "hi back" }],
      metadata: { idempotencyKey: "k-exp" },
    })
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("auth_failed")
    expect(res.error?.retryable).toBe(false)
    expect(res.error?.message).toContain("session timeout")
    expect(a.health().state).toBe("degraded")
    expect(a.health().reason).toBe("session_expired_rescan")
  })

  it.each([
    [200, { ret: 0, errcode: -14 }, "auth_failed", false],
    [200, { ret: 0, errcode: 42 }, "platform_4xx", true],
    [500, {}, "platform_5xx", true],
    [403, { ret: 0 }, "auth_failed", false],
    [200, null, "bad_response", true],
  ])("does not claim success for HTTP %s body %j", async (status, body, code, retryable) => {
    const { ctx, http } = makeCtx({ emit: jest.fn(), getUpdates: () => ({ ret: -14 }) })
    const a = adapter()
    await a.start(ctx)
    await tick()
    http.mockResolvedValue({ status, headers: {}, body: JSON.stringify(body) })
    const result = await a.send({
      conversationRef: {
        platform: "wechat-personal",
        adapterId: "wx1",
        userId: "alice",
        contextToken: "ctx",
      },
      segments: [{ type: "text", text: "hello" }],
      metadata: { idempotencyKey: "response-check" },
    })
    expect(result).toMatchObject({ ok: false, error: { code, retryable } })
    await a.stop()
  })

  it("refuses a proactive send with no context_token", async () => {
    const emit = jest.fn(async () => undefined)
    const { ctx } = makeCtx({ emit, getUpdates: () => ({ ret: -14 }) })
    const a = adapter()
    await a.start(ctx)
    await tick()
    const res = await a.send({
      conversationRef: { platform: "wechat-personal", adapterId: "wx1", userId: "bob@im.wechat" },
      segments: [{ type: "text", text: "ping" }],
      metadata: { idempotencyKey: "k2" },
    })
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("unsupported_segment")
    await a.stop()
  })
})

describe("createWechatPersonalAdapter — batch resilience & cursor ordering", () => {
  it("keeps handling the rest of the batch when one handler throws, retains the cursor for replay", async () => {
    const emit = jest
      .fn(async (_e: NormalizedInboundEvent) => undefined)
      .mockImplementationOnce(async () => {
        throw new Error("handler exploded")
      })
    let call = 0
    const { ctx, http, warn } = makeCtx({
      emit,
      getUpdates: () => {
        call += 1
        if (call === 1)
          return {
            ret: 0,
            msgs: [userMsg("m1", "ctx-a"), userMsg("m2", "ctx-b")],
            get_updates_buf: "cur9",
          }
        return { ret: -14 }
      },
    })
    const a = adapter()
    await a.start(ctx)
    for (let i = 0; i < 20 && call < 2; i++) await tick()

    // Message 2 was still handled despite message 1's handler throwing.
    expect(emit).toHaveBeenCalledTimes(2)
    expect((emit.mock.calls[1][0] as NormalizedInboundEvent).plainText).toBe("m2")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("handler exploded"))
    // A failed delivery must be replayed; the next poll retains the old cursor.
    const updates = http.mock.calls.filter((c) =>
      (c[0] as { url: string }).url.includes("getupdates")
    )
    expect(updates.length).toBeGreaterThanOrEqual(2)
    expect(JSON.parse((updates[1][0] as { body: string }).body).get_updates_buf).toBe("")
    await a.stop()
  })

  it("hydrates official nested and quoted media into readable URLs with detected MIME", async () => {
    const emit = jest.fn(async (_e: NormalizedInboundEvent) => undefined)
    const fetchAttachment = jest.fn(async () => ({ localUrl: "file:///cache", remoteRef: "r" }))
    const png = "iVBORw0KGgo="
    mockAttachmentRead.mockResolvedValue(png)
    let call = 0
    const { ctx } = makeCtx({
      emit,
      fetchAttachment,
      getUpdates: () =>
        ++call === 1
          ? {
              msgs: [
                {
                  ...userMsg(""),
                  item_list: [
                    {
                      type: ILINK_ITEM.text,
                      text_item: { text: "look" },
                      ref_msg: {
                        message_item: {
                          type: ILINK_ITEM.image,
                          image_item: { media: { full_url: "https://cdn/quote" } },
                        },
                      },
                    },
                    {
                      type: ILINK_ITEM.image,
                      image_item: { media: { encrypt_query_param: "image" } },
                    },
                    {
                      type: ILINK_ITEM.file,
                      file_item: {
                        media: { full_url: "https://cdn/file" },
                        file_name: "image.png",
                      },
                    },
                  ],
                },
              ],
            }
          : { ret: -14 },
    })
    const a = adapter()
    await a.start(ctx)
    for (let i = 0; i < 30 && !emit.mock.calls.length; i++) await tick()
    const media = emit.mock.calls[0][0].segments.filter(
      (segment) => segment.type === "image" || segment.type === "file"
    )
    expect(media).toHaveLength(3)
    for (const segment of media)
      expect(segment).toMatchObject({
        dataBase64: png,
        mimeType: "image/png",
        url: `data:image/png;base64,${png}`,
      })
    expect(fetchAttachment).toHaveBeenCalledTimes(3)
    await a.stop()
  })

  it("blanks the encrypted image url (placeholder alt) when media resolution fails", async () => {
    const emit = jest.fn(async (_e: NormalizedInboundEvent) => undefined)
    const fetchAttachment = jest.fn(async () => {
      throw new Error("download refused")
    })
    let call = 0
    const { ctx, warn } = makeCtx({
      emit,
      fetchAttachment,
      getUpdates: () => {
        call += 1
        if (call === 1)
          return {
            ret: 0,
            msgs: [
              {
                ...userMsg("", "ctx-img"),
                item_list: [
                  {
                    type: ILINK_ITEM.image,
                    image_item: { url: "https://cdn/enc.jpg", aes_key: "a2V5" },
                  },
                  {
                    type: ILINK_ITEM.image,
                    image_item: { media: { full_url: "https://cdn/second.jpg", aes_key: "a2V5" } },
                  },
                  {
                    type: ILINK_ITEM.voice,
                    voice_item: { media: { full_url: "https://cdn/voice" } },
                  },
                  {
                    type: ILINK_ITEM.video,
                    video_item: { media: { full_url: "https://cdn/video" } },
                  },
                  {
                    type: ILINK_ITEM.file,
                    file_item: { media: { full_url: "https://cdn/file" }, file_name: "file.pdf" },
                  },
                ],
              },
            ],
          }
        return { ret: -14 }
      },
    })
    const a = adapter()
    await a.start(ctx)
    for (let i = 0; i < 20 && emit.mock.calls.length === 0; i++) await tick()

    expect(fetchAttachment).toHaveBeenCalledWith("wx1", "https://cdn/enc.jpg")
    expect(fetchAttachment).toHaveBeenCalledWith("wx1", "https://cdn/second.jpg")
    for (const name of ["voice", "video", "file"])
      expect(fetchAttachment).toHaveBeenCalledWith("wx1", `https://cdn/${name}`)
    const ev = emit.mock.calls[0][0] as NormalizedInboundEvent
    expect(ev.segments[0]).toMatchObject({ type: "image", url: "", alt: "[unavailable image]" })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("download refused"))
    await a.stop()
  })
})

describe("createWechatPersonalAdapter — poll failure classification", () => {
  it("degrades with bad_response and logs when the body is not JSON", async () => {
    const { ctx, warn } = makeCtx({
      emit: jest.fn(async () => undefined),
      getUpdates: () => "<html>gateway error</html>",
    })
    const a = adapter()
    await a.start(ctx)
    for (let i = 0; i < 20 && a.health().reason !== "bad_response"; i++) await tick()
    expect(a.health().state).toBe("degraded")
    expect(a.health().reason).toBe("bad_response")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("non-JSON"))
    await a.stop()
  })

  it("degrades with token_missing when the keyring has no bot token", async () => {
    const { ctx, warn } = makeCtx({
      emit: jest.fn(async () => undefined),
      getUpdates: () => ({ ret: 0 }),
    })
    const a = createWechatPersonalAdapter({
      id: "wx1",
      displayName: "My WeChat",
      token: async () => "",
      baseUrl: async () => "https://base",
      _backoffBaseMs: 1,
    })
    await a.start(ctx)
    for (let i = 0; i < 20 && a.health().reason !== "token_missing"; i++) await tick()
    expect(a.health().state).toBe("degraded")
    expect(a.health().reason).toBe("token_missing")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("token missing"))
    await a.stop()
  })

  it("degrades with network_error and logs when the HTTP proxy throws", async () => {
    const { ctx, warn } = makeCtx({
      emit: jest.fn(async () => undefined),
      getUpdates: () => {
        throw new Error("socket hang up")
      },
    })
    const a = adapter()
    await a.start(ctx)
    for (let i = 0; i < 20 && a.health().reason !== "network_error"; i++) await tick()
    expect(a.health().state).toBe("degraded")
    expect(a.health().reason).toBe("network_error")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("socket hang up"))
    await a.stop()
  })

  it("tolerates a trailing slash on the persisted base URL", async () => {
    const { ctx, http } = makeCtx({
      emit: jest.fn(async () => undefined),
      getUpdates: () => ({ ret: -14 }),
    })
    const a = createWechatPersonalAdapter({
      id: "wx1",
      displayName: "My WeChat",
      token: async () => "tok",
      baseUrl: async () => "https://base///",
      _backoffBaseMs: 1,
    })
    await a.start(ctx)
    for (let i = 0; i < 10 && http.mock.calls.length === 0; i++) await tick()
    expect((http.mock.calls[0][0] as { url: string }).url).toBe("https://base/ilink/bot/getupdates")
    await a.stop()
  })
})

describe("createWechatPersonalAdapter — lifecycle (abortable backoff)", () => {
  const longBackoffAdapter = () =>
    createWechatPersonalAdapter({
      id: "wx1",
      displayName: "My WeChat",
      token: async () => "tok",
      baseUrl: async () => "https://base",
      _backoffBaseMs: 60_000,
    })

  it("stop() wakes a pending backoff delay promptly", async () => {
    jest.useFakeTimers()
    try {
      const { ctx } = makeCtx({
        emit: jest.fn(async () => undefined),
        getUpdates: () => ({ ret: 1, errmsg: "boom" }),
      })
      const a = longBackoffAdapter()
      await a.start(ctx)
      await flushMicrotasks()
      expect(jest.getTimerCount()).toBeGreaterThan(0) // parked in a long backoff
      await a.stop()
      await flushMicrotasks()
      expect(jest.getTimerCount()).toBe(0) // delay woken, timer cleared, loop exited
      expect(a.health().state).toBe("down")
    } finally {
      jest.useRealTimers()
    }
  })

  it("exits the loop when ctx.signal aborts during backoff", async () => {
    jest.useFakeTimers()
    try {
      const { ctx, http, abort } = makeCtx({
        emit: jest.fn(async () => undefined),
        getUpdates: () => ({ ret: 1 }),
      })
      const a = longBackoffAdapter()
      await a.start(ctx)
      await flushMicrotasks()
      const callsBeforeAbort = http.mock.calls.length
      expect(jest.getTimerCount()).toBeGreaterThan(0)
      abort.abort()
      await flushMicrotasks()
      expect(jest.getTimerCount()).toBe(0)
      jest.advanceTimersByTime(60 * 60_000)
      await flushMicrotasks()
      expect(http.mock.calls.length).toBe(callsBeforeAbort) // no more polls
    } finally {
      jest.useRealTimers()
    }
  })

  it("resets the backoff attempt counter on start()", async () => {
    jest.useFakeTimers()
    try {
      const { ctx, http } = makeCtx({
        emit: jest.fn(async () => undefined),
        getUpdates: () => ({ ret: 1 }),
      })
      const a = createWechatPersonalAdapter({
        id: "wx1",
        displayName: "My WeChat",
        token: async () => "tok",
        baseUrl: async () => "https://base",
        _backoffBaseMs: 1000,
      })
      await a.start(ctx)
      await flushMicrotasks() // poll #1 → attempts=1, backoff ≤ 2500ms
      jest.advanceTimersByTime(2600)
      await flushMicrotasks() // poll #2 → attempts=2, backoff ≤ 5000ms
      jest.advanceTimersByTime(5100)
      await flushMicrotasks() // poll #3 → attempts=3
      expect(http.mock.calls.length).toBe(3)
      await a.stop()
      await flushMicrotasks()

      await a.start(ctx)
      await flushMicrotasks() // poll #4 on the fresh loop
      expect(http.mock.calls.length).toBe(4)
      // attempts was reset: the next retry lands within ≤2500ms. Had the
      // counter carried over (attempts=4 → ≥16s), it would not fire here.
      jest.advanceTimersByTime(2600)
      await flushMicrotasks()
      expect(http.mock.calls.length).toBe(5)
      await a.stop()
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("createWechatPersonalAdapter — numeric reply → callback short-circuit", () => {
  beforeEach(() => {
    jest.resetModules()
    const storage = jest.requireMock<typeof import("@/lib/db/adapter-instances")>(
      "@/lib/db/adapter-instances"
    )
    const row = { settings: {} }
    ;(storage.getAdapterInstance as jest.Mock).mockResolvedValue(row)
    ;(storage.commitWechatPersonalCheckpoint as jest.Mock).mockImplementation(
      async (
        _id: string,
        _expected: unknown,
        next: Record<string, unknown>,
        isCurrent: () => boolean
      ) => {
        if (!isCurrent()) return false
        Object.assign(row.settings, { ilinkCheckpoint: next })
        return true
      }
    )
  })

  it("retries the original callback before advancing the cursor and deduplicates its replay after restart", async () => {
    const {
      setNumericAction,
      __resetNumericActionRegistryForTesting,
      __peekNumericActionForTesting,
    } = await import("./numeric-action-registry")
    __resetNumericActionRegistryForTesting()
    const conv = "wechat-personal:wx1:alice@im.wechat"
    setNumericAction(conv, 1, "old-action")
    const dispatch = jest.fn<Promise<"retry" | "terminal">, [{ triggerId: string }]>(
      async (_event) => {
        if (dispatch.mock.calls.length === 1) {
          setNumericAction(conv, 1, "new-action")
          return "retry"
        }
        return "terminal"
      }
    )
    jest.doMock("@/lib/connectors/bus", () => ({
      getBus: () => ({ dispatchConnectorCallback: dispatch }),
    }))
    const { createWechatPersonalAdapter: factory } = await import("./index")
    const message = { ...userMsg("1"), message_id: "numeric-message" }
    const emit = jest.fn()
    let polls = 0
    const { ctx, http } = makeCtx({
      emit,
      getUpdates: () =>
        ++polls <= 3 ? { ret: 0, msgs: [message], get_updates_buf: "next-cursor" } : { ret: -14 },
    })
    const options = {
      id: "wx1",
      displayName: "Test",
      token: async () => "synthetic",
      _backoffBaseMs: 1,
    }
    const adapter = factory(options)
    await adapter.start(ctx)
    for (let i = 0; i < 40 && polls < 4; i++) await tick()
    await adapter.stop()
    expect(dispatch.mock.calls.map(([event]) => event.triggerId)).toEqual([
      "old-action",
      "old-action",
    ])
    const requests = http.mock.calls.map(([request]) =>
      JSON.parse((request as unknown as { body: string }).body)
    )
    expect(requests[1].get_updates_buf).toBe("")
    expect(requests[2].get_updates_buf).toBe("next-cursor")
    expect(__peekNumericActionForTesting(conv, 1)).toBe("new-action")
    expect(emit).not.toHaveBeenCalled()

    // A fresh adapter still recognizes the durable message receipt, even
    // when the same digit now names a different menu action.
    let replays = 0
    const restartedContext = makeCtx({
      emit,
      getUpdates: () => (++replays === 1 ? { ret: 0, msgs: [message] } : { ret: -14 }),
    })
    const restarted = factory(options)
    await restarted.start(restartedContext.ctx)
    for (let i = 0; i < 20 && replays < 2; i++) await tick()
    await restarted.stop()
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(emit).not.toHaveBeenCalled()
    jest.dontMock("@/lib/connectors/bus")
  })

  it("dispatches a numeric reply through dispatchConnectorCallback when a binding is live", async () => {
    const { __resetNumericActionRegistryForTesting, setNumericAction } =
      await import("./numeric-action-registry")
    __resetNumericActionRegistryForTesting()
    const conv = "wechat-personal:wx1:alice@im.wechat"
    setNumericAction(conv, 1, "a2ui:s1:y:confirm")

    const dispatchSpy = jest.fn(async (_e: unknown) => "terminal")
    jest.doMock("@/lib/connectors/bus", () => ({
      getBus: () => ({ dispatchConnectorCallback: dispatchSpy }),
    }))
    const { createWechatPersonalAdapter: factory } = await import("./index")

    const emit = jest.fn(async () => undefined)
    let call = 0
    const { ctx } = makeCtx({
      emit,
      getUpdates: () => {
        call += 1
        if (call === 1) return { ret: 0, msgs: [userMsg("1")] }
        return { ret: -14 }
      },
    })
    const a = factory({
      id: "wx1",
      displayName: "My WeChat",
      token: async () => "tok",
      baseUrl: async () => "https://base",
      _backoffBaseMs: 1,
    })
    await a.start(ctx)
    for (let i = 0; i < 10 && dispatchSpy.mock.calls.length === 0; i++) await tick()

    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    const ev = dispatchSpy.mock.calls[0][0] as { triggerId: string; conversationKey: string }
    expect(ev.triggerId).toBe("a2ui:s1:y:confirm")
    expect(ev.conversationKey).toBe(conv)
    // Regular message emit must NOT fire for the same turn.
    expect(emit).not.toHaveBeenCalled()
    await a.stop()
    jest.dontMock("@/lib/connectors/bus")
  })

  it("falls through to emit() when the digit has no live binding", async () => {
    const { __resetNumericActionRegistryForTesting } = await import("./numeric-action-registry")
    __resetNumericActionRegistryForTesting()

    const dispatchSpy = jest.fn(async (_e: unknown) => "terminal")
    jest.doMock("@/lib/connectors/bus", () => ({
      getBus: () => ({ dispatchConnectorCallback: dispatchSpy }),
    }))
    const { createWechatPersonalAdapter: factory } = await import("./index")

    const emit = jest.fn(async () => undefined)
    let call = 0
    const { ctx } = makeCtx({
      emit,
      getUpdates: () => {
        call += 1
        if (call === 1) return { ret: 0, msgs: [userMsg("1")] }
        return { ret: -14 }
      },
    })
    const a = factory({
      id: "wx1",
      displayName: "My WeChat",
      token: async () => "tok",
      baseUrl: async () => "https://base",
      _backoffBaseMs: 1,
    })
    await a.start(ctx)
    for (let i = 0; i < 10 && emit.mock.calls.length === 0; i++) await tick()

    expect(dispatchSpy).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledTimes(1)
    await a.stop()
    jest.dontMock("@/lib/connectors/bus")
  })
})

describe("outbound encrypted media integration", () => {
  const ref: WechatPersonalConversationRef = {
    platform: "wechat-personal",
    adapterId: "wx1",
    userId: "user",
    contextToken: "ctx",
  }
  beforeEach(() => {
    mockCdnFetch.mockReset()
    mockCdnFetch.mockResolvedValue({
      status: 200,
      headers: new Headers({ "x-encrypted-param": "download" }),
    })
  })
  it("uploads all media then publishes individual ordered items with stable client IDs", async () => {
    const { ctx, http } = makeCtx({ emit: jest.fn(), getUpdates: () => ({ ret: -14 }) })
    const a = adapter()
    await a.start(ctx)
    await tick()
    http.mockClear()
    http.mockImplementation(async (req) => ({
      status: 200,
      headers: {},
      body: JSON.stringify(req.url.includes("getuploadurl") ? { upload_param: "signed" } : {}),
    }))
    const request = {
      conversationRef: ref,
      segments: [
        { type: "text" as const, text: "caption" },
        { type: "image" as const, url: "data:image/png;base64,AQID" },
        { type: "video" as const, url: "data:video/mp4;base64,AQID" },
        {
          type: "file" as const,
          url: "data:application/pdf;base64,AQID",
          name: "a.pdf",
          mimeType: "application/pdf",
          sizeBytes: 3,
        },
        { type: "voice" as const, url: "data:audio/mpeg;base64,AQID" },
      ],
      metadata: { idempotencyKey: "stable" },
    }
    const result = await a.send(request)
    expect(result.ok).toBe(true)
    expect(http.mock.calls.slice(0, 4).every(([req]) => req.url.includes("getuploadurl"))).toBe(
      true
    )
    const sent = http.mock.calls
      .filter(([req]) => req.url.includes("sendmessage"))
      .map(([req]) => JSON.parse(req.body).msg)
    expect(sent.map((msg) => msg.item_list[0].type)).toEqual([1, 2, 5, 4, 4])
    expect(sent.every((msg) => msg.item_list.length === 1 && msg.context_token === "ctx")).toBe(
      true
    )
    expect(new Set(sent.map((msg) => msg.client_id)).size).toBe(5)
    expect(result.downgrades).toEqual([
      { from: "voice", to: "file", reason: "ilink_audio_sent_as_file" },
    ])
    expect(result.platformMessageId).toBe(sent[4].client_id)
    http.mockClear()
    await a.send(request)
    expect(
      http.mock.calls
        .filter(([req]) => req.url.includes("sendmessage"))
        .map(([req]) => JSON.parse(req.body).msg.client_id)
    ).toEqual(sent.map((msg) => msg.client_id))
    await a.stop()
  })
  it("does not publish captions when upload fails", async () => {
    const { ctx, http } = makeCtx({ emit: jest.fn(), getUpdates: () => ({ ret: -14 }) })
    const a = adapter()
    await a.start(ctx)
    await tick()
    http.mockClear()
    http.mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({ upload_param: "signed" }),
    })
    mockCdnFetch.mockResolvedValue({ status: 403 })
    const result = await a.send({
      conversationRef: ref,
      segments: [
        { type: "text", text: "caption" },
        { type: "image", url: "data:image/png;base64,AQID" },
      ],
      metadata: { idempotencyKey: "failed" },
    })
    expect(result).toMatchObject({ ok: false, error: { retryable: false } })
    expect(http.mock.calls.some(([req]) => req.url.includes("sendmessage"))).toBe(false)
    await a.stop()
  })
  it("requires reconciliation after partial delivery", async () => {
    const { ctx, http } = makeCtx({ emit: jest.fn(), getUpdates: () => ({ ret: -14 }) })
    const a = adapter()
    await a.start(ctx)
    await tick()
    http.mockClear()
    http
      .mockResolvedValueOnce({ status: 200, headers: {}, body: "{}" })
      .mockRejectedValueOnce(new Error("disconnected"))
    const result = await a.send({
      conversationRef: ref,
      segments: [{ type: "text", text: "x".repeat(2001) }],
      metadata: { idempotencyKey: "partial" },
    })
    expect(result).toMatchObject({
      ok: false,
      platformMessageId: expect.any(String),
      error: { code: "reconciliation_required", retryable: false },
    })
    await a.stop()
  })
})
