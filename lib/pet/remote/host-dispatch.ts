// Host-side arms for remote pet care (ADR-0219).
//
// A paired phone cares for the DESKTOP pet. Its `pet_*` calls reach the
// companion server, ride the generic desktop-writes bridge
// (`src-tauri/src/companion_api/rpc/data_sync.rs`) to this renderer, and are
// delegated here by `lib/companion/desktop-write-source.ts`, the same way the
// `perf_*` family is. Everything that changes the pet goes through the code
// the desktop's own UI uses: the access gate for care actions, the shop for
// purchases and decor, `renamePet`, the single-flight hatch and
// `respondAsPet`. So XP, coins and cooldowns move once, in the one controller
// that owns them, and a phone is told what actually happened rather than what
// it asked for.
//
// Two hosts install the desktop-write source, and the bridge prefers a
// connected headless brain. The brain has no pet, so every write here answers
// `headless-host` there instead of pretending to run.

import type { AppSettings } from "@cognia/agent-config-types"
import type { PetActivityRow, PetProfile, PetSettings } from "@/types/pet"
import { normalizeCoins } from "@/types/pet"
import type { Platform } from "@/lib/platform/detect"
import { detectPlatform } from "@/lib/platform/detect"
import {
  checkInteractionAccepted,
  requestPetInteraction,
  type PetAccessDeps,
} from "@/lib/pet/access/gate"
import type { PetWindowRole } from "@/lib/pet/window-role"
import { emitPetEvent } from "@/lib/pet/events/pet-event-bus"
import {
  INTERACTION_COOLDOWN_MS,
  normalizeInteractionGate,
  remainingCooldownMs,
} from "@/lib/pet/interaction/gate"
import { getPetItem } from "@/lib/pet/economy/item-catalog"
import { consumeItem, purchaseItem } from "@/lib/pet/economy/shop"
import { enqueuePetWork, whenPetEventsSettled } from "@/lib/pet/runtime/pet-controller"
import { isPetControllerPresent } from "@/lib/pet/runtime/controller-presence"
import { hatchPetOnce, type HatchPetOutcome } from "@/lib/pet/runtime/hatch"
import { isValidPetName, renamePet } from "@/lib/pet/runtime/rename-pet"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import { respondAsPet, type PetChatResult } from "@/lib/pet/chat/respond"
import { getPetBinding, getPetProfile } from "@/lib/db/pet"
import { clearPetConversation } from "@/lib/db/pet-conversation"
import { getDb } from "@/lib/db/schema"
import { usePetStore } from "@/stores/pet/pet-store"
import { useSettingsStore } from "@/stores/settings"
import { PET_REMOTE_COMMANDS, isPetRemoteCommand } from "./commands"
import { getPetIdempotencyLedger, type PetIdempotencyLedger } from "./idempotency"
import {
  buildPetRemoteSnapshot,
  readHostPetSettings,
  resolveHostPetAvailability,
  type PetHostSnapshotDeps,
} from "./host-snapshot"
import {
  encodeChatPageToken,
  parseCallerDeviceId,
  parseIdempotencyKey,
  parsePetActRequest,
  parsePetApplyRequest,
  parsePetChatListRequest,
  parsePetChatSendRequest,
  parsePetPurchaseRequest,
  parsePetRenameRequest,
  refused,
  toRemoteRefusal,
  type PetActResult,
  type PetApplyResult,
  type PetChatClearResult,
  type PetChatListResult,
  type PetChatSendResult,
  type PetHatchResult,
  type PetPurchaseResult,
  type PetRemoteRefused,
  type PetRemoteSnapshot,
  type PetRenameResult,
} from "./types"

/**
 * How long the host waits on soul generation and on a chat reply before
 * answering `pending`. Under the desktop-writes bridge's 30 s timeout
 * (`desktop_writes_bridge::DEFAULT_TIMEOUT`) with room for the round trip, so
 * a slow model produces an honest "still working" instead of a transport
 * error for work that is in fact going to land.
 */
export const PET_REMOTE_SLOW_WORK_WINDOW_MS = 25_000

export interface PetHostDispatchDeps {
  now?: () => number
  platform?: Platform
  /** Which window this is; defaults to the live webview label. */
  role?: PetWindowRole
  /** Extra access-gate collaborators (the burst limiter, in tests). */
  accessDeps?: Pick<PetAccessDeps, "rateLimiter" | "decrementInventory">
  ledger?: PetIdempotencyLedger
  getProfile?: () => Promise<PetProfile | undefined>
  getPetSettings?: () => PetSettings
  getAppSettings?: () => AppSettings | null | undefined
  isControllerPresent?: () => boolean
  requestInteraction?: typeof requestPetInteraction
  checkAccepted?: typeof checkInteractionAccepted
  emit?: typeof emitPetEvent
  /** Run after any in-flight controller work (`enqueuePetWork`). */
  serialize?: <T>(fn: () => Promise<T>) => Promise<T>
  /** Resolve once the controller has processed everything emitted so far. */
  settle?: () => Promise<void>
  findActivity?: (kind: string, ts: number) => Promise<PetActivityRow | undefined>
  purchase?: typeof purchaseItem
  consume?: typeof consumeItem
  rename?: typeof renamePet
  hatch?: (appSettings: AppSettings | null | undefined) => Promise<HatchPetOutcome>
  respond?: typeof respondAsPet
  resolveActiveCharacterId?: () => Promise<string | null>
  listChatPage?: (offset: number, limit: number) => Promise<PetChatListResult["items"]>
  clearChat?: () => Promise<void>
  enqueueOneShot?: (shot: NonNullable<Extract<PetChatResult, { status: "ok" }>["emotion"]>) => void
  slowWorkWindowMs?: number
}

function readAppSettings(): AppSettings | null | undefined {
  return useSettingsStore.getState().settings
}

async function findActivityAt(kind: string, ts: number): Promise<PetActivityRow | undefined> {
  return getDb()
    .petActivityLog.where("ts")
    .equals(ts)
    .filter((row) => row.kind === kind)
    .first()
}

async function resolveHostActiveCharacterId(): Promise<string | null> {
  // The character the desktop pet is bound to right now: the one the open
  // conversation runs as, exactly what `useActiveCharacterId` resolves for the
  // console. Lazy so the chat store is only reached by a chat turn.
  const [{ useChatStore }, { getSession }] = await Promise.all([
    import("@/stores/chat/chat-store"),
    import("@/lib/db/sessions"),
  ])
  const sessionId = useChatStore.getState().activeSessionId
  if (!sessionId) return null
  return (await getSession(sessionId))?.characterId ?? null
}

async function listChatPage(offset: number, limit: number): Promise<PetChatListResult["items"]> {
  const rows = await getDb()
    .petConversationV2.orderBy("at")
    .reverse()
    .offset(offset)
    .limit(limit)
    .toArray()
  return rows.map((row) => ({ id: row.id, at: row.at, userText: row.userText, reply: row.reply }))
}

type Window<T> = { settled: true; value: T } | { settled: false }

/** Race `work` against the bridge window without leaving a timer behind. */
async function withinWindow<T>(work: Promise<T>, ms: number): Promise<Window<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Window<T>>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms)
  })
  try {
    return await Promise.race([work.then((value) => ({ settled: true as const, value })), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

interface Resolved {
  now: () => number
  platform: Platform
  role: PetWindowRole | undefined
  accessDeps: Pick<PetAccessDeps, "rateLimiter" | "decrementInventory">
  ledger: PetIdempotencyLedger
  getProfile: () => Promise<PetProfile | undefined>
  getPetSettings: () => PetSettings
  getAppSettings: () => AppSettings | null | undefined
  isControllerPresent: () => boolean
  requestInteraction: typeof requestPetInteraction
  checkAccepted: typeof checkInteractionAccepted
  emit: typeof emitPetEvent
  serialize: <T>(fn: () => Promise<T>) => Promise<T>
  settle: () => Promise<void>
  findActivity: (kind: string, ts: number) => Promise<PetActivityRow | undefined>
  purchase: typeof purchaseItem
  consume: typeof consumeItem
  rename: typeof renamePet
  hatch: (appSettings: AppSettings | null | undefined) => Promise<HatchPetOutcome>
  respond: typeof respondAsPet
  resolveActiveCharacterId: () => Promise<string | null>
  listChatPage: (offset: number, limit: number) => Promise<PetChatListResult["items"]>
  clearChat: () => Promise<void>
  enqueueOneShot: NonNullable<PetHostDispatchDeps["enqueueOneShot"]>
  slowWorkWindowMs: number
  snapshot: PetHostSnapshotDeps
}

function resolveDeps(deps: PetHostDispatchDeps): Resolved {
  const now = deps.now ?? Date.now
  const platform = deps.platform ?? detectPlatform()
  const getProfile = deps.getProfile ?? getPetProfile
  const getPetSettings = deps.getPetSettings ?? readHostPetSettings
  const isControllerPresent = deps.isControllerPresent ?? isPetControllerPresent
  return {
    now,
    platform,
    role: deps.role,
    accessDeps: deps.accessDeps ?? {},
    ledger: deps.ledger ?? getPetIdempotencyLedger(),
    getProfile,
    getPetSettings,
    getAppSettings: deps.getAppSettings ?? readAppSettings,
    isControllerPresent,
    requestInteraction: deps.requestInteraction ?? requestPetInteraction,
    checkAccepted: deps.checkAccepted ?? checkInteractionAccepted,
    emit: deps.emit ?? emitPetEvent,
    serialize: deps.serialize ?? enqueuePetWork,
    settle: deps.settle ?? whenPetEventsSettled,
    findActivity: deps.findActivity ?? findActivityAt,
    purchase: deps.purchase ?? purchaseItem,
    consume: deps.consume ?? consumeItem,
    rename: deps.rename ?? renamePet,
    hatch: deps.hatch ?? ((appSettings) => hatchPetOnce(appSettings)),
    respond: deps.respond ?? respondAsPet,
    resolveActiveCharacterId: deps.resolveActiveCharacterId ?? resolveHostActiveCharacterId,
    listChatPage: deps.listChatPage ?? listChatPage,
    clearChat: deps.clearChat ?? clearPetConversation,
    enqueueOneShot: deps.enqueueOneShot ?? ((shot) => usePetStore.getState().enqueueOneShot(shot)),
    slowWorkWindowMs: deps.slowWorkWindowMs ?? PET_REMOTE_SLOW_WORK_WINDOW_MS,
    snapshot: {
      now,
      platform,
      ...(deps.role ? { role: deps.role } : {}),
      getProfile,
      getPetSettings,
      isControllerPresent,
    },
  }
}

/**
 * Refuse unless the host pet may act at all.
 *
 * `needsController` is for care actions only: they are bus events, and with no
 * controller subscribed an event is dropped silently. Purchases, decor,
 * renames, hatching and chat write through their own paths and do not need it.
 */
function availabilityRefusal(d: Resolved, needsController: boolean): PetRemoteRefused | null {
  const availability = resolveHostPetAvailability({
    ...d.snapshot,
    isControllerPresent: needsController ? d.isControllerPresent : () => true,
  })
  if (availability.available) return null
  switch (availability.reason) {
    case "headless-host":
    case "host-starting":
      return refused({ code: availability.reason })
    default:
      return refused({ code: "unavailable", reason: availability.reason })
  }
}

async function act(
  d: Resolved,
  request: ReturnType<typeof parsePetActRequest>
): Promise<PetActResult> {
  const unavailable = availabilityRefusal(d, true)
  if (unavailable) return unavailable
  const { action, itemId } = request

  // Read the profile behind any in-flight controller work, so `before` is the
  // state this action's event will be applied on top of.
  const before = await d.serialize(() => d.getProfile())
  if (!before) return refused({ code: "uninitialized" })
  if (!before.soul) return refused({ code: "not-hatched" })
  // A `user` subject skips the gate's own precheck unless it spends an item,
  // because on the desktop the controller's cooldown bubble answers it. A
  // phone cannot see that bubble, so it is asked up front here.
  const notNow = await d.checkAccepted(action, { getProfile: d.getProfile, now: d.now })
  if (notNow) return refused(toRemoteRefusal(notNow))

  // Stamp the event ourselves so the controller's outcome can be read back
  // exactly: an accepted action writes this `at` into the cooldown gate and
  // the activity ledger, and nothing else writes that pair.
  const stamp: { at: number | null } = { at: null }
  const result = await d.requestInteraction({ kind: "user" }, action, itemId ? { itemId } : {}, {
    // The same host facts the availability check above answered from, so the
    // gate cannot disagree with it.
    ...d.accessDeps,
    now: d.now,
    platform: d.platform,
    ...(d.role ? { role: d.role } : {}),
    isEnabled: () => d.getPetSettings().enabled,
    getProfile: d.getProfile,
    emit: (event) => {
      const at = d.now()
      stamp.at = at
      d.emit({ ...event, at })
    },
  })
  if (!result.ok) return refused(toRemoteRefusal(result.refusal))
  const at = stamp.at
  if (at === null) throw new Error("pet interaction was granted but never emitted")

  await d.settle()
  const after = await d.getProfile()
  if (!after) return refused({ code: "uninitialized" })
  if (INTERACTION_COOLDOWN_MS[action] !== undefined) {
    const gate = normalizeInteractionGate(after.interactionGate)
    if (gate.lastAtByKind[action] !== at) {
      // The controller dropped it after all (another window's tap started the
      // cooldown between the precheck and the event). Report what it did.
      if (!after.soul) return refused({ code: "not-hatched" })
      return refused({
        code: "cooling-down",
        kind: action,
        retryAfterMs: remainingCooldownMs(gate, action, d.now()),
      })
    }
  }
  const row = await d.findActivity(action, at)
  return {
    ok: true,
    grantedXp: row ? Math.max(0, row.xp) : Math.max(0, after.xp - before.xp),
    grantedCoins: Math.max(0, normalizeCoins(after.coins) - normalizeCoins(before.coins)),
  }
}

async function purchase(
  d: Resolved,
  request: ReturnType<typeof parsePetPurchaseRequest>
): Promise<PetPurchaseResult> {
  const unavailable = availabilityRefusal(d, false)
  if (unavailable) return unavailable
  const outcome = await d.purchase(request.itemId, request.qty)
  if (outcome.ok) return { ok: true, coins: normalizeCoins(outcome.coins) }
  switch (outcome.error) {
    case "unknown-item":
      return refused({ code: "unknown-item", itemId: request.itemId })
    case "insufficient-coins":
      return refused({ code: "insufficient-coins", itemId: request.itemId })
    default:
      return refused({ code: "uninitialized" })
  }
}

async function applyDecor(
  d: Resolved,
  request: ReturnType<typeof parsePetApplyRequest>
): Promise<PetApplyResult> {
  const unavailable = availabilityRefusal(d, false)
  if (unavailable) return unavailable
  const item = getPetItem(request.itemId)
  if (!item) return refused({ code: "unknown-item", itemId: request.itemId })
  if (item.consumable) return refused({ code: "not-decor", itemId: request.itemId })
  if (!(await d.getProfile())) return refused({ code: "uninitialized" })
  const outcome = await d.consume(request.itemId)
  if (outcome.ok) return { ok: true }
  switch (outcome.error) {
    case "unknown-item":
      return refused({ code: "unknown-item", itemId: request.itemId })
    case "not-owned":
      return refused({ code: "item-not-owned", itemId: request.itemId })
    case "not-hatched":
      return refused({ code: "not-hatched" })
    default:
      return refused({ code: "uninitialized" })
  }
}

async function rename(
  d: Resolved,
  request: ReturnType<typeof parsePetRenameRequest>
): Promise<PetRenameResult> {
  const unavailable = availabilityRefusal(d, false)
  if (unavailable) return unavailable
  if (!isValidPetName(request.name)) return refused({ code: "invalid-name" })
  // `renamePet` is a read-modify-write of the profile outside the event path,
  // which `enqueuePetWork` exists to serialize against the controller's own.
  const outcome = await d.serialize(async () => {
    const current = await d.getProfile()
    if (!current) return refused({ code: "uninitialized" })
    if (!current.soul) return refused({ code: "not-hatched" })
    const renamed = await d.rename(request.name, d.now())
    const name = renamed?.soul?.name
    return name ? ({ ok: true, name } as const) : refused({ code: "invalid-name" })
  })
  return outcome
}

async function hatch(d: Resolved): Promise<PetHatchResult> {
  const unavailable = availabilityRefusal(d, false)
  if (unavailable) return unavailable
  const window = await withinWindow(d.hatch(d.getAppSettings()), d.slowWorkWindowMs)
  if (!window.settled) return { ok: true, state: "pending" }
  switch (window.value.status) {
    case "hatched":
    case "already-hatched":
      return { ok: true, state: window.value.status }
    case "no-profile":
      return refused({ code: "uninitialized" })
    case "failed":
      return refused({ code: "hatch-failed" })
  }
}

async function chatSend(
  d: Resolved,
  request: ReturnType<typeof parsePetChatSendRequest>
): Promise<PetChatSendResult> {
  const unavailable = availabilityRefusal(d, false)
  if (unavailable) return unavailable
  const profile = await d.getProfile()
  if (!profile) return refused({ code: "uninitialized" })
  const at = d.now()
  const activeCharacterId = await d.resolveActiveCharacterId()
  const binding = activeCharacterId ? await getPetBinding(activeCharacterId) : undefined
  // The host's own settings, view and history, behind `respondAsPet`'s PII
  // gate and speak limiter: a paired phone gets exactly the turn the desktop
  // console would have produced, and spends the same budget.
  const turn = d
    .respond({
      userText: request.text,
      view: computePetView(profile, binding ?? null, at),
      profile,
      appSettings: d.getAppSettings(),
      locale: request.locale,
      activeCharacterId,
      at,
    })
    .then((result) => {
      // The desktop pet reacts to the reply too, even one that arrives after
      // the phone was answered `pending`.
      if (result.status === "ok" && result.emotion) d.enqueueOneShot(result.emotion)
      return result
    })
  const window = await withinWindow(turn, d.slowWorkWindowMs)
  if (!window.settled) return { ok: true, status: "pending" }
  const result = window.value
  if (result.status === "ok") {
    return {
      ok: true,
      status: "replied",
      reply: result.reply,
      ...(result.emotion ? { emotion: result.emotion } : {}),
    }
  }
  return { ok: true, status: "degraded", reason: result.reason }
}

async function chatList(
  d: Resolved,
  request: ReturnType<typeof parsePetChatListRequest>
): Promise<PetChatListResult> {
  if (d.platform === "headless") return { items: [] }
  // One extra row says whether an older page exists without a count query.
  const rows = await d.listChatPage(request.offset, request.pageSize + 1)
  const more = rows.length > request.pageSize
  // Newest page first, but each page reads top-to-bottom like the transcript.
  const items = rows.slice(0, request.pageSize).reverse()
  return {
    items,
    ...(more ? { nextPageToken: encodeChatPageToken(request.offset + request.pageSize) } : {}),
  }
}

async function chatClear(d: Resolved): Promise<PetChatClearResult> {
  if (d.platform === "headless") return refused({ code: "headless-host" })
  await d.clearChat()
  return { ok: true }
}

/**
 * Answer one `pet_*` command. Validation failures throw (the bridge turns them
 * into an RPC error, as for every other arm); everything the pet itself
 * decides comes back as a value, `{ ok: false, refusal }` included.
 */
export async function dispatchPetHostCommand(
  command: string,
  payload: Record<string, unknown>,
  deps: PetHostDispatchDeps = {}
): Promise<unknown> {
  if (!isPetRemoteCommand(command)) throw new Error(`unsupported pet command: ${command}`)
  const callerDeviceId = parseCallerDeviceId(payload)
  const d = resolveDeps(deps)

  switch (command) {
    case PET_REMOTE_COMMANDS.get:
      return buildPetRemoteSnapshot(d.snapshot) satisfies Promise<PetRemoteSnapshot>
    case PET_REMOTE_COMMANDS.chatList:
      return chatList(d, parsePetChatListRequest(payload))
    case PET_REMOTE_COMMANDS.act: {
      const request = parsePetActRequest(payload)
      return d.ledger.run(callerDeviceId, parseIdempotencyKey(payload), () => act(d, request))
    }
    case PET_REMOTE_COMMANDS.itemPurchase: {
      const request = parsePetPurchaseRequest(payload)
      return d.ledger.run(callerDeviceId, parseIdempotencyKey(payload), () => purchase(d, request))
    }
    case PET_REMOTE_COMMANDS.chatSend: {
      const request = parsePetChatSendRequest(payload)
      return d.ledger.run(callerDeviceId, parseIdempotencyKey(payload), () => chatSend(d, request))
    }
    case PET_REMOTE_COMMANDS.itemApply:
      return applyDecor(d, parsePetApplyRequest(payload))
    case PET_REMOTE_COMMANDS.rename:
      return rename(d, parsePetRenameRequest(payload))
    case PET_REMOTE_COMMANDS.soulGenerate:
      return hatch(d)
    case PET_REMOTE_COMMANDS.chatClear:
      return chatClear(d)
  }
}
