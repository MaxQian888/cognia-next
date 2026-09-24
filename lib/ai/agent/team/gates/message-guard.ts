/**
 * Pure guards for teammate-initiated inter-agent messages (the `team_send_message`
 * built-in). Ported as an algorithm from an external agent-orchestration app's
 * controller (`internal/messages.js` idle/ack suppression + `internal/cascadeGuard.js`
 * rate-limit / pair-cooldown / dedupe). Sibling in spirit to {@link ../nudge-guard}:
 * no clock and no I/O — `now` and the recent-message window are always injected so the
 * orchestrator and tests share one behaviour, and the Zustand store stays the single
 * source of truth (we never duplicate message state here).
 *
 * Why: autonomous teams can flood the mailbox with low-signal "ok / understood / waiting"
 * acknowledgements, repeat the same broadcast, or fall into a two-agent ping-pong loop.
 * The guard drops those before they reach the store, returning a stable reason code the
 * caller surfaces to the model. Substantive deliverables (`result_share`) are NOT routed
 * through here — only teammate-*initiated* chatter is.
 */

/** A message already on the wire, windowed by the caller from the store. */
export interface RecentMessage {
  senderId: string
  /** Direct recipient, or undefined for a broadcast. */
  recipientId?: string
  content: string
  /** Epoch ms. */
  createdAt: number
}

export interface CanSendMessageArgs {
  senderId: string
  /** Direct recipient, or undefined for a broadcast. */
  recipientId?: string
  content: string
  now: number
  /** This team's recent messages (any age — the guard windows them). */
  recentMessages: RecentMessage[]
  limits?: Partial<MessageGuardLimits>
}

export interface MessageGuardLimits {
  /** Ack-only text longer than this is treated as real content (never suppressed). */
  idleAckMaxChars: number
  /** Identical sender+recipient+content within this window → duplicate. */
  dedupeWindowMs: number
  /** Repeat direct sender→recipient within this window → ping-pong cooldown. */
  pairCooldownMs: number
  /** Sliding window for the per-sender rate cap. */
  rateWindowMs: number
  /** Max messages one sender may emit within `rateWindowMs`. */
  maxPerWindow: number
}

export const DEFAULT_MESSAGE_GUARD_LIMITS: MessageGuardLimits = {
  idleAckMaxChars: 180,
  dedupeWindowMs: 60_000,
  pairCooldownMs: 3_000,
  rateWindowMs: 60_000,
  maxPerWindow: 10,
}

export type MessageGuardReason = "ok" | "idle_ack" | "duplicate" | "pair_cooldown" | "rate_limited"

export interface MessageGuardDecision {
  allow: boolean
  /** Stable reason code (telemetry / model-facing prose), never user-facing UI text. */
  reason: MessageGuardReason
}

/** Lowercase, strip punctuation to spaces, collapse whitespace — for ack matching. */
function normalizeIdleAckText(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[#*_`"'“”‘’«»()[\]{}.,!?;:<>/\\|—–-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Trim + collapse whitespace + lowercase — for duplicate detection. */
function normalizeForDedupe(value: string): string {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
}

/** Ack-only phrases that carry no actionable information (English + 简体中文). */
const IDLE_ACK_EXACT_TEXT: ReadonlySet<string> = new Set([
  // English
  "ok",
  "okay",
  "k",
  "understood",
  "got it",
  "acknowledged",
  "roger",
  "noted",
  "sure",
  "will do",
  "on it",
  "sounds good",
  "no problem",
  "ready",
  "ready to work",
  "waiting",
  "waiting for tasks",
  "awaiting tasks",
  "standing by",
  "no tasks",
  "no assigned tasks",
  "no actionable tasks",
  // 简体中文
  "好",
  "好的",
  "好的收到",
  "收到",
  "已收到",
  "明白",
  "明白了",
  "了解",
  "知道了",
  "遵命",
  "没问题",
  "就绪",
  "准备就绪",
  "准备好了",
  "等待",
  "等待中",
  "等任务",
  "等待任务",
  "没有任务",
  "没有分配任务",
  "没有可执行任务",
])

/**
 * True when `value` is an idle/acknowledgement-only message — a short reply that adds no
 * information (no findings, no decision, no question). Used to keep "ok / 收到 / waiting
 * for tasks" chatter out of the mailbox.
 */
export function looksLikeIdleAckOnlyText(
  value: string,
  maxChars = DEFAULT_MESSAGE_GUARD_LIMITS.idleAckMaxChars
): boolean {
  const normalized = normalizeIdleAckText(value)
  if (!normalized || normalized.length > maxChars) {
    return false
  }
  if (IDLE_ACK_EXACT_TEXT.has(normalized)) {
    return true
  }

  const has = (...needles: string[]) => needles.some((n) => normalized.includes(n))
  const noTaskPhrase = has(
    "no assigned tasks",
    "no actionable tasks",
    "no tasks",
    "没有任务",
    "没有分配",
    "没有可执行"
  )
  const waitingPhrase = has("waiting for tasks", "awaiting tasks", "等待任务", "等任务")
  const readyPhrase = has("ready to work", "准备好", "准备就绪")
  const idlePhrase = normalized.includes("idle") && has("task", "wait", "ready")

  return noTaskPhrase || waitingPhrase || readyPhrase || idlePhrase
}

/**
 * Decide whether a teammate-initiated message may be delivered now. Order of guards:
 * idle/ack noise → block; an identical recent message → duplicate; a direct reply that
 * repeats too fast → pair cooldown (anti ping-pong); the per-sender rate cap is hit →
 * rate-limited. Otherwise allow.
 */
export function canSendMessage(args: CanSendMessageArgs): MessageGuardDecision {
  const { senderId, recipientId, content, now, recentMessages } = args
  const limits = { ...DEFAULT_MESSAGE_GUARD_LIMITS, ...(args.limits ?? {}) }

  // 1) Idle/ack-only noise: a content-free acknowledgement.
  if (looksLikeIdleAckOnlyText(content, limits.idleAckMaxChars)) {
    return { allow: false, reason: "idle_ack" }
  }

  const fromSender = recentMessages.filter((m) => m.senderId === senderId)
  const normalizedContent = normalizeForDedupe(content)
  const sameRecipient = (m: RecentMessage) => (m.recipientId ?? "") === (recipientId ?? "")

  // 2) Duplicate: same sender + recipient + content within the dedupe window.
  const isDuplicate = fromSender.some(
    (m) =>
      now - m.createdAt < limits.dedupeWindowMs &&
      sameRecipient(m) &&
      normalizeForDedupe(m.content) === normalizedContent
  )
  if (isDuplicate) {
    return { allow: false, reason: "duplicate" }
  }

  // 3) Pair cooldown: a direct reply that repeats the same sender→recipient too fast.
  if (recipientId) {
    const lastToPair = fromSender
      .filter((m) => m.recipientId === recipientId)
      .reduce((max, m) => Math.max(max, m.createdAt), -Infinity)
    if (Number.isFinite(lastToPair) && now - lastToPair < limits.pairCooldownMs) {
      return { allow: false, reason: "pair_cooldown" }
    }
  }

  // 4) Per-sender rate cap within the sliding window.
  const recentCount = fromSender.filter((m) => now - m.createdAt < limits.rateWindowMs).length
  if (recentCount >= limits.maxPerWindow) {
    return { allow: false, reason: "rate_limited" }
  }

  return { allow: true, reason: "ok" }
}

/** Short, model-facing explanation for a suppressed message (English — sent back as a tool result). */
export function describeSuppressedMessage(reason: Exclude<MessageGuardReason, "ok">): string {
  switch (reason) {
    case "idle_ack":
      return "Suppressed: idle/ack-only message. Wait silently unless you have findings, a decision, a blocker, or a question — do not send 'ok'/'understood'/'waiting' chatter."
    case "duplicate":
      return "Suppressed: duplicate of a message you just sent. The recipient already has it."
    case "pair_cooldown":
      return "Suppressed: you are messaging the same teammate too rapidly. Slow down and batch your updates."
    case "rate_limited":
      return "Suppressed: message rate limit reached. Pause sending and focus on the work; the team will see your task comments."
  }
}
