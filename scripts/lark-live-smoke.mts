/**
 * Live Lark smoke harness — drives the REAL adapter code
 * (lib/connectors/adapters/lark/) against the REAL Feishu OpenAPI with the
 * credentials supplied via env vars. No mocks on the wire: the only
 * substitution is the Tauri command invoker, remapped to Node fetch +
 * an in-memory keyring (`setConnectorCommandInvoker` — the same seam the
 * headless brain uses).
 *
 * Usage (PowerShell):
 *   $env:LARK_APP_ID="cli_..."; $env:LARK_APP_SECRET="..."; \
 *     npx tsx scripts/lark-live-smoke.mts
 *
 * Optional:
 *   LARK_TEST_CHAT_ID=oc_...   pin the target chat (skips list/create)
 *   LARK_SMOKE_KEEP=1          don't delete the messages it sent
 *
 * Scope of coverage (all through adapter code, not raw HTTP):
 *   tenant token · whoami probe · chat list/create · send text
 *   (platformMessageId feedback) · edit text (PUT) · reply (dedicated
 *   endpoint) · A2UI interactive card send · card edit (PATCH) · reaction
 *   add · image upload + image segment send · fetchHistory + mention parse
 *   · delete · resolveContacts (scope-tolerant)
 *
 * NOT covered here (needs the Tauri Rust host): the long-connection
 * transport (protobuf framing lives in src-tauri/src/connectors/lark_ws.rs)
 * and webhook ingress. Verify those via `pnpm tauri dev`.
 */

import "fake-indexeddb/auto"

// ── Minimal browser-global stubs (Dexie needs indexedDB only; some modules
// touch localStorage defensively) ────────────────────────────────────────────
// getDb() refuses to run "on the server" (typeof window === "undefined");
// this harness IS the client — give it a window.
if (typeof (globalThis as Record<string, unknown>).window === "undefined") {
  ;(globalThis as Record<string, unknown>).window = globalThis
}
function makeStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}
for (const name of ["localStorage", "sessionStorage"]) {
  if (typeof (globalThis as Record<string, unknown>)[name] === "undefined") {
    ;(globalThis as Record<string, unknown>)[name] = makeStorage()
  }
}

const APP_ID = process.env.LARK_APP_ID ?? ""
const APP_SECRET = process.env.LARK_APP_SECRET ?? ""
if (!APP_ID || !APP_SECRET) {
  console.error("Set LARK_APP_ID and LARK_APP_SECRET env vars first.")
  process.exit(1)
}

const ADAPTER_ID = "lark-live-smoke"
const KEEP = process.env.LARK_SMOKE_KEEP === "1"

// ── Invoker: Tauri commands → Node fetch / in-memory keyring ────────────────
const keyring = new Map<string, string>()
keyring.set(`${ADAPTER_ID}:appId`, APP_ID)
keyring.set(`${ADAPTER_ID}:appSecret`, APP_SECRET)

async function httpRequest(req: {
  url: string
  method: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const resp = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal: AbortSignal.timeout(req.timeoutMs ?? 30_000),
  })
  const headers: Record<string, string> = {}
  resp.headers.forEach((v, k) => (headers[k] = v))
  return { status: resp.status, headers, body: await resp.text() }
}

async function fetchBytes(sourceUrl: string): Promise<Blob> {
  const resp = await fetch(sourceUrl, { signal: AbortSignal.timeout(30_000) })
  if (!resp.ok) throw new Error(`fetch ${sourceUrl} → ${resp.status}`)
  return await resp.blob()
}

async function uploadImage(args: {
  accessToken: string
  sourceUrl: string
  imageType?: string
}): Promise<string> {
  const blob = await fetchBytes(args.sourceUrl)
  const form = new FormData()
  form.set("image_type", args.imageType ?? "message")
  form.set("image", blob, "image.png")
  const resp = await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
    method: "POST",
    headers: { Authorization: `Bearer ${args.accessToken}` },
    body: form,
  })
  const parsed = (await resp.json()) as {
    code: number
    msg?: string
    data?: { image_key?: string }
  }
  if (parsed.code !== 0 || !parsed.data?.image_key) {
    throw new Error(`lark image upload failed: code=${parsed.code} msg=${parsed.msg}`)
  }
  return parsed.data.image_key
}

async function uploadFile(args: {
  accessToken: string
  sourceUrl: string
  fileType?: string
  fileName?: string
  durationMs?: number
}): Promise<string> {
  const blob = await fetchBytes(args.sourceUrl)
  const form = new FormData()
  form.set("file_type", args.fileType ?? "stream")
  form.set("file_name", args.fileName ?? "file.bin")
  if (typeof args.durationMs === "number") form.set("duration", String(args.durationMs))
  form.set("file", blob, args.fileName ?? "file.bin")
  const resp = await fetch("https://open.feishu.cn/open-apis/im/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${args.accessToken}` },
    body: form,
  })
  const parsed = (await resp.json()) as {
    code: number
    msg?: string
    data?: { file_key?: string }
  }
  if (parsed.code !== 0 || !parsed.data?.file_key) {
    throw new Error(`lark file upload failed: code=${parsed.code} msg=${parsed.msg}`)
  }
  return parsed.data.file_key
}

// ── Wire the invoker BEFORE importing any adapter module ────────────────────
const { setConnectorCommandInvoker } = await import("../lib/connectors/tauri/commands")
setConnectorCommandInvoker(async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
  switch (name) {
    case "connectors_http_request":
      return (await httpRequest(args!.req as Parameters<typeof httpRequest>[0])) as T
    case "connectors_keyring_get":
      return (keyring.get(`${args!.adapterId}:${args!.credential}`) ?? null) as T
    case "connectors_keyring_set":
      keyring.set(`${args!.adapterId}:${args!.credential}`, String(args!.value))
      return undefined as T
    case "connectors_keyring_delete":
      keyring.delete(`${args!.adapterId}:${args!.credential}`)
      return undefined as T
    case "connectors_keyring_list": {
      const wanted = (args!.accounts as string[]) ?? []
      return wanted.filter((a) => keyring.has(`${args!.adapterId}:${a}`)) as T
    }
    case "connectors_lark_upload_image":
      return (await uploadImage(args as never)) as T
    case "connectors_lark_upload_file":
      return (await uploadFile(args as never)) as T
    default:
      throw new Error(`live-smoke invoker: unmapped command '${name}'`)
  }
})

// ── Import the real adapter stack (after invoker swap) ──────────────────────
const { createLarkAdapter } = await import("../lib/connectors/adapters/lark/index")
const { probeBotIdentity } = await import("../lib/connectors/adapters/lark/whoami")
const { larkTenantRequest } = await import("../lib/connectors/adapters/lark/http")
const { getTenantAccessToken } = await import("../lib/connectors/adapters/lark/auth")
const { getDb } = await import("../lib/db/schema")
const eventMod = await import("../types/connectors/event")
type AnyEvent = import("../types/connectors/event").NormalizedInboundEvent
type OutboundReq = import("../types/connectors/outbound").OutboundRequest

const creds = { appId: APP_ID, appSecret: APP_SECRET }

// ── Result collection ────────────────────────────────────────────────────────
type StepResult = { step: string; status: "PASS" | "FAIL" | "SKIP"; detail: string }
const results: StepResult[] = []
function record(step: string, status: StepResult["status"], detail = ""): void {
  results.push({ step, status, detail })
  const icon = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "—"
  console.log(`  ${icon} [${status}] ${step}${detail ? ` — ${detail}` : ""}`)
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const v = await fn()
    record(name, "PASS", typeof v === "string" ? v : "")
    return v
  } catch (err) {
    record(name, "FAIL", err instanceof Error ? err.message : String(err))
    return undefined
  }
}

// ── Scenario ─────────────────────────────────────────────────────────────────
console.log(`\nLark live smoke — app ${APP_ID}, adapter '${ADAPTER_ID}'\n`)

// 0. Seed the Dexie adapter row (whoami persists into it).
await getDb().adapterInstances.put({
  id: ADAPTER_ID,
  type: "lark",
  displayName: "Lark Live Smoke",
  enabled: true,
  transportMode: "gateway",
  settings: {},
  credentialsRef: { keyringService: "smoke", accounts: ["appId", "appSecret"] },
  trigger: {} as never,
  defaultMode: "manual",
  createdAt: Date.now(),
  updatedAt: Date.now(),
} as never)

// 1. Tenant token.
await step("tenant_access_token", async () => {
  const tok = await getTenantAccessToken(creds)
  if (!tok.startsWith("t-")) throw new Error(`unexpected token shape: ${tok.slice(0, 8)}…`)
  return `token ok (${tok.slice(0, 8)}…)`
})

// 2. whoami probe → selfBotOpenId.
let selfBotOpenId = ""
await step("whoami probeBotIdentity", async () => {
  const who = await probeBotIdentity(ADAPTER_ID)
  selfBotOpenId = who.openId
  return `bot='${who.botName}' open_id=${who.openId}`
})

// 3. Build the adapter exactly like the registry does.
const adapter = createLarkAdapter({
  id: ADAPTER_ID,
  displayName: "Lark Live Smoke",
  appId: async () => APP_ID,
  appSecret: async () => APP_SECRET,
  verificationToken: async () => "",
  selfBotOpenId,
  transport: "long-connection",
})

// 4. Find a target chat: pinned env → first joined chat → create one.
let chatId = process.env.LARK_TEST_CHAT_ID ?? ""
if (!chatId) {
  await step("list joined chats (/im/v1/chats)", async () => {
    const resp = (await larkTenantRequest(creds, "GET", "/im/v1/chats?page_size=20")) as {
      data?: { items?: Array<{ chat_id: string; name?: string }> }
    } | null
    const items = resp?.data?.items ?? []
    const smoke = items.find((c) => c.name === "Cognia Live Smoke")
    chatId = (smoke ?? items[0])?.chat_id ?? ""
    return chatId
      ? `${items.length} chats; using ${chatId}`
      : `bot is in ${items.length} chats — will create one`
  })
}
if (!chatId) {
  await step("createChat('Cognia Live Smoke')", async () => {
    if (!adapter.createChat) throw new Error("adapter.createChat missing")
    const res = await adapter.createChat({
      name: "Cognia Live Smoke",
      memberIds: [],
      description: "cognia-next live smoke harness",
    })
    chatId = res.chatId
    return chatId
  })
}
if (!chatId) {
  console.error("\nNo target chat available — aborting message scenarios.")
  printSummary()
  process.exit(1)
}

const conversationRef = { platform: "lark", adapterId: ADAPTER_ID, channelId: chatId } as never
const mkReq = (segments: OutboundReq["segments"], extra?: Partial<OutboundReq>): OutboundReq => ({
  conversationRef,
  segments,
  metadata: { idempotencyKey: `smoke:${Date.now()}:${Math.random().toString(36).slice(2, 8)}` },
  ...extra,
})

const sentIds: string[] = []

// 5. Send text → platformMessageId feedback (the fix under test).
let textMsgId = ""
await step("send text → platformMessageId", async () => {
  const res = await adapter.send(mkReq([{ type: "text", text: "[smoke] hello from cognia live harness" }]))
  if (!res.ok) throw new Error(res.error?.message ?? "send failed")
  if (!res.platformMessageId?.startsWith("om_")) {
    throw new Error(`platformMessageId not surfaced: ${JSON.stringify(res)}`)
  }
  textMsgId = res.platformMessageId
  sentIds.push(textMsgId)
  return textMsgId
})

// 6. Edit text (PUT /im/v1/messages/:id).
if (textMsgId) {
  await step("edit text (PUT)", async () => {
    if (!adapter.edit) throw new Error("adapter.edit missing")
    const res = await adapter.edit(
      textMsgId,
      mkReq([{ type: "text", text: "[smoke] hello (edited in place)" }])
    )
    if (!res.ok) throw new Error(res.error?.message ?? "edit failed")
    if (res.platformMessageId !== textMsgId) throw new Error("edit did not echo message id")
    return "edited"
  })
}

// 7. Reply via the dedicated endpoint (the serialize fix under test).
if (textMsgId) {
  await step("reply to message (POST /reply)", async () => {
    const res = await adapter.send(
      mkReq([{ type: "text", text: "[smoke] this is a reply (quoted)" }], {
        replyTo: { messageId: textMsgId },
      })
    )
    if (!res.ok) throw new Error(res.error?.message ?? "reply failed")
    if (res.platformMessageId) sentIds.push(res.platformMessageId)
    return res.platformMessageId ?? "(no id)"
  })
}

// 8. Reaction add → capture reaction_id → remove.
let reactionId = ""
if (textMsgId && adapter.addReaction) {
  await step("addReaction THUMBSUP", async () => {
    const ref = await adapter.addReaction!(textMsgId, "THUMBSUP")
    reactionId = (ref && typeof ref === "object" && "reactionId" in ref ? ref.reactionId : "") ?? ""
    return reactionId ? `reacted (reaction_id ${reactionId})` : "reacted (no id surfaced)"
  })
}
if (textMsgId && reactionId && adapter.removeReaction) {
  await step("removeReaction", async () => {
    await adapter.removeReaction!(textMsgId, reactionId)
    return "removed"
  })
}

// 9. A2UI interactive card send + PATCH edit.
let cardMsgId = ""
await step("send A2UI interactive card", async () => {
  const surface = {
    components: {
      root: {
        id: "root",
        component: "Card",
        title: "Cognia smoke card",
        children: ["t1", "b1"],
      },
      t1: { id: "t1", component: "Text", text: "Live harness A2UI projection." },
      b1: { id: "b1", component: "Button", text: "Acknowledge", action: "ack", variant: "primary" },
    },
    dataModel: {},
    rootId: "root",
  }
  const res = await adapter.send(
    mkReq([
      {
        type: "a2ui",
        surfaceId: `sfc_smoke_${Date.now()}`,
        content: surface,
        plainTextMirror: "Cognia smoke card — Acknowledge",
      } as never,
    ])
  )
  if (!res.ok) throw new Error(res.error?.message ?? "card send failed")
  cardMsgId = res.platformMessageId ?? ""
  if (cardMsgId) sentIds.push(cardMsgId)
  return cardMsgId || "(sent, no id)"
})

if (cardMsgId) {
  await step("edit card (PATCH)", async () => {
    const surface = {
      components: {
        root: { id: "root", component: "Card", title: "Cognia smoke card (updated)", children: ["t1"] },
        t1: { id: "t1", component: "Text", text: "Card updated via PATCH — edit path OK." },
      },
      dataModel: {},
      rootId: "root",
    }
    const res = await adapter.edit!(
      cardMsgId,
      mkReq([
        {
          type: "a2ui",
          surfaceId: `sfc_smoke_edit_${Date.now()}`,
          content: surface,
          plainTextMirror: "Cognia smoke card (updated)",
        } as never,
      ])
    )
    if (!res.ok) throw new Error(res.error?.message ?? "card edit failed")
    return "patched"
  })
}

// 10. Image segment (upload pre-pass → img in message).
await step("send image segment (upload pre-pass)", async () => {
  const res = await adapter.send(
    mkReq([
      {
        type: "image",
        url: "https://raw.githubusercontent.com/github/explore/main/topics/nodejs/nodejs.png",
        alt: "smoke image",
      } as never,
    ])
  )
  if (!res.ok) throw new Error(res.error?.message ?? "image send failed")
  if (res.platformMessageId) sentIds.push(res.platformMessageId)
  return res.platformMessageId ?? "(sent)"
})

// 10b. File segment (upload pre-pass → file card). Exercises the
// connectors_lark_upload_file invoker path, unreached by the image step.
await step("send file segment (upload pre-pass)", async () => {
  const res = await adapter.send(
    mkReq([
      {
        type: "file",
        url: "https://raw.githubusercontent.com/github/gitignore/main/Node.gitignore",
        fileName: "smoke.gitignore",
      } as never,
    ])
  )
  if (!res.ok) throw new Error(res.error?.message ?? "file send failed")
  if (res.platformMessageId) sentIds.push(res.platformMessageId)
  return res.platformMessageId ?? "(sent)"
})

// 10c. Forward the text message to the same chat.
if (textMsgId && adapter.forwardMessage) {
  await step("forwardMessage → same chat", async () => {
    const res = await adapter.forwardMessage!({ messageId: textMsgId, target: chatId })
    if (!res.ok) throw new Error(res.error?.message ?? "forward failed")
    if (res.platformMessageId) sentIds.push(res.platformMessageId)
    return res.platformMessageId ?? "(forwarded)"
  })
}

// 10d. Merge-forward the text + card messages into one combined card.
const mergeIds = [textMsgId, cardMsgId].filter(Boolean)
if (mergeIds.length >= 2 && adapter.forwardMessage) {
  await step("mergeForward (text + card)", async () => {
    const res = await adapter.forwardMessage!({ messageIds: mergeIds, target: chatId })
    if (!res.ok) throw new Error(res.error?.message ?? "merge-forward failed")
    if (res.platformMessageId) sentIds.push(res.platformMessageId)
    return res.platformMessageId ?? "(merged)"
  })
}

// 10e. Pin then unpin the text message.
if (textMsgId && adapter.pinMessage && adapter.unpinMessage) {
  const convKey = eventMod.buildConversationKey("lark", ADAPTER_ID, chatId)
  await step("pinMessage", async () => {
    await adapter.pinMessage!(convKey, textMsgId)
    return "pinned"
  })
  await step("unpinMessage", async () => {
    await adapter.unpinMessage!(textMsgId)
    return "unpinned"
  })
}

// 10f. Read-receipt query — who has read our text message (feedback).
if (textMsgId && adapter.getReadReceipt) {
  await step("getReadReceipt", async () => {
    const rr = await adapter.getReadReceipt!(textMsgId)
    if (!Array.isArray(rr.readers)) throw new Error("read receipt shape invalid")
    return `${rr.readers.length} reader(s), hasMore=${rr.hasMore}`
  })
}

// 10g. Presence 系统状态 badge (scope-tolerant — needs personal_settings scope).
if (adapter.setPresenceStatus) {
  try {
    await adapter.setPresenceStatus({
      text: "[smoke] live",
      targetUserIds: selfBotOpenId ? [selfBotOpenId] : [],
      expiresAt: Date.now() + 5 * 60_000,
    } as never)
    record("setPresenceStatus", "PASS", "status set")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 曼波 lacks personal_settings:status:system_status_update — a valid
    // icon_key + title reaches the permission check and returns 99991672.
    if (/scope|permission|99991672|99992402|no id/i.test(msg)) {
      record("setPresenceStatus", "SKIP", `needs personal_settings scope: ${msg.slice(0, 90)}`)
    } else {
      record("setPresenceStatus", "FAIL", msg)
    }
  }
}

// 11. fetchHistory round-trip — our own sends must come back parsed.
await step("fetchHistory parses live messages", async () => {
  if (!adapter.fetchHistory) throw new Error("adapter.fetchHistory missing")
  const key = eventMod.buildConversationKey("lark", ADAPTER_ID, chatId)
  const events: AnyEvent[] = []
  for await (const ev of adapter.fetchHistory(key, { max: 30 })) events.push(ev)
  if (events.length === 0) throw new Error("history returned 0 events")
  const sawOurs = events.some((e) => e.plainText?.includes("[smoke]"))
  if (!sawOurs) {
    const preview = events.map((e) => e.plainText?.slice(0, 40) ?? "(no text)").join(" | ")
    throw new Error(`history has ${events.length} events but none from this run: ${preview}`)
  }
  return `${events.length} events, run messages visible`
})

// 12. resolveContacts (scope-tolerant).
try {
  if (!adapter.resolveContacts) throw new Error("adapter.resolveContacts missing")
  const out = await adapter.resolveContacts({ query: "a", limit: 3 } as never)
  record("resolveContacts", "PASS", `ok (${Array.isArray(out) ? out.length : 0} candidates)`)
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (/scope|permission|connected user identity/i.test(msg)) {
    record("resolveContacts", "SKIP", `needs user OAuth / scope: ${msg.slice(0, 100)}`)
  } else {
    record("resolveContacts", "FAIL", msg)
  }
}

// ── V2: outbound-runner dispatch + F1 truthful-failover proof ────────────────
// Wire the REAL ConnectorBus outbound runner in Node against live Feishu: the
// direct adapter.send() steps above never exercise the dispatch mechanism
// (queue → runner → adapter → live). Here we enqueue and drive it end-to-end,
// then prove F1 — a balanced reroute to a sibling bot is reported as the
// sibling's real delivery, not a false failure.
{
  const { startOutboundRunner } = await import("../lib/connectors/outbound-runner")
  const { enqueueOutbound, waitForOutboundTerminal } = await import("../lib/db/outbound-jobs")

  const runnerAbort = new AbortController()
  const adapters = new Map<string, typeof adapter>([[ADAPTER_ID, adapter]])
  void startOutboundRunner({ adapters, signal: runnerAbort.signal, pollIntervalMs: 500 })
  const convKey = eventMod.buildConversationKey("lark", ADAPTER_ID, chatId)

  // 14a. Single dispatch through the durable queue → live send → terminal.
  await step("runner dispatch → sent", async () => {
    const job = await enqueueOutbound({
      adapterId: ADAPTER_ID,
      conversationKey: convKey,
      request: mkReq([{ type: "text", text: "[smoke] via outbound runner" }]),
      source: "manual",
    })
    const terminal = await waitForOutboundTerminal(job.id, 25_000)
    if (!terminal) throw new Error("job vanished")
    if (terminal.status !== "sent") {
      throw new Error(`expected sent, got ${terminal.status} (${terminal.lastErrorCode ?? "?"})`)
    }
    if (terminal.platformMessageId) sentIds.push(terminal.platformMessageId)
    return `sent via runner (${terminal.platformMessageId})`
  })

  // 14b. F1 — register a second lark instance sharing 曼波's creds, force the
  // primary's rate bucket to spill onto it, and assert the ORIGINAL job's
  // waitForOutboundTerminal follows the reroute pointer to the sibling's
  // real `sent` (the bug: it used to read `deadlettered` = false failure).
  const SIBLING_ID = "lark-live-smoke-sibling"
  keyring.set(`${SIBLING_ID}:appId`, APP_ID)
  keyring.set(`${SIBLING_ID}:appSecret`, APP_SECRET)
  const sibling = createLarkAdapter({
    id: SIBLING_ID,
    displayName: "Lark Live Smoke Sibling",
    appId: async () => APP_ID,
    appSecret: async () => APP_SECRET,
    verificationToken: async () => "",
    selfBotOpenId,
    transport: "long-connection",
  })
  adapters.set(SIBLING_ID, sibling)
  await getDb().adapterInstances.put({
    id: SIBLING_ID,
    type: "lark",
    displayName: "Lark Live Smoke Sibling",
    enabled: true,
    transportMode: "gateway",
    settings: {},
    credentialsRef: { keyringService: "smoke", accounts: ["appId", "appSecret"] },
    trigger: {} as never,
    defaultMode: "manual",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as never)
  // Primary: single-token bucket, negligible refill, sibling as balance target.
  await getDb().adapterInstances.update(ADAPTER_ID, {
    balanceAdapterIds: [SIBLING_ID],
    outboundTuning: { rateCapacity: 1, rateRefillPerSec: 0.01 },
  } as never)

  await step("F1: reroute reports sibling delivery (not a false failure)", async () => {
    // Two jobs on one lane: the first consumes the single token, the second
    // finds the bucket empty and load-balances onto the sibling.
    const jobA = await enqueueOutbound({
      adapterId: ADAPTER_ID,
      conversationKey: convKey,
      request: mkReq([{ type: "text", text: "[smoke] reroute A (primary)" }]),
      source: "manual",
    })
    const jobB = await enqueueOutbound({
      adapterId: ADAPTER_ID,
      conversationKey: convKey,
      request: mkReq([{ type: "text", text: "[smoke] reroute B (should spill)" }]),
      source: "manual",
    })
    const termA = await waitForOutboundTerminal(jobA.id, 25_000)
    if (termA?.platformMessageId) sentIds.push(termA.platformMessageId)
    const termB = await waitForOutboundTerminal(jobB.id, 25_000)
    if (!termB) throw new Error("jobB vanished")
    const rawB = await getDb().outboundQueue.get(jobB.id)
    if (rawB?.status === "deadlettered" && rawB.reroutedToJobId) {
      // Reroute happened — the followed terminal MUST be the sibling's real send.
      if (termB.status !== "sent" || !termB.platformMessageId) {
        throw new Error(`reroute followed but status=${termB.status} (F1 broken)`)
      }
      sentIds.push(termB.platformMessageId)
      return `rerouted ${jobB.id}→${rawB.reroutedToJobId}; followed to sibling sent ${termB.platformMessageId}`
    }
    // Token refilled before jobB ran — no reroute this run (still a valid send).
    if (termB.platformMessageId) sentIds.push(termB.platformMessageId)
    return `no reroute this run (jobB ${termB.status} on primary directly)`
  })

  runnerAbort.abort()
}

// 13. Delete everything we sent (unless KEEP).
if (!KEEP) {
  await step(`delete ${sentIds.length} sent messages`, async () => {
    if (!adapter.delete) throw new Error("adapter.delete missing")
    let deleted = 0
    const failures: string[] = []
    for (const id of sentIds) {
      try {
        await adapter.delete(id)
        deleted++
      } catch (err) {
        failures.push(`${id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (failures.length > 0) throw new Error(`deleted ${deleted}, failed: ${failures.join("; ")}`)
    return `deleted ${deleted}`
  })
}

printSummary()
process.exit(results.some((r) => r.status === "FAIL") ? 1 : 0)

function printSummary(): void {
  const pass = results.filter((r) => r.status === "PASS").length
  const fail = results.filter((r) => r.status === "FAIL").length
  const skip = results.filter((r) => r.status === "SKIP").length
  console.log(`\n── Summary: ${pass} pass, ${fail} fail, ${skip} skip ──`)
  for (const r of results.filter((x) => x.status === "FAIL")) {
    console.log(`  FAIL ${r.step}: ${r.detail}`)
  }
}
