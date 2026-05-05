# Platform Connectors Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Phase 1 MVP (foundation + Telegram + Discord + Slack + Lark + OneBot adapters + Inbox UI + reliability primitives) of the cognia-next Platform Connectors subsystem per the approved spec at `C:\Users\qwdma\.claude\plans\d-project-agentforge-astrbot-fluttering-cerf.md`.

**Architecture:** Tauri Rust hosts axum HTTP/WS clients + signature verification + OS-keyring credentials + attachment cache; TypeScript adapters do parse/serialize/business-logic and run inside the renderer through a Connector Bus that handles inbound dedup, FIFO outbound, retries, and the auto/manual/draft mode router. Each platform conversation maps to one `ChatSession` (with `platformBinding`) so the existing `MessageRenderer` / `Composer` / twin RAG / skills light up unchanged.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript 5.x strict, Tailwind v4, shadcn/ui, Zustand, Dexie 4 (IndexedDB v18), Jest 30 (jsdom), Tauri 2.9, Rust 1.77+ (axum 0.7, tokio, tokio-tungstenite, reqwest, keyring 3, subtle, hmac, sha1, sha2).

---

## Reading guide for the implementing engineer

Before writing any code, read in order:

1. **The spec** — `C:\Users\qwdma\.claude\plans\d-project-agentforge-astrbot-fluttering-cerf.md`. Every Task in this plan implements something defined there. When in doubt about _why_, the spec wins; when in doubt about _how_, this plan wins.
2. **`CLAUDE.md`** at the repo root — coverage targets (≥90% for new files), test co-location rules, naming conventions, "always use pnpm", `output: "export"` constraint.
3. **`src-tauri/src/remote_control/`** — your single most important reference. The Connector subsystem is structurally a sibling: same axum + bearer + allowlist + rate-limit + keyring patterns, just with platform webhook semantics on top. Read `server.rs`, `keyring.rs`, `allowlist.rs`, `rate_limit.rs`, and `commands.rs` _before_ writing the equivalent files for connectors.
4. **`src-tauri/src/mcp_server/http_server.rs`** — the second axum module in the codebase (External Bridge). Confirms the axum 0.7 patterns we standardise on.
5. **`lib/db/schema.ts`** at the v17 block — copy the full `.stores({...})` block when adding v18.
6. **`lib/claude/types.ts`** `ChatSession`, `StoredMessage`, `Character` — this is what we're extending.
7. **`components/settings/remote-control/remote-control-section.tsx`** — the tabbed-section pattern with `?<tab>=` URL hydration that the Connections section will mirror 1:1.
8. **`components/settings/remote-control/tabs/inbound-tab.tsx`** lines 26-80 — the `isTauri()` gate + sonner toast pattern + keyring fetch we reuse.

---

## Conventions for every task

- **Test runner**: Jest 30, jsdom env. Test files co-located: `foo.ts` ↔ `foo.test.ts`. **Do NOT** use `__tests__/` or a separate `tests/` tree.
- **IndexedDB in tests**: `import "fake-indexeddb/auto"` at the top of any test that touches Dexie. Reset between tests with `await getDb().delete(); __resetDbForTesting();` in `beforeEach` (see `lib/db/schema.test.ts:9-13`).
- **Tauri mocks**: `@tauri-apps/api/core` is auto-mocked via `jest.config.ts:moduleNameMapper`. Cast `vi.mocked` is **not** valid (Vitest only). Use `(invoke as jest.Mock).mockResolvedValueOnce(...)` instead.
- **Coverage**: every new file in `lib/connectors/`, `types/connectors/`, `stores/connectors/` must hit ≥90% lines/branches/functions per CLAUDE.md.
- **Rust tests**: in-file `#[cfg(test)] mod tests {}` blocks. Integration tests under `src-tauri/tests/` only when needed.
- **Commit style**: Conventional Commits with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. Examples used in this plan:
  - `feat(connectors): add Dexie v18 schema for platform connectors`
  - `feat(connectors): scaffold Rust connectors module`
  - `feat(connectors/telegram): wire long-poll transport`
  - `test(connectors): cover trigger policy override stack`
  - `chore(connectors): bump Cargo.toml deps`
- **Run commands**: always `rtk`-prefixed per global CLAUDE.md. Examples:
  - Type check single file: `rtk pnpm exec tsc --noEmit --pretty <path>`
  - Single jest test: `rtk pnpm exec jest <path> -t "<test name>"`
  - Lint single file: `rtk pnpm exec eslint <path>`
- **Quality gate before each commit**: `rtk pnpm exec jest <changed-files>` must pass; `rtk pnpm typecheck` must be clean for the touched module.

---

## File structure (locked-in decomposition)

```
types/connectors/
  index.ts                     # barrel re-exports
  platform-kind.ts             # PlatformKind union
  segment.ts                   # MessageSegment + helpers (isTextSegment, etc.)
  event.ts                     # NormalizedInboundEvent, ConversationReference
  outbound.ts                  # OutboundRequest, OutboundResult
  policy.ts                    # TriggerPolicy types
  capability.ts                # Capability flag union + helpers
  adapter.ts                   # PlatformAdapter, AdapterContext, AdapterMeta, AdapterHealth
  audit.ts                     # AuditEntry shapes
  binding.ts                   # PlatformBinding (added to ChatSession)
  identity.ts                  # PlatformIdentity row shape

lib/connectors/
  bus.ts                       # ConnectorBus singleton (registry, fan-in, fan-out)
  adapter-registry.ts          # built-in + plugin adapter registry
  policy-eval.ts               # TriggerPolicy evaluator (rules + blockers)
  policy-resolve.ts            # 3-layer override merger
  mode-router.ts               # auto/manual/draft dispatcher
  outbound-queue.ts            # Dexie-backed queue + per-conversation lanes
  outbound-runner.ts           # processes one job: backoff, breaker, idempotency
  dedup.ts                     # LRU + Dexie inboundLedger
  attachments.ts               # fetch & rewrite segment URLs (TS side)
  identity.ts                  # PlatformIdentity projection helpers
  audit.ts                     # connectorAudit row writer
  runtime.ts                   # wires bus into resolveSendOptions / sendPrompt
  rate-limit.ts                # token-bucket per-(adapter,conversation)
  circuit-breaker.ts           # per-adapter sliding window
  conversation-binding.ts      # ChatSession.platformBinding upserts
  drafts.ts                    # connectorDrafts CRUD + lifecycle
  slash-commands.ts            # built-in /help /character /mode /skill /clear

lib/connectors/adapters/
  _shared/
    markdown.ts                # CommonMark AST + per-platform serialisers
    mention-resolver.ts
    degrade.ts                 # capability-aware fallback chain
    rate-limit-defaults.ts     # per-platform token-bucket settings
  telegram/
    index.ts                   # createTelegramAdapter(ctx)
    parse.ts                   # Telegram update → NormalizedInboundEvent
    serialize.ts               # OutboundRequest → Telegram sendMessage payload
    markdown-v2.ts             # Telegram MarkdownV2 escaper
    capability.ts              # exported capability flags
    transport-longpoll.ts      # getUpdates loop
    transport-webhook.ts       # axum-route handler bridge (TS callback)
    fixtures/                  # JSON fixtures for golden tests
  discord/
    (parallel layout — gateway-client.ts replaces transport-longpoll.ts)
  slack/
    (Block Kit serialiser instead of MarkdownV2)
  lark/
    (encrypt + verification token in transport)
  onebot/
    v11.ts
    v12.ts
    segments.ts                # OneBot segment ↔ MessageSegment mapper

lib/db/  (modify)
  schema.ts                    # add v18 block + 8 new tables
  adapter-instances.ts         # CRUD
  outbound-jobs.ts             # CRUD + queue picker
  inbound-ledger.ts            # CRUD + LRU prune
  conversation-overrides.ts    # CRUD
  connector-audit.ts           # CRUD (cap 5000)
  connector-drafts.ts          # CRUD
  connector-attachments.ts     # CRUD + cleanup
  platform-identities.ts       # CRUD + merge

stores/connectors/
  store.ts                     # Zustand state: live adapter health, draft queue, cache

components/inbox/
  inbox-shell.tsx
  inbox-sidebar.tsx
  conversation-list.tsx
  conversation-header.tsx
  mode-switcher.tsx
  policy-info.tsx
  draft-banner.tsx
  draft-editor.tsx
  outbound-status-pill.tsx
  platform-badge.tsx
  unread-pill.tsx

app/inbox/
  layout.tsx
  page.tsx                     # redirect to /inbox/all
  all/page.tsx
  adapter/[adapterId]/page.tsx
  platform/[kind]/page.tsx
  c/[conversationKey]/page.tsx

components/settings/connections/
  connections-section.tsx
  tabs/
    overview-tab.tsx
    adapters-tab.tsx
    conversations-tab.tsx
    inbox-tab.tsx
    outbound-tab.tsx
    audit-tab.tsx
  forms/
    adapter-form.tsx           # JSON-Schema-driven config form
    telegram-config.tsx        # adapter-specific quick-config helpers
    discord-config.tsx
    slack-config.tsx
    lark-config.tsx
    onebot-config.tsx

components/connectors/
  connector-bus-provider.tsx   # mounted in app/layout.tsx
  connector-deep-link-router.tsx
  identity-merge-dialog.tsx

lib/connectors/tauri/
  commands.ts                  # typed wrappers around connectors_* Tauri commands
  events.ts                    # typed wrappers around connectors://* events

src-tauri/src/connectors/
  mod.rs                       # module root, registers commands
  types.rs                     # serde types crossing TS↔Rust
  state.rs                     # Tauri-managed state (adapter handles, server state)
  axum_app.rs                  # public/loopback axum server
  server_lifecycle.rs          # start/stop with graceful shutdown
  tunnel.rs                    # cloudflared/ngrok subprocess wrapper
  keyring.rs                   # com.cognia.platforms helpers
  attachments.rs               # encrypted on-disk cache
  ws_client.rs                 # tokio-tungstenite outbound WS
  ws_server.rs                 # axum WebSocket upgrade for OneBot reverse-WS
  http_client.rs               # reqwest wrapper with rate-limit + retry
  imap.rs                      # phase-3 stub
  smtp.rs                      # phase-3 stub
  sigverify/
    mod.rs                     # trait SignatureVerifier
    slack.rs
    telegram.rs
    discord.rs
    lark.rs
    wecom.rs                   # phase-2 stub
    wechat_oa.rs               # phase-2 stub
    dingtalk.rs                # phase-2 stub
    onebot.rs                  # bearer-token only
  log_redact.rs                # allowlist field redactor
  commands.rs                  # Tauri command surface

src-tauri/src/lib.rs (modify)  # register `connectors` module + commands

src-tauri/Cargo.toml (modify)  # add axum, tower, tower-http, tokio-tungstenite (already
                               # present), hmac, sha1, sha2, ed25519-dalek, base64, subtle

lib/claude/types.ts (modify)   # add ChatSession.platformBinding,
                               # StoredMessage.metadata.platformMessage,
                               # Character.platformDefaults

components/settings/settings-nav-config.ts (modify)  # add "connections" nav item

components/settings/settings-shell.tsx (modify)      # wire connections case

components/chat/message-renderer.tsx (modify)        # platform-aware sub-blocks

components/chat/composer.tsx (modify)                # mode chip + draft handling
                                                     # for sessions with platformBinding

lib/claude/build-options.ts (modify)                 # ensure resolveSendOptions
                                                     # honors platform-bound character
                                                     # when invoked from Connector Bus

lib/scheduler/event-integration.ts (modify)          # add connection:outbound:send
                                                     # and connection:scheduled:digest
                                                     # event types

types/plugin/plugin.ts (modify)                      # add "connectors" capability
                                                     # and PluginManifest.connectors

app/layout.tsx (modify)                              # mount ConnectorBusProvider
                                                     # and ConnectorDeepLinkRouter
```

---

## Checkpoints

After each checkpoint, **stop and request human review** before continuing. The checkpoints are intentionally placed where the system is in a coherent, demoable state.

| Checkpoint                                    | What's done                                                                                                                                     | Demoable thing                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **CP-A — Foundation** (Tasks 1–28)            | Dexie v18, types, Rust scaffolding, bus, queue, policy, mode router, dedup, audit, attachments, slash commands, conversation binding            | Unit tests pass; no UI yet; no real inbound.                                                |
| **CP-B — Telegram lit up** (Tasks 29–48)      | Long-poll + webhook transports, parse/serialize, MarkdownV2, sigverify, contract tests, plumbed into bus                                        | A real Telegram bot DM gets a real reply via auto mode through the bus, headlessly (no UI). |
| **CP-C — Inbox UI** (Tasks 49–68)             | Connections settings tab, Inbox routes, conversation view, mode switcher, draft banner, identity merge                                          | Same Telegram demo, now driven entirely from UI; manual + draft modes work.                 |
| **CP-D — Discord** (Tasks 69–80)              | Gateway WS adapter, Discord-specific markdown, Ed25519 sigverify, contract tests                                                                | Add a Discord bot, hold a private DM and a guild channel `@bot` exchange.                   |
| **CP-E — Slack** (Tasks 81–93)                | Socket Mode adapter, Block Kit serialiser, HMAC sigverify, OAuth flow                                                                           | Slack workspace, threaded reply round-trip.                                                 |
| **CP-F — Lark / Feishu** (Tasks 94–107)       | Lark webhook adapter (encrypt + verification token), card serialiser, OAuth                                                                     | Lark group chat with bot.                                                                   |
| **CP-G — OneBot** (Tasks 108–119)             | OneBot reverse-WS server, v11+v12 parsers, contract tests                                                                                       | NapCat / Lagrange connected to cognia-next, QQ message round-trip.                          |
| **CP-H — Polish + Ship Gate** (Tasks 120–140) | Proactive outbound via scheduler, plugin extension API, web-mode degradation, E2E Playwright fixture, ADR-0008 doc, manual ship-gate validation | All five adapters ship; `pnpm tauri build` produces a clean Windows + macOS bundle.         |

---

# CP-A — Foundation

## Task 1: Worktree + branch setup

**Files:**

- Create: dedicated worktree at `D:\Project\cognia-next\.claude\worktrees\platform-connectors-phase1`
- Branch: `feat/platform-connectors-phase1`

- [ ] **Step 1: Create the worktree**

```powershell
rtk git worktree add .claude\worktrees\platform-connectors-phase1 -b feat/platform-connectors-phase1
```

Expected: prints `Preparing worktree (new branch 'feat/platform-connectors-phase1')`.

- [ ] **Step 2: Verify the worktree builds clean**

```powershell
cd .claude\worktrees\platform-connectors-phase1
rtk pnpm install --frozen-lockfile
rtk pnpm typecheck
```

Expected: install completes; typecheck shows zero errors.

- [ ] **Step 3: Commit a marker file so we have a non-empty starting commit on the branch**

(no files added yet; skip explicit commit — first real commit follows in Task 2)

---

## Task 2: PlatformKind union and barrel exports

**Files:**

- Create: `types/connectors/platform-kind.ts`
- Create: `types/connectors/index.ts`
- Test: `types/connectors/platform-kind.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// types/connectors/platform-kind.test.ts
import { ALL_PLATFORM_KINDS, isPlatformKind, type PlatformKind } from "./platform-kind"

describe("PlatformKind", () => {
  it("enumerates all Phase 1 + Phase 2 + Phase 3 platforms", () => {
    expect(ALL_PLATFORM_KINDS).toEqual([
      "telegram",
      "discord",
      "slack",
      "lark",
      "onebot",
      "dingtalk",
      "wecom",
      "wechat-oa",
      "qq-official",
      "email",
      "matrix",
      "kook",
      "line",
      "mattermost",
    ])
  })

  it("isPlatformKind narrows to the union", () => {
    const x: string = "telegram"
    expect(isPlatformKind(x)).toBe(true)
    if (isPlatformKind(x)) {
      const k: PlatformKind = x
      expect(k).toBe("telegram")
    }
    expect(isPlatformKind("nope")).toBe(false)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```powershell
rtk pnpm exec jest types/connectors/platform-kind.test.ts
```

Expected: FAIL "Cannot find module './platform-kind'".

- [ ] **Step 3: Implement**

```ts
// types/connectors/platform-kind.ts
/**
 * The set of platform connectors we plan to support across all phases. Each
 * built-in adapter binds 1:1 to one of these kinds; plugin-contributed
 * adapters can extend the union via module augmentation but must pick a
 * fresh string that does not collide with a built-in.
 */
export const ALL_PLATFORM_KINDS = [
  "telegram",
  "discord",
  "slack",
  "lark",
  "onebot",
  "dingtalk",
  "wecom",
  "wechat-oa",
  "qq-official",
  "email",
  "matrix",
  "kook",
  "line",
  "mattermost",
] as const

export type PlatformKind = (typeof ALL_PLATFORM_KINDS)[number]

export function isPlatformKind(value: unknown): value is PlatformKind {
  return typeof value === "string" && (ALL_PLATFORM_KINDS as readonly string[]).includes(value)
}
```

```ts
// types/connectors/index.ts
export * from "./platform-kind"
```

- [ ] **Step 4: Run, expect PASS**

```powershell
rtk pnpm exec jest types/connectors/platform-kind.test.ts
```

Expected: 2 passing.

- [ ] **Step 5: Commit**

```powershell
rtk git add types/connectors/platform-kind.ts types/connectors/platform-kind.test.ts types/connectors/index.ts
rtk git commit -m "$(cat <<'EOF'
feat(connectors): add PlatformKind union with type guard

Lays the foundation for the connector type tree — every other connector
type imports this. Lists all 14 platforms across Phases 1-3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: MessageSegment shape

**Files:**

- Create: `types/connectors/segment.ts`
- Modify: `types/connectors/index.ts`
- Test: `types/connectors/segment.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// types/connectors/segment.test.ts
import { isTextSegment, isImageSegment, segmentsToPlainText, type MessageSegment } from "./segment"

describe("MessageSegment", () => {
  it("type guards narrow correctly", () => {
    const t: MessageSegment = { type: "text", text: "hi" }
    const i: MessageSegment = { type: "image", url: "http://x/y.png" }
    expect(isTextSegment(t)).toBe(true)
    expect(isTextSegment(i)).toBe(false)
    expect(isImageSegment(i)).toBe(true)
  })

  it("flattens segments to plain text for trigger matchers", () => {
    const segs: MessageSegment[] = [
      { type: "text", text: "hello " },
      { type: "mention", userId: "u1", displayName: "Alice" },
      { type: "text", text: ", check this:" },
      { type: "image", url: "http://x/y.png" },
      { type: "code", language: "ts", code: "const x = 1" },
    ]
    expect(segmentsToPlainText(segs)).toBe("hello @Alice, check this: [image] const x = 1")
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```powershell
rtk pnpm exec jest types/connectors/segment.test.ts
```

Expected: FAIL "Cannot find module './segment'".

- [ ] **Step 3: Implement**

```ts
// types/connectors/segment.ts
/**
 * The cross-platform message payload. A NormalizedInboundEvent carries a
 * MessageSegment[]; an OutboundRequest carries one too. Adapter parsers
 * project platform-native messages into this shape; adapter serialisers
 * project this shape back out, applying capability-aware degradation.
 *
 * Discriminator is `type`; renderer code switches on it.
 */
export type MessageSegment =
  | { type: "text"; text: string }
  | { type: "markdown"; md: string }
  | { type: "image"; url: string; alt?: string; width?: number; height?: number }
  | { type: "video"; url: string; thumbnailUrl?: string; durationSec?: number }
  | { type: "voice"; url: string; durationSec?: number; transcript?: string }
  | { type: "file"; url: string; name: string; mimeType: string; sizeBytes: number }
  | { type: "mention"; userId: string; displayName?: string }
  | { type: "emoji"; code: string }
  | { type: "code"; language?: string; code: string }
  | { type: "card"; card: PlatformCard }
  | { type: "reply"; messageId: string; snippet: string }
  | { type: "location"; lat: number; lon: number; name?: string }
  | { type: "poll"; question: string; options: string[]; multi?: boolean }

export type SegmentType = MessageSegment["type"]

/** Opaque platform-native card payload. Bus never inspects; adapters own. */
export interface PlatformCard {
  kind: string
  payload: unknown
}

export function isTextSegment(s: MessageSegment): s is Extract<MessageSegment, { type: "text" }> {
  return s.type === "text"
}
export function isImageSegment(s: MessageSegment): s is Extract<MessageSegment, { type: "image" }> {
  return s.type === "image"
}
export function isMarkdownSegment(
  s: MessageSegment
): s is Extract<MessageSegment, { type: "markdown" }> {
  return s.type === "markdown"
}

/**
 * Flatten a segment list into a plain-text projection used by trigger
 * matchers (TriggerPolicy.rules `keyword` / `slash-command`) and search.
 * Non-text segments project to a stable placeholder so a regex match on
 * the projection never accidentally fires on raw URLs or code.
 */
export function segmentsToPlainText(segments: MessageSegment[]): string {
  const out: string[] = []
  for (const s of segments) {
    switch (s.type) {
      case "text":
      case "markdown":
        out.push(s.type === "text" ? s.text : s.md)
        break
      case "mention":
        out.push(`@${s.displayName ?? s.userId}`)
        break
      case "image":
        out.push("[image]")
        break
      case "video":
        out.push("[video]")
        break
      case "voice":
        out.push(s.transcript ?? "[voice]")
        break
      case "file":
        out.push(`[file:${s.name}]`)
        break
      case "emoji":
        out.push(`[:${s.code}:]`)
        break
      case "code":
        out.push(s.code)
        break
      case "card":
        out.push("[card]")
        break
      case "reply":
        out.push(`[reply:${s.snippet}]`)
        break
      case "location":
        out.push(`[location:${s.name ?? `${s.lat},${s.lon}`}]`)
        break
      case "poll":
        out.push(`[poll:${s.question}]`)
        break
    }
  }
  return out.join(" ")
}
```

```ts
// types/connectors/index.ts (append)
export * from "./segment"
```

- [ ] **Step 4: Run, expect PASS**

```powershell
rtk pnpm exec jest types/connectors/segment.test.ts
```

Expected: 2 passing.

- [ ] **Step 5: Commit**

```powershell
rtk git add types/connectors/segment.ts types/connectors/segment.test.ts types/connectors/index.ts
rtk git commit -m "feat(connectors): add MessageSegment with plain-text projection"
```

---

## Task 4: ConversationReference + NormalizedInboundEvent

**Files:**

- Create: `types/connectors/event.ts`
- Modify: `types/connectors/index.ts`
- Test: `types/connectors/event.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// types/connectors/event.test.ts
import { buildConversationKey, parseConversationKey, type NormalizedInboundEvent } from "./event"

describe("conversationKey", () => {
  it("formats and parses without thread", () => {
    const k = buildConversationKey("telegram", "tg-personal", "12345")
    expect(k).toBe("telegram:tg-personal:12345")
    expect(parseConversationKey(k)).toEqual({
      platform: "telegram",
      adapterId: "tg-personal",
      remoteChatId: "12345",
      threadId: undefined,
    })
  })

  it("formats and parses with thread", () => {
    const k = buildConversationKey("discord", "ds-main", "ch-1", "th-7")
    expect(k).toBe("discord:ds-main:ch-1:th-7")
    expect(parseConversationKey(k)).toEqual({
      platform: "discord",
      adapterId: "ds-main",
      remoteChatId: "ch-1",
      threadId: "th-7",
    })
  })

  it("rejects bad conversation keys", () => {
    expect(() => parseConversationKey("nope")).toThrow(/conversationKey/)
  })

  it("typed event compiles", () => {
    const ev: NormalizedInboundEvent = {
      platform: "telegram",
      adapterId: "tg-1",
      selfId: "bot",
      messageId: "m1",
      conversationRef: { platform: "telegram", adapterId: "tg-1", chatId: 1 },
      conversationKey: "telegram:tg-1:1",
      sender: { id: "u-1", platform: "telegram", adapterId: "tg-1", remoteUserId: "1" },
      channel: { id: "1", kind: "private" },
      segments: [{ type: "text", text: "hi" }],
      plainText: "hi",
      mentions: { selfMentioned: false, users: [] },
      timestamp: 0,
      raw: {},
    }
    expect(ev.platform).toBe("telegram")
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```powershell
rtk pnpm exec jest types/connectors/event.test.ts
```

Expected: FAIL "Cannot find module './event'".

- [ ] **Step 3: Implement**

```ts
// types/connectors/event.ts
import type { PlatformKind } from "./platform-kind"
import type { MessageSegment } from "./segment"

/**
 * Opaque adapter-owned handle. Persisted on ChatSession.platformBinding
 * so the bus can do proactive outbound via continueConversation. Bus never
 * inspects fields beyond `platform` + `adapterId`.
 */
export interface ConversationReference {
  platform: PlatformKind
  adapterId: string
  [k: string]: unknown
}

export interface PlatformIdentity {
  /** Stable local id; same person across platforms after merge. */
  id: string
  platform: PlatformKind
  adapterId: string
  /** Platform-native user id (Telegram int, Discord snowflake, etc.) as string. */
  remoteUserId: string
  displayName?: string
  avatarUrl?: string
  mergedFromIds?: string[]
}

export type ChannelKind = "private" | "group" | "channel" | "thread"

export interface ChannelDescriptor {
  /** Bus-level channel id; unique per (platform, adapterId). */
  id: string
  name?: string
  kind: ChannelKind
  /** The platform-native channel id, kept verbatim for the adapter's use. */
  platformChannelId?: string
}

export interface ReplyDescriptor {
  messageId: string
  snippet: string
}

export interface MentionDescriptor {
  selfMentioned: boolean
  users: string[]
}

export interface NormalizedInboundEvent {
  platform: PlatformKind
  adapterId: string
  selfId: string
  messageId: string
  conversationRef: ConversationReference
  conversationKey: string
  sender: PlatformIdentity
  channel: ChannelDescriptor
  segments: MessageSegment[]
  plainText: string
  replyTo?: ReplyDescriptor
  mentions: MentionDescriptor
  timestamp: number
  raw: unknown
  channelData?: Record<string, unknown>
}

const KEY_SEP = ":"

export function buildConversationKey(
  platform: PlatformKind,
  adapterId: string,
  remoteChatId: string,
  threadId?: string
): string {
  const base = [platform, adapterId, remoteChatId].join(KEY_SEP)
  return threadId ? `${base}${KEY_SEP}${threadId}` : base
}

export interface ParsedConversationKey {
  platform: PlatformKind
  adapterId: string
  remoteChatId: string
  threadId: string | undefined
}

export function parseConversationKey(key: string): ParsedConversationKey {
  const parts = key.split(KEY_SEP)
  if (parts.length !== 3 && parts.length !== 4) {
    throw new Error(`invalid conversationKey: ${key}`)
  }
  return {
    platform: parts[0] as PlatformKind,
    adapterId: parts[1],
    remoteChatId: parts[2],
    threadId: parts[3],
  }
}
```

```ts
// types/connectors/index.ts (append)
export * from "./event"
```

- [ ] **Step 4: Run, expect PASS**

```powershell
rtk pnpm exec jest types/connectors/event.test.ts
```

- [ ] **Step 5: Commit**

```powershell
rtk git add types/connectors/event.ts types/connectors/event.test.ts types/connectors/index.ts
rtk git commit -m "feat(connectors): add NormalizedInboundEvent + conversationKey helpers"
```

---

## Task 5: OutboundRequest / Result types

**Files:**

- Create: `types/connectors/outbound.ts`
- Modify: `types/connectors/index.ts`
- Test: `types/connectors/outbound.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// types/connectors/outbound.test.ts
import { newIdempotencyKey, type OutboundRequest, type OutboundResult } from "./outbound"

describe("outbound", () => {
  it("idempotency keys are unique", () => {
    const a = newIdempotencyKey()
    const b = newIdempotencyKey()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("OutboundResult error shape compiles", () => {
    const r: OutboundResult = {
      ok: false,
      error: { code: "rate_limited", message: "429", retryable: true },
    }
    expect(r.ok).toBe(false)
  })

  it("OutboundRequest with minimal fields compiles", () => {
    const req: OutboundRequest = {
      conversationRef: { platform: "telegram", adapterId: "x" },
      segments: [{ type: "text", text: "hi" }],
      metadata: { idempotencyKey: newIdempotencyKey() },
    }
    expect(req.segments).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```ts
// types/connectors/outbound.ts
import type { ConversationReference } from "./event"
import type { MessageSegment, SegmentType } from "./segment"

export interface OutboundRequest {
  conversationRef: ConversationReference
  segments: MessageSegment[]
  replyTo?: { messageId: string }
  threadId?: string
  metadata: {
    /** Stable across retries; required. */
    idempotencyKey: string
    /** When this is a reply, the inbound StoredMessage.id that triggered it. */
    sourceMessageId?: string
    /** When this comes from a scheduled task, the task id. */
    scheduledTaskId?: string
  }
}

export interface OutboundError {
  /** Stable code: "rate_limited" | "auth_failed" | "platform_4xx" | "platform_5xx" | "network" | "validation" | "unsupported_segment" | "circuit_open" */
  code: string
  message: string
  retryable: boolean
  /** Optional platform-side hint ("retry-after seconds"). */
  retryAfterMs?: number
}

export interface SegmentDowngrade {
  from: SegmentType
  to: SegmentType
  reason: string
}

export interface OutboundResult {
  ok: boolean
  platformMessageId?: string
  error?: OutboundError
  downgrades?: SegmentDowngrade[]
}

/**
 * UUIDv4 generator using crypto.randomUUID() (available in jsdom 22+ and
 * all Tauri webview targets).
 */
export function newIdempotencyKey(): string {
  // crypto.randomUUID always returns lowercase canonical UUIDv4.
  return crypto.randomUUID()
}
```

```ts
// types/connectors/index.ts (append)
export * from "./outbound"
```

- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit**

```powershell
rtk git commit -am "feat(connectors): add OutboundRequest/Result types + idempotency key generator"
```

---

## Task 6: Capability flags + degrade fallback chain

**Files:**

- Create: `types/connectors/capability.ts`
- Modify: `types/connectors/index.ts`
- Test: `types/connectors/capability.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// types/connectors/capability.test.ts
import { ALL_CAPABILITIES, defaultDegradeChain, hasCapability, type Capability } from "./capability"

describe("capability flags", () => {
  it("ALL_CAPABILITIES includes the core text/markdown/file family", () => {
    for (const c of [
      "send.text",
      "send.markdown",
      "send.image",
      "send.file",
      "send.reply",
      "send.mention",
      "send.thread",
      "edit",
      "delete",
      "typing",
      "history.fetch",
    ] as Capability[]) {
      expect(ALL_CAPABILITIES).toContain(c)
    }
  })

  it("hasCapability matches case-sensitively", () => {
    const adapter = ["send.text", "send.markdown"] as Capability[]
    expect(hasCapability(adapter, "send.text")).toBe(true)
    expect(hasCapability(adapter, "send.image")).toBe(false)
  })

  it("defaultDegradeChain falls card → markdown → text", () => {
    expect(defaultDegradeChain("card")).toEqual(["card", "markdown", "text"])
    expect(defaultDegradeChain("markdown")).toEqual(["markdown", "text"])
    expect(defaultDegradeChain("text")).toEqual(["text"])
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```ts
// types/connectors/capability.ts
import type { SegmentType } from "./segment"

export const ALL_CAPABILITIES = [
  // send.*
  "send.text",
  "send.markdown",
  "send.html",
  "send.image",
  "send.voice",
  "send.video",
  "send.file",
  "send.card",
  "send.poll",
  "send.location",
  "send.reply",
  "send.mention",
  "send.thread",
  "send.reaction",
  // mutations
  "edit",
  "delete",
  "typing",
  "history.fetch",
  // platform-specific rich content (escape hatches)
  "rich-markdown.telegram",
  "rich-markdown.slack",
  "rich-card.lark",
  "rich-card.slack",
] as const

export type Capability = (typeof ALL_CAPABILITIES)[number]

export function hasCapability(flags: readonly Capability[], cap: Capability): boolean {
  return flags.includes(cap)
}

/**
 * Default per-segment-type degradation order. Each adapter MAY override via
 * its own degrade table; this is the conservative default. The bus walks
 * the chain from index 0 onward, picking the first segment type whose
 * `send.<type>` capability the adapter declares.
 */
export function defaultDegradeChain(from: SegmentType): SegmentType[] {
  switch (from) {
    case "card":
      return ["card", "markdown", "text"]
    case "markdown":
      return ["markdown", "text"]
    case "html":
      // html isn't a SegmentType yet, but adapters using `markdown` segments
      // fall back to text as their final stop.
      return ["markdown", "text"] as SegmentType[]
    case "image":
    case "video":
    case "voice":
    case "file":
      return [from, "text"]
    case "emoji":
    case "mention":
    case "reply":
    case "location":
    case "poll":
    case "code":
      return [from, "text"]
    case "text":
    default:
      return ["text"]
  }
}
```

```ts
// types/connectors/index.ts (append)
export * from "./capability"
```

- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit**

```powershell
rtk git commit -am "feat(connectors): add Capability flag union + default degrade chain"
```

---

## Task 7: TriggerPolicy types

**Files:**

- Create: `types/connectors/policy.ts`
- Modify: `types/connectors/index.ts`
- Test: `types/connectors/policy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// types/connectors/policy.test.ts
import { defaultPrivateChatPolicy, type TriggerPolicy } from "./policy"

describe("TriggerPolicy", () => {
  it("default private-chat policy engages on every message", () => {
    const p = defaultPrivateChatPolicy()
    expect(p.rules.some((r) => r.kind === "private-default")).toBe(true)
    expect(p.storeUnmatchedInDraftMode).toBe(true)
  })

  it("typed policy compiles", () => {
    const p: TriggerPolicy = {
      rules: [{ kind: "self-mention" }, { kind: "slash-command", prefixes: ["/ask"] }],
      blockers: [
        { kind: "rate-limit", perUserPerMin: 5, perChannelPerMin: 30 },
        { kind: "cooldown-after-bot-reply", secs: 3 },
      ],
      storeUnmatchedInDraftMode: false,
    }
    expect(p.rules).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```ts
// types/connectors/policy.ts
export type TriggerRule =
  | { kind: "private-default" }
  | { kind: "self-mention" }
  | { kind: "reply-to-bot" }
  | { kind: "slash-command"; prefixes: string[] }
  | { kind: "keyword"; words: string[]; caseInsensitive: boolean }
  | { kind: "user-allowlist"; userIds: string[] }
  | { kind: "channel-allowlist"; channelIds: string[] }

export type TriggerBlocker =
  | { kind: "user-blocklist"; userIds: string[] }
  | { kind: "channel-blocklist"; channelIds: string[] }
  | { kind: "keyword-blocklist"; words: string[] }
  | { kind: "rate-limit"; perUserPerMin: number; perChannelPerMin: number }
  | { kind: "cooldown-after-bot-reply"; secs: number }

export interface TriggerPolicy {
  rules: TriggerRule[]
  blockers: TriggerBlocker[]
  storeUnmatchedInDraftMode: boolean
}

export type ConnectorMode = "auto" | "manual" | "draft"

export const ALL_MODES = ["auto", "manual", "draft"] as const

/**
 * Default policy applied to private chats: every message engages the AI;
 * unmatched messages stored in draft mode so the user can browse history.
 * Adapters typically use this verbatim for private channels and use the
 * `defaultGroupChatPolicy` below for groups/channels.
 */
export function defaultPrivateChatPolicy(): TriggerPolicy {
  return {
    rules: [{ kind: "private-default" }],
    blockers: [{ kind: "rate-limit", perUserPerMin: 30, perChannelPerMin: 60 }],
    storeUnmatchedInDraftMode: true,
  }
}

export function defaultGroupChatPolicy(): TriggerPolicy {
  return {
    rules: [
      { kind: "self-mention" },
      { kind: "reply-to-bot" },
      { kind: "slash-command", prefixes: ["/ask", "/agent"] },
    ],
    blockers: [
      { kind: "rate-limit", perUserPerMin: 5, perChannelPerMin: 20 },
      { kind: "cooldown-after-bot-reply", secs: 3 },
    ],
    storeUnmatchedInDraftMode: false,
  }
}
```

```ts
// types/connectors/index.ts (append)
export * from "./policy"
```

- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit**

```powershell
rtk git commit -am "feat(connectors): add TriggerPolicy types + safe defaults"
```

---

## Task 8: PlatformBinding + ChatSession extension

**Files:**

- Create: `types/connectors/binding.ts`
- Modify: `types/connectors/index.ts`
- Modify: `lib/claude/types.ts` (add `ChatSession.platformBinding?`, `StoredMessage.metadata.platformMessage?`, `Character.platformDefaults?`)
- Test: `types/connectors/binding.test.ts`

- [ ] **Step 1: Read the existing ChatSession type**

```powershell
rtk grep -n "interface ChatSession" lib/claude/types.ts
```

Locate the interface (likely around `lib/claude/types.ts:344`). You'll add `platformBinding?: PlatformBinding` after the existing optional fields.

- [ ] **Step 2: Write the failing test**

```ts
// types/connectors/binding.test.ts
import type { PlatformBinding } from "./binding"
import type { ChatSession } from "@/lib/claude/types"

describe("PlatformBinding", () => {
  it("attaches to ChatSession via platformBinding optional", () => {
    const binding: PlatformBinding = {
      adapterId: "tg-personal",
      conversationKey: "telegram:tg-personal:12345",
      platform: "telegram",
      conversationRef: { platform: "telegram", adapterId: "tg-personal", chatId: 12345 },
    }
    const session: ChatSession = {
      id: "s1",
      title: "DM with Alice",
      createdAt: 0,
      updatedAt: 0,
      platformBinding: binding,
    }
    expect(session.platformBinding?.platform).toBe("telegram")
  })
})
```

- [ ] **Step 3: Run, expect FAIL**

```powershell
rtk pnpm exec jest types/connectors/binding.test.ts
```

Expected: FAIL "Cannot find module './binding'".

- [ ] **Step 4: Implement binding.ts**

```ts
// types/connectors/binding.ts
import type { PlatformKind } from "./platform-kind"
import type { ConversationReference } from "./event"
import type { ConnectorMode, TriggerPolicy } from "./policy"

export interface PlatformBinding {
  adapterId: string
  conversationKey: string
  platform: PlatformKind
  /** Persisted alongside binding so proactive outbound has a handle. */
  conversationRef: ConversationReference
}

/** Optional defaults a Character can ship per platform binding. */
export interface CharacterPlatformDefaults {
  mode?: ConnectorMode
  trigger?: Partial<TriggerPolicy>
}
```

```ts
// types/connectors/index.ts (append)
export * from "./binding"
```

- [ ] **Step 5: Extend ChatSession + StoredMessage + Character in `lib/claude/types.ts`**

In the `ChatSession` interface, add (next to `sdkSessionId?`):

```ts
  /** Set when this session is bound to an external IM platform conversation. */
  platformBinding?: import("@/types/connectors/binding").PlatformBinding
```

In the `StoredMessage` interface's `metadata` field:

```ts
  metadata?: {
    // ... existing fields kept verbatim ...
    /** Set on inbound messages from a platform connector. */
    platformMessage?: {
      messageId: string
      platform: import("@/types/connectors/platform-kind").PlatformKind
      sender: import("@/types/connectors/event").PlatformIdentity
    }
    /** Set on outbound (assistant) messages once enqueued. */
    outboundJobId?: string
  }
```

In the `Character` interface:

```ts
  platformDefaults?: import("@/types/connectors/binding").CharacterPlatformDefaults
```

- [ ] **Step 6: Run, expect PASS**

```powershell
rtk pnpm exec jest types/connectors/binding.test.ts
rtk pnpm typecheck
```

Both green.

- [ ] **Step 7: Commit**

```powershell
rtk git add types/connectors/binding.ts types/connectors/binding.test.ts types/connectors/index.ts lib/claude/types.ts
rtk git commit -m "feat(connectors): extend ChatSession/StoredMessage/Character with platform binding"
```

---

## Task 9: AdapterMeta + AdapterContext + PlatformAdapter contract

**Files:**

- Create: `types/connectors/adapter.ts`
- Modify: `types/connectors/index.ts`
- Test: `types/connectors/adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// types/connectors/adapter.test.ts
import type { PlatformAdapter, AdapterMeta } from "./adapter"

describe("PlatformAdapter", () => {
  it("a minimal adapter compiles against the interface", () => {
    class Stub implements PlatformAdapter {
      readonly id = "stub-1"
      readonly meta: AdapterMeta = {
        type: "telegram",
        displayName: "Stub",
        version: "0.0.0",
        capabilities: ["send.text"],
        transportModes: ["longpoll"],
        configSchema: { type: "object", properties: {} },
      }
      async start() {}
      async stop() {}
      health() {
        return { state: "running" as const }
      }
      async send() {
        return { ok: true, platformMessageId: "1" }
      }
    }
    const a: PlatformAdapter = new Stub()
    expect(a.meta.type).toBe("telegram")
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```ts
// types/connectors/adapter.ts
import type { PlatformKind } from "./platform-kind"
import type { Capability } from "./capability"
import type { NormalizedInboundEvent } from "./event"
import type { OutboundRequest, OutboundResult } from "./outbound"
import type { MessageSegment } from "./segment"

export type TransportMode = "longpoll" | "webhook" | "reverse-ws" | "gateway" | "imap-smtp" | "stub" // tests only

export interface AdapterMeta {
  type: PlatformKind
  displayName: string
  version: string
  capabilities: readonly Capability[]
  transportModes: readonly TransportMode[]
  /** JSON Schema (draft-07) describing the per-instance settings shape. Drives the auto-generated form. */
  configSchema: object
}

export type AdapterHealthState = "starting" | "running" | "degraded" | "down"

export interface AdapterHealth {
  state: AdapterHealthState
  reason?: string
  /** Wall-clock timestamp of the last successful inbound or outbound. */
  lastActivityAt?: number
}

export interface AdapterLogger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

/** Keyring helpers scoped to one adapter instance. Backed by Tauri keyring on desktop, refused on web. */
export interface AdapterSecrets {
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
  list(): Promise<string[]>
}

export interface AdapterAttachmentRef {
  /** Local file URL — the renderer can resolve via a Tauri convertFileSrc. */
  localUrl: string
  /** Original platform-side reference (e.g. Telegram file_id). */
  remoteRef: string
}

export interface AttachmentDescriptor {
  url: string
  name?: string
  mimeType?: string
  sizeBytes?: number
}

export interface HistoryFetchOpts {
  before?: string
  after?: string
  max?: number
}

export interface AdapterContext {
  /** Push a normalized inbound event to the bus. */
  emit: (event: NormalizedInboundEvent) => Promise<void>
  /** Reach into Rust-side connectors_* commands. */
  tauri: {
    httpRequest: (req: TauriHttpRequest) => Promise<TauriHttpResponse>
    openWs: (req: TauriWsRequest) => Promise<TauriWsHandle>
    fetchAttachment: (adapterId: string, remoteRef: string) => Promise<AdapterAttachmentRef>
    bindWebhookRoute: (adapterId: string, path: string) => Promise<void>
    unbindWebhookRoute: (adapterId: string, path: string) => Promise<void>
    /** Resolve the public URL prefix the user pasted into the platform. */
    publicBaseUrl: () => Promise<string | null>
  }
  secrets: AdapterSecrets
  logger: AdapterLogger
  /** Aborts when the adapter stops; long-running loops should respect this. */
  signal: AbortSignal
  /** This instance's id; convenience accessor. */
  adapterId: string
}

export interface TauriHttpRequest {
  url: string
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

export interface TauriHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export interface TauriWsRequest {
  url: string
  headers?: Record<string, string>
}

export interface TauriWsHandle {
  /** Stable handle id. Renderer subscribes to `connectors://ws/<id>` events. */
  id: string
  send: (data: string) => Promise<void>
  close: () => Promise<void>
}

export interface PlatformAdapter {
  readonly meta: AdapterMeta
  readonly id: string

  start(ctx: AdapterContext): Promise<void>
  stop(): Promise<void>
  health(): AdapterHealth

  send(req: OutboundRequest): Promise<OutboundResult>
  edit?(messageId: string, patch: OutboundRequest): Promise<OutboundResult>
  delete?(messageId: string): Promise<void>
  setTyping?(conversationKey: string, on: boolean): Promise<void>
  uploadFile?(file: AttachmentDescriptor): Promise<AdapterAttachmentRef>
  fetchHistory?(
    conversationKey: string,
    opts: HistoryFetchOpts
  ): AsyncIterable<NormalizedInboundEvent>
  refreshCredentials?(): Promise<void>
}
```

```ts
// types/connectors/index.ts (append)
export * from "./adapter"
```

- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit**

```powershell
rtk git commit -am "feat(connectors): add PlatformAdapter contract + AdapterContext"
```

---

## Task 10: AuditEntry shapes

**Files:**

- Create: `types/connectors/audit.ts`
- Modify: `types/connectors/index.ts`
- Test: `types/connectors/audit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// types/connectors/audit.test.ts
import { auditDeliveryError, type AuditEntry } from "./audit"

describe("audit", () => {
  it("auditDeliveryError builds a typed entry", () => {
    const e = auditDeliveryError({
      adapterId: "tg-1",
      conversationKey: "telegram:tg-1:1",
      idempotencyKey: "abc",
      reason: "rate_limited",
      message: "429",
    })
    expect(e.kind).toBe("delivery.error")
    expect(e.adapterId).toBe("tg-1")
  })

  it("kind union covers the ship-set", () => {
    const e: AuditEntry = {
      id: "1",
      adapterId: "x",
      kind: "circuit.opened",
      at: 0,
    }
    expect(e.kind).toBe("circuit.opened")
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```ts
// types/connectors/audit.ts
export type AuditKind =
  | "delivery.success"
  | "delivery.error"
  | "delivery.deadlettered"
  | "delivery.downgraded"
  | "inbound.received"
  | "inbound.deduped"
  | "inbound.policy_blocked"
  | "inbound.signature_failed"
  | "circuit.opened"
  | "circuit.half_opened"
  | "circuit.closed"
  | "rate_limit.tripped"
  | "credential.refreshed"
  | "adapter.started"
  | "adapter.stopped"
  | "adapter.error"

export interface AuditEntry {
  id: string
  adapterId: string
  kind: AuditKind
  at: number
  conversationKey?: string
  idempotencyKey?: string
  reason?: string
  message?: string
  /** Free-form structured payload; redaction-aware logger writes this. */
  fields?: Record<string, unknown>
}

export interface DeliveryErrorInput {
  adapterId: string
  conversationKey: string
  idempotencyKey: string
  reason: string
  message: string
  fields?: Record<string, unknown>
}

export function auditDeliveryError(input: DeliveryErrorInput): AuditEntry {
  return {
    id: crypto.randomUUID(),
    adapterId: input.adapterId,
    kind: "delivery.error",
    at: Date.now(),
    conversationKey: input.conversationKey,
    idempotencyKey: input.idempotencyKey,
    reason: input.reason,
    message: input.message,
    fields: input.fields,
  }
}
```

```ts
// types/connectors/index.ts (append)
export * from "./audit"
```

- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit**

```powershell
rtk git commit -am "feat(connectors): add AuditEntry shapes + delivery error helper"
```

---

## Task 11: Dexie v18 schema migration (8 new tables)

**Files:**

- Create: `lib/db/connector-types.ts` (per-row interfaces, mirroring `plugin-types.ts`)
- Modify: `lib/db/schema.ts` (add `version(18)` block)
- Test: extend `lib/db/schema.test.ts`

This is the largest single Dexie change in the project so far; do it carefully. Pattern source: `lib/db/schema.ts:445-478` (the v15 plugin-table block) — copy structure verbatim, just with new tables.

- [ ] **Step 1: Read the existing v17 block end-to-end**

```powershell
rtk grep -n "this.version(17)" lib/db/schema.ts
```

Then `Read` the file from that line through the end of the constructor to capture the exact `.stores({...})` shape. **The v18 block must include EVERY table from v17 plus the 8 new ones** — Dexie requires the full schema each version.

- [ ] **Step 2: Write the per-row types**

```ts
// lib/db/connector-types.ts
import type { PlatformKind } from "@/types/connectors/platform-kind"
import type { OutboundRequest } from "@/types/connectors/outbound"
import type { TriggerPolicy, ConnectorMode } from "@/types/connectors/policy"
import type { TransportMode } from "@/types/connectors/adapter"
import type { ConversationReference, PlatformIdentity } from "@/types/connectors/event"
import type { AuditEntry } from "@/types/connectors/audit"
import type { MessageSegment } from "@/types/connectors/segment"

export interface AdapterInstanceRow {
  id: string
  type: PlatformKind
  displayName: string
  enabled: boolean
  transportMode: TransportMode
  /** Non-secret JSON-Schema-validated settings. */
  settings: Record<string, unknown>
  /** Reference to keyring entries; never holds the secret value. */
  credentialsRef: { keyringService: string; accounts: string[] }
  trigger: TriggerPolicy
  defaultCharacterId?: string
  defaultMode: ConnectorMode
  /** For webhook / reverse-WS: path under the connectors axum app. */
  webhookPath?: string
  /** Resolved public URL (tunnel or user-supplied) for paste into platform settings. */
  publicUrl?: string
  /** Per-adapter quiet hours, optional. */
  quietHours?: { from: string; to: string; tz: string }
  /** Adapter is muted globally (drops outbound). */
  muted?: boolean
  createdAt: number
  updatedAt: number
}

export interface PlatformIdentityRow extends PlatformIdentity {
  /** Last time we observed this identity; helps cleanup. */
  lastSeenAt: number
}

export interface InboundLedgerRow {
  /** `${adapterId}:${platformMessageId}` */
  id: string
  adapterId: string
  platformMessageId: string
  receivedAt: number
}

export type OutboundJobStatus = "pending" | "sending" | "sent" | "failed" | "deadlettered"

export interface OutboundJobRow {
  id: string
  adapterId: string
  conversationKey: string
  request: OutboundRequest
  status: OutboundJobStatus
  attempts: number
  lastError?: string
  /** Error code from the last attempt, used by the audit log + breaker. */
  lastErrorCode?: string
  createdAt: number
  /** Wall-clock at which the runner is allowed to retry. */
  nextAttemptAt: number
  idempotencyKey: string
}

export interface ConversationOverrideRow {
  id: string
  conversationKey: string
  /** The cognia-next ChatSession this conversation maps to. */
  sessionId: string
  mode?: ConnectorMode
  characterId?: string
  trigger?: Partial<TriggerPolicy>
  pinned?: boolean
  archived?: boolean
  /** Last-read pointer; in tandem with the existing sessionState table. */
  lastReadAt?: number
  createdAt: number
  updatedAt: number
}

export interface ConnectorAuditRow extends AuditEntry {}

export type ConnectorDraftStatus = "pending" | "approved" | "rejected" | "expired"

export interface ConnectorDraftRow {
  id: string
  conversationKey: string
  sessionId: string
  segments: MessageSegment[]
  status: ConnectorDraftStatus
  createdAt: number
  expiresAt?: number
  /** The inbound StoredMessage.id this draft is replying to. */
  sourceMessageId?: string
  /** Pre-built OutboundRequest the user can fire on approve (idempotencyKey already issued). */
  outboundPreview?: OutboundRequest
}

export interface ConnectorAttachmentRow {
  id: string
  adapterId: string
  remoteRef: string
  /** Path inside <appData>/cognia/connectors/cache (encrypted on disk). */
  localPath: string
  mimeType: string
  sizeBytes: number
  fetchedAt: number
  expiresAt?: number
}

/** Borrowed-shape: same ConversationReference as types/connectors/event.ts. */
export type ConversationReferenceRow = ConversationReference
```

- [ ] **Step 3: Add the v18 block to `schema.ts`**

In `CogniaDB`, add the eight `Table<...>` declarations alongside the existing ones (right after `mcpAuditLog`):

```ts
  adapterInstances!: Table<AdapterInstanceRow, string>
  platformIdentities!: Table<PlatformIdentityRow, string>
  inboundLedger!: Table<InboundLedgerRow, string>
  outboundQueue!: Table<OutboundJobRow, string>
  conversationOverrides!: Table<ConversationOverrideRow, string>
  connectorAudit!: Table<ConnectorAuditRow, string>
  connectorDrafts!: Table<ConnectorDraftRow, string>
  connectorAttachments!: Table<ConnectorAttachmentRow, string>
```

Then in the constructor, after the existing `this.version(17).stores({...})`, append the v18 block. Copy every table from v17 verbatim, then add the 8 new ones:

```ts
// v18 — Platform Connectors (ADR-0008). Pure additions; no upgrade hook
// because we don't migrate existing rows. Indexes calibrated to the
// hot paths in lib/connectors/:
//   • adapterInstances — by enabled/type for the bus boot list, by displayName for nav.
//   • platformIdentities — composite [platform+remoteUserId] for cross-platform
//     identity merge, [adapterId+remoteUserId] for per-adapter directory lookups.
//   • inboundLedger — composite [adapterId+platformMessageId] for O(1) dedup
//     check; receivedAt for the LRU prune sweep (cap 10k rows).
//   • outboundQueue — by conversationKey for FIFO lane lookup, by [conversationKey+createdAt]
//     for in-order picking, by status / nextAttemptAt for the runner's
//     "next pending due" query, by idempotencyKey for retry coalescing.
//   • conversationOverrides — by conversationKey for resolution, by sessionId
//     for "session → override" lookups when the chat UI binds.
//   • connectorAudit — by adapterId for per-adapter filter, by [adapterId+at]
//     for time-ordered scrolling. Capped at 5000 rows by the writer.
//   • connectorDrafts — by conversationKey + status for "next pending draft",
//     by [conversationKey+createdAt] for order.
//   • connectorAttachments — composite [adapterId+remoteRef] for "do I have it",
//     by adapterId for adapter-scoped cleanup, by mimeType for filters.
this.version(18).stores({
  // ... copy every table from v17 verbatim above this comment ...
  adapterInstances: "id, type, enabled, displayName, [type+enabled], createdAt, updatedAt",
  platformIdentities:
    "&id, [platform+remoteUserId], [adapterId+remoteUserId], remoteUserId, platform, lastSeenAt",
  inboundLedger: "&id, [adapterId+platformMessageId], adapterId, receivedAt",
  outboundQueue:
    "&id, conversationKey, [conversationKey+createdAt], status, nextAttemptAt, idempotencyKey, [adapterId+status]",
  conversationOverrides: "&id, &conversationKey, sessionId, pinned, archived",
  connectorAudit: "&id, adapterId, kind, at, [adapterId+at]",
  connectorDrafts:
    "&id, conversationKey, sessionId, [conversationKey+createdAt], status, expiresAt",
  connectorAttachments: "&id, [adapterId+remoteRef], adapterId, mimeType, fetchedAt, expiresAt",
})
```

Don't forget the imports at the top of schema.ts:

```ts
import type {
  AdapterInstanceRow,
  PlatformIdentityRow,
  InboundLedgerRow,
  OutboundJobRow,
  ConversationOverrideRow,
  ConnectorAuditRow,
  ConnectorDraftRow,
  ConnectorAttachmentRow,
} from "./connector-types"
```

- [ ] **Step 4: Extend the schema test**

Add after the existing `it("v17 wiki + audit tables ...")` block:

```ts
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
    id: "tg-1:m-1",
    adapterId: "tg-1",
    platformMessageId: "m-1",
    receivedAt: now,
  })
  expect((await db.inboundLedger.get("tg-1:m-1"))?.adapterId).toBe("tg-1")

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
```

Also extend the existing "every advertised table is wired" assertion with the eight new tables.

- [ ] **Step 5: Run the schema test**

```powershell
rtk pnpm exec jest lib/db/schema.test.ts
```

Expected: all green, including new v18 case.

- [ ] **Step 6: Commit**

```powershell
rtk git add lib/db/connector-types.ts lib/db/schema.ts lib/db/schema.test.ts
rtk git commit -m "feat(connectors): bump Dexie to v18 with 8 connector tables"
```

---

## Task 12: Per-table CRUD modules — adapterInstances

**Files:**

- Create: `lib/db/adapter-instances.ts`
- Test: `lib/db/adapter-instances.test.ts`

Pattern source: `lib/db/mcp-servers.ts` (a table with similar shape: id, name, enabled, settings).

- [ ] **Step 1: Failing test**

```ts
// lib/db/adapter-instances.test.ts
import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "./schema"
import {
  createAdapterInstance,
  deleteAdapterInstance,
  getAdapterInstance,
  listAdapterInstances,
  listEnabledAdapterInstances,
  updateAdapterInstance,
} from "./adapter-instances"

describe("adapterInstances CRUD", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("create / get / update / delete", async () => {
    const row = await createAdapterInstance({
      type: "telegram",
      displayName: "Test bot",
      transportMode: "longpoll",
      settings: {},
      defaultMode: "auto",
      trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    })
    expect(row.id).toBeTruthy()
    expect(row.enabled).toBe(false)
    expect(row.credentialsRef.keyringService).toBe("com.cognia.platforms")

    const fetched = await getAdapterInstance(row.id)
    expect(fetched?.type).toBe("telegram")

    await updateAdapterInstance(row.id, { enabled: true, displayName: "Renamed" })
    const updated = await getAdapterInstance(row.id)
    expect(updated?.enabled).toBe(true)
    expect(updated?.displayName).toBe("Renamed")

    const all = await listAdapterInstances()
    expect(all).toHaveLength(1)

    const enabled = await listEnabledAdapterInstances()
    expect(enabled).toHaveLength(1)

    await deleteAdapterInstance(row.id)
    expect(await listAdapterInstances()).toHaveLength(0)
  })

  it("listEnabledAdapterInstances filters out disabled rows", async () => {
    const a = await createAdapterInstance({
      type: "telegram",
      displayName: "A",
      transportMode: "longpoll",
      settings: {},
      defaultMode: "auto",
      trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    })
    await createAdapterInstance({
      type: "discord",
      displayName: "B",
      transportMode: "gateway",
      settings: {},
      defaultMode: "auto",
      trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    })
    await updateAdapterInstance(a.id, { enabled: true })
    const enabled = await listEnabledAdapterInstances()
    expect(enabled.map((r) => r.displayName)).toEqual(["A"])
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```ts
// lib/db/adapter-instances.ts
import { getDb } from "./schema"
import type { AdapterInstanceRow } from "./connector-types"

export interface CreateAdapterInstanceInput extends Omit<
  AdapterInstanceRow,
  "id" | "enabled" | "credentialsRef" | "createdAt" | "updatedAt"
> {
  /** Optional override; defaults to false. */
  enabled?: boolean
  /** Optional override; defaults to standard com.cognia.platforms service. */
  credentialsRef?: AdapterInstanceRow["credentialsRef"]
}

const KEYRING_SERVICE = "com.cognia.platforms"

export async function createAdapterInstance(
  input: CreateAdapterInstanceInput
): Promise<AdapterInstanceRow> {
  const now = Date.now()
  const row: AdapterInstanceRow = {
    id: crypto.randomUUID(),
    enabled: input.enabled ?? false,
    credentialsRef: input.credentialsRef ?? { keyringService: KEYRING_SERVICE, accounts: [] },
    createdAt: now,
    updatedAt: now,
    ...input,
  }
  await getDb().adapterInstances.add(row)
  return row
}

export async function getAdapterInstance(id: string): Promise<AdapterInstanceRow | undefined> {
  return getDb().adapterInstances.get(id)
}

export async function listAdapterInstances(): Promise<AdapterInstanceRow[]> {
  return getDb().adapterInstances.toArray()
}

export async function listEnabledAdapterInstances(): Promise<AdapterInstanceRow[]> {
  return getDb()
    .adapterInstances.where("enabled")
    .equals(1)
    .or("enabled")
    .equals("true")
    .toArray()
    .then(() =>
      getDb()
        .adapterInstances.filter((r) => r.enabled)
        .toArray()
    )
}

export async function updateAdapterInstance(
  id: string,
  patch: Partial<Omit<AdapterInstanceRow, "id" | "createdAt">>
): Promise<void> {
  await getDb().adapterInstances.update(id, { ...patch, updatedAt: Date.now() })
}

export async function deleteAdapterInstance(id: string): Promise<void> {
  await getDb().adapterInstances.delete(id)
}
```

(Note: IndexedDB doesn't index booleans reliably, so `listEnabledAdapterInstances` filters in memory — same pattern used in `lib/db/mcp-servers.ts`.)

- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit**

```powershell
rtk git commit -am "feat(connectors): add adapterInstances CRUD"
```

---

## Tasks 13–18: Per-table CRUD modules — apply the same template

For each remaining new table, follow Task 12's exact template:

| Task | Module                             | Test cases                                                                                                       |
| ---- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 13   | `lib/db/platform-identities.ts`    | upsert by `[platform+remoteUserId]`; merge two ids; list by adapter; bump `lastSeenAt`                           |
| 14   | `lib/db/inbound-ledger.ts`         | `recordInbound(adapterId, msgId)` returns true on first call, false on duplicate; `pruneOldest(cap)`             |
| 15   | `lib/db/outbound-jobs.ts`          | enqueue / pickNextDue / markSending / markSent / markFailed / markDeadlettered; FIFO order per `conversationKey` |
| 16   | `lib/db/conversation-overrides.ts` | upsertByConversationKey; readForResolution(conversationKey); pin/unpin/archive                                   |
| 17   | `lib/db/connector-audit.ts`        | `append(entry)` + cap pruning at 5000 (mirrors `lib/db/mcp-audit-log.ts`)                                        |
| 18   | `lib/db/connector-drafts.ts`       | create / list pending by conversation / approve / reject / expire-sweep                                          |
| 18b  | `lib/db/connector-attachments.ts`  | upsert by `[adapterId+remoteRef]`; reverse-lookup; expire/cleanup                                                |

Each task = ~10 mins; pattern is mechanical (failing test → impl → pass → commit).

- [ ] All 7 modules implemented; commit each independently.

---

## Task 19: Tauri command surface skeleton (Rust)

**Files:**

- Create: `src-tauri/src/connectors/mod.rs`
- Create: `src-tauri/src/connectors/types.rs`
- Create: `src-tauri/src/connectors/state.rs`
- Create: `src-tauri/src/connectors/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register module + commands)
- Modify: `src-tauri/Cargo.toml` (add deps)

Pattern source: `src-tauri/src/remote_control/mod.rs` and its sibling files. Mirror the module layout: `mod.rs` re-exports the public surface, `state.rs` defines a `ConnectorsState` Tauri-managed wrapper, `commands.rs` is `#[tauri::command]`s only.

- [ ] **Step 1: Add Cargo dependencies**

In `src-tauri/Cargo.toml`, add to `[dependencies]`:

```toml
axum = { version = "0.7", default-features = false, features = ["http1", "json", "tokio", "ws"] }
tower = { version = "0.5", features = ["limit", "timeout"] }
tower-http = { version = "0.6", features = ["limit", "trace", "cors"] }
hmac = "0.12"
sha1 = "0.10"
sha2 = "0.10"
ed25519-dalek = "2"
subtle = "2"
hex = "0.4"
```

(Many of these are already pulled in transitively; declaring explicit deps lets us stop relying on transitives.)

- [ ] **Step 2: Run cargo check**

```powershell
cd src-tauri
rtk cargo check
cd ..
```

Expected: clean.

- [ ] **Step 3: Module skeleton**

```rust
// src-tauri/src/connectors/mod.rs
pub mod commands;
pub mod state;
pub mod types;

pub use state::ConnectorsState;
```

```rust
// src-tauri/src/connectors/types.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterRegistration {
    pub adapter_id: String,
    pub adapter_type: String,
    pub webhook_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorsHealth {
    pub server_running: bool,
    pub bound_addr: Option<String>,
    pub registered_adapter_count: usize,
}
```

```rust
// src-tauri/src/connectors/state.rs
use std::collections::HashMap;
use std::sync::Arc;
use parking_lot::Mutex;

use super::types::AdapterRegistration;

#[derive(Default)]
pub struct ConnectorsStateInner {
    pub registered_adapters: HashMap<String, AdapterRegistration>,
    pub server_running: bool,
    pub bound_addr: Option<String>,
}

#[derive(Clone, Default)]
pub struct ConnectorsState {
    pub inner: Arc<Mutex<ConnectorsStateInner>>,
}

impl ConnectorsState {
    pub fn new() -> Self {
        Self::default()
    }
}
```

```rust
// src-tauri/src/connectors/commands.rs
use tauri::State;
use super::state::ConnectorsState;
use super::types::{AdapterRegistration, ConnectorsHealth};

#[tauri::command]
pub async fn connectors_register_adapter(
    state: State<'_, ConnectorsState>,
    reg: AdapterRegistration,
) -> Result<(), String> {
    let mut inner = state.inner.lock();
    inner.registered_adapters.insert(reg.adapter_id.clone(), reg);
    Ok(())
}

#[tauri::command]
pub async fn connectors_unregister_adapter(
    state: State<'_, ConnectorsState>,
    adapter_id: String,
) -> Result<(), String> {
    let mut inner = state.inner.lock();
    inner.registered_adapters.remove(&adapter_id);
    Ok(())
}

#[tauri::command]
pub async fn connectors_health(
    state: State<'_, ConnectorsState>,
) -> Result<ConnectorsHealth, String> {
    let inner = state.inner.lock();
    Ok(ConnectorsHealth {
        server_running: inner.server_running,
        bound_addr: inner.bound_addr.clone(),
        registered_adapter_count: inner.registered_adapters.len(),
    })
}
```

- [ ] **Step 4: Register in `lib.rs`**

In `src-tauri/src/lib.rs`:

- Add `mod connectors;` near the top (alphabetical with `mod claude;`).
- Add `.manage(connectors::ConnectorsState::new())` in the `builder.<...>.manage(...)` chain.
- Add the three commands to the `tauri::generate_handler![...]` list.

- [ ] **Step 5: Add a Rust unit test**

In `src-tauri/src/connectors/state.rs`, append:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::types::AdapterRegistration;

    #[test]
    fn registers_and_unregisters() {
        let s = ConnectorsState::new();
        s.inner.lock().registered_adapters.insert(
            "a".into(),
            AdapterRegistration {
                adapter_id: "a".into(),
                adapter_type: "telegram".into(),
                webhook_path: None,
            },
        );
        assert_eq!(s.inner.lock().registered_adapters.len(), 1);
        s.inner.lock().registered_adapters.remove("a");
        assert_eq!(s.inner.lock().registered_adapters.len(), 0);
    }
}
```

- [ ] **Step 6: Run cargo build + test**

```powershell
cd src-tauri
rtk cargo test -p app_lib connectors::
cd ..
```

Expected: 1 test passing.

- [ ] **Step 7: TS-side typed wrappers**

```ts
// lib/connectors/tauri/commands.ts
import { invoke } from "@tauri-apps/api/core"

export interface AdapterRegistration {
  adapterId: string
  adapterType: string
  webhookPath?: string
}

export interface ConnectorsHealth {
  serverRunning: boolean
  boundAddr: string | null
  registeredAdapterCount: number
}

export async function connectorsRegisterAdapter(reg: AdapterRegistration): Promise<void> {
  await invoke("connectors_register_adapter", { reg })
}

export async function connectorsUnregisterAdapter(adapterId: string): Promise<void> {
  await invoke("connectors_unregister_adapter", { adapterId })
}

export async function connectorsHealth(): Promise<ConnectorsHealth> {
  return invoke<ConnectorsHealth>("connectors_health")
}
```

with co-located test that mocks `@tauri-apps/api/core` and asserts the round-trip.

- [ ] **Step 8: Commit**

```powershell
rtk git add src-tauri/src/connectors src-tauri/src/lib.rs src-tauri/Cargo.toml lib/connectors/tauri
rtk git commit -m "feat(connectors): scaffold Rust connectors module + TS Tauri wrappers"
```

---

## Task 20: Rust axum server lifecycle

**Files:**

- Create: `src-tauri/src/connectors/axum_app.rs`
- Create: `src-tauri/src/connectors/server_lifecycle.rs`
- Modify: `src-tauri/src/connectors/mod.rs`, `commands.rs`
- Test: in-file `#[cfg(test)] mod tests`

Pattern source: `src-tauri/src/remote_control/server.rs`. Read end-to-end before writing the connector equivalent. We're building a **second** axum server distinct from remote_control's loopback-only one, but the shutdown / state / route-mount pattern is identical.

- [ ] **Step 1: Implement `axum_app.rs`**

```rust
// src-tauri/src/connectors/axum_app.rs
use std::sync::Arc;
use axum::{
    body::Body,
    http::{Request, StatusCode},
    response::Response,
    routing::{get, post, any},
    Router,
};

use super::state::ConnectorsState;

/// Build the connectors axum app. Routes:
///   GET  /health          → 200 {"ok": true}
///   POST /webhook/<type>/<adapterId>   → adapter-specific handler (registered later)
///   *  /ws/onebot/<adapterId>          → reverse-WS upgrade (registered later)
pub fn build_router(state: ConnectorsState) -> Router {
    Router::new()
        .route("/health", get(health_handler))
        // POST /webhook/<type>/<adapterId> — Phase 1 will register adapter-specific
        // sub-routers via `Router::nest`. For now, return 501 so the server can boot.
        .route(
            "/webhook/:adapter_type/:adapter_id",
            any(unimplemented_webhook_handler),
        )
        .with_state(state)
}

async fn health_handler() -> &'static str {
    r#"{"ok":true}"#
}

async fn unimplemented_webhook_handler() -> Response {
    Response::builder()
        .status(StatusCode::NOT_IMPLEMENTED)
        .body(Body::from(r#"{"error":"adapter route not registered"}"#))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use tower::util::ServiceExt;

    #[tokio::test]
    async fn health_returns_ok() {
        let app = build_router(ConnectorsState::new());
        let resp = app
            .oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = to_bytes(resp.into_body(), 1024).await.unwrap();
        assert_eq!(&body[..], b"{\"ok\":true}");
    }

    #[tokio::test]
    async fn unregistered_webhook_returns_501() {
        let app = build_router(ConnectorsState::new());
        let resp = app
            .oneshot(Request::builder().uri("/webhook/telegram/x").method("POST").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_IMPLEMENTED);
    }
}
```

- [ ] **Step 2: Implement `server_lifecycle.rs`**

```rust
// src-tauri/src/connectors/server_lifecycle.rs
use std::net::SocketAddr;
use tokio::net::TcpListener;
use tokio::sync::watch;

use super::axum_app::build_router;
use super::state::ConnectorsState;

pub struct ServerHandle {
    pub bound_addr: SocketAddr,
    shutdown_tx: watch::Sender<bool>,
}

impl ServerHandle {
    pub async fn shutdown(self) {
        let _ = self.shutdown_tx.send(true);
    }
}

pub async fn start_server(
    state: ConnectorsState,
    bind_addr: SocketAddr,
) -> Result<ServerHandle, String> {
    let listener = TcpListener::bind(bind_addr)
        .await
        .map_err(|e| format!("connectors bind failed: {e}"))?;
    let bound = listener.local_addr().map_err(|e| e.to_string())?;
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let app = build_router(state.clone());
    {
        let mut inner = state.inner.lock();
        inner.server_running = true;
        inner.bound_addr = Some(bound.to_string());
    }
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                while shutdown_rx.changed().await.is_ok() {
                    if *shutdown_rx.borrow() {
                        break;
                    }
                }
            })
            .await;
    });
    Ok(ServerHandle { bound_addr: bound, shutdown_tx })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    #[tokio::test]
    async fn server_starts_and_shuts_down_cleanly() {
        let state = ConnectorsState::new();
        let handle = start_server(state.clone(), SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
            .unwrap();
        assert!(handle.bound_addr.port() > 0);
        assert!(state.inner.lock().server_running);
        handle.shutdown().await;
    }
}
```

- [ ] **Step 3: Add Tauri commands to start/stop**

In `commands.rs`, append:

```rust
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use super::server_lifecycle::{start_server, ServerHandle};
use tokio::sync::Mutex as AsyncMutex;
use std::sync::Arc;

// Lazy: store the live server handle in app state via a separate Tauri-managed wrapper.
// For Phase 1 we keep it inside the existing ConnectorsState; the lifecycle handle is
// behind an async mutex.
pub struct ConnectorsServer(pub Arc<AsyncMutex<Option<ServerHandle>>>);

#[tauri::command]
pub async fn connectors_start_server(
    state: State<'_, ConnectorsState>,
    server: State<'_, ConnectorsServer>,
    port: u16,
    bind_loopback_only: bool,
) -> Result<String, String> {
    let mut handle_lock = server.0.lock().await;
    if handle_lock.is_some() {
        return Err("connectors server already running".into());
    }
    let ip = if bind_loopback_only {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    } else {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    };
    let handle = start_server(state.inner_state(), SocketAddr::new(ip, port)).await?;
    let bound = handle.bound_addr.to_string();
    *handle_lock = Some(handle);
    Ok(bound)
}

#[tauri::command]
pub async fn connectors_stop_server(
    state: State<'_, ConnectorsState>,
    server: State<'_, ConnectorsServer>,
) -> Result<(), String> {
    let mut handle_lock = server.0.lock().await;
    if let Some(h) = handle_lock.take() {
        h.shutdown().await;
    }
    state.inner.lock().server_running = false;
    state.inner.lock().bound_addr = None;
    Ok(())
}
```

…and add a small helper on `ConnectorsState`:

```rust
// state.rs (append to impl ConnectorsState)
    pub fn inner_state(&self) -> Self {
        self.clone()
    }
```

- [ ] **Step 4: Wire into lib.rs**

```rust
.manage(connectors::commands::ConnectorsServer(Arc::new(tokio::sync::Mutex::new(None))))
```

…and append the two new commands to `tauri::generate_handler![]`.

- [ ] **Step 5: Run cargo test**

```powershell
cd src-tauri && rtk cargo test -p app_lib connectors:: && cd ..
```

Expected: 3 tests passing (health, unimplemented webhook, lifecycle).

- [ ] **Step 6: Commit**

```powershell
rtk git commit -am "feat(connectors): add axum server lifecycle with health route"
```

---

## Task 21: Rust keyring helpers

Pattern source: `src-tauri/src/remote_control/keyring.rs`.

**Files:**

- Create: `src-tauri/src/connectors/keyring.rs`
- Modify: `src-tauri/src/connectors/mod.rs`, `commands.rs`
- Test: in-file

- [ ] **Step 1**: Copy the pattern from `remote_control/keyring.rs` literally — same `keyring::Entry::new` calls, but service `"com.cognia.platforms"` and account names of the form `"<adapterId>:<credentialName>"`.

- [ ] **Step 2**: Expose four Tauri commands `connectors_keyring_set / get / delete / list`. The list call enumerates accounts from the in-memory `AdapterInstanceRow.credentialsRef.accounts` (passed in from TS), since OS keyrings don't reliably enumerate.

- [ ] **Step 3**: Unit test using a fake keyring backend (the `keyring` crate provides `keyring::mock` for tests).

- [ ] **Step 4**: Commit `feat(connectors): add platform-credential keyring helpers`.

---

## Task 22: Rust outbound HTTP client

**Files:**

- Create: `src-tauri/src/connectors/http_client.rs`
- Modify: `src-tauri/src/connectors/commands.rs`

Wraps `reqwest::Client` with timeout (30s default), per-host token-bucket rate limit (config from TS), and structured logging. Exposes `connectors_http_request(req: TauriHttpRequest) -> TauriHttpResponse`.

- [ ] Follow Task-19 template: failing test → impl → pass → commit. Write a test using `wiremock` (already a transitive of reqwest's test ecosystem; if not available, add as dev-dep).

---

## Task 23: Rust WebSocket client + reverse-WS server

**Files:**

- Create: `src-tauri/src/connectors/ws_client.rs`
- Create: `src-tauri/src/connectors/ws_server.rs`

`ws_client.rs` wraps `tokio_tungstenite::connect_async` and emits `connectors://ws/<id>/{open,message,close,error}` Tauri events the TS adapter consumes.

`ws_server.rs` handles axum WebSocket upgrade for OneBot reverse-WS at `/ws/onebot/:adapterId` with `Authorization: Bearer <token>` validation.

- [ ] Failing test for ws_client (mock server via `tokio-tungstenite::accept_async`); failing test for ws_server (axum oneshot to upgrade endpoint).

- [ ] Commit `feat(connectors): add WS client/server with bearer auth`.

---

## Task 24: Rust attachment cache

**Files:**

- Create: `src-tauri/src/connectors/attachments.rs`

AES-GCM encrypted on-disk cache under `<appData>/cognia/connectors/cache/`. Key derivation matches `lib/data/types.ts` `EncryptedEnvelopeV1` (PBKDF2-SHA256, 600 000 iters); the master passphrase is fetched from keyring `com.cognia.platforms` account `attachment-master-key` (auto-generated on first call if missing).

Exposes `connectors_attachment_fetch(adapter_id: String, remote_ref: String, source_url: String) -> AttachmentRef`. The function:

1. Hashes `(adapter_id, remote_ref)` for cache key.
2. If cache hit and not expired, return.
3. Else fetch source_url via reqwest, encrypt, write to disk, upsert Dexie row via TS callback, return.

- [ ] Failing test using `tempfile::TempDir` + a local HTTP fixture.

- [ ] Commit `feat(connectors): encrypted attachment cache`.

---

## Task 25: TS Connector Bus skeleton

**Files:**

- Create: `lib/connectors/bus.ts`
- Test: `lib/connectors/bus.test.ts`

Singleton with two queues (inbound, outbound), an `AdapterRegistry`, and a fan-in/fan-out loop. No reliability primitives yet (added in Tasks 26-28); just route inbound events to a stubbed handler and outbound jobs to the registered adapter.

- [ ] **Step 1**: Failing test asserting that:
  - `bus.registerAdapter(adapter)` adds it to the registry.
  - `bus.dispatchInbound(event)` invokes the `onInbound` handler.
  - `bus.enqueueOutbound(job)` calls the registered adapter's `send(req)`.

- [ ] **Step 2-5**: standard implement → run → commit cycle.

```ts
// lib/connectors/bus.ts
import type {
  NormalizedInboundEvent,
  PlatformAdapter,
  OutboundRequest,
  OutboundResult,
} from "@/types/connectors"

export interface BusInboundHandler {
  (event: NormalizedInboundEvent): Promise<void>
}

class ConnectorBus {
  private adapters = new Map<string, PlatformAdapter>()
  private inboundHandler: BusInboundHandler | null = null

  registerAdapter(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  unregisterAdapter(adapterId: string): void {
    this.adapters.delete(adapterId)
  }

  setInboundHandler(handler: BusInboundHandler): void {
    this.inboundHandler = handler
  }

  async dispatchInbound(event: NormalizedInboundEvent): Promise<void> {
    if (!this.inboundHandler) throw new Error("ConnectorBus: inbound handler not set")
    await this.inboundHandler(event)
  }

  async sendOutbound(adapterId: string, req: OutboundRequest): Promise<OutboundResult> {
    const a = this.adapters.get(adapterId)
    if (!a) {
      return {
        ok: false,
        error: { code: "adapter_not_found", message: adapterId, retryable: false },
      }
    }
    return a.send(req)
  }

  listAdapters(): PlatformAdapter[] {
    return Array.from(this.adapters.values())
  }
}

let _bus: ConnectorBus | null = null

export function getBus(): ConnectorBus {
  if (!_bus) _bus = new ConnectorBus()
  return _bus
}

/** Test-only reset. */
export function __resetBusForTesting(): void {
  _bus = null
}
```

- [ ] Commit `feat(connectors): add ConnectorBus singleton`.

---

## Task 26: Trigger policy evaluator

**Files:**

- Create: `lib/connectors/policy-eval.ts`
- Test: `lib/connectors/policy-eval.test.ts`

Pure function `evaluatePolicy(policy, event, recentBotReplyAt) → { matched: boolean, blocked: boolean, reason?: string }`. Cover every rule kind and every blocker kind (private-default, self-mention, reply-to-bot, slash-command, keyword, allow/blocklists, rate-limit — using a ring buffer of recent timestamps stored on the bus, cooldown-after-bot-reply).

- [ ] Test cases (one `describe` block per rule kind, matching the union):
  - **rules**: private-default fires when `event.channel.kind === "private"`; self-mention requires `event.mentions.selfMentioned`; reply-to-bot requires `event.replyTo?.messageId === event.selfId` (or platform-specific equivalent — adapter resolves before emit); slash-command requires `event.plainText` to start with one of the prefixes; keyword does case-(in)sensitive substring; user/channel allowlists by id.
  - **blockers**: blocklists, rate-limit (use injected clock for determinism), cooldown.

Implement just enough to make every case green. Keep evaluator stateless except for an injected `state: { recentBotReplyAtByConversation, recentByUserAndChannel }` parameter.

- [ ] Commit `feat(connectors): trigger policy evaluator`.

---

## Task 27: Three-layer policy + mode + character resolver

**Files:**

- Create: `lib/connectors/policy-resolve.ts`
- Test: `lib/connectors/policy-resolve.test.ts`

Function `resolveBinding(adapter, character, override) → { mode, characterId, trigger }`. Trigger merge is deep — array fields (rules, blockers) replace, scalar `storeUnmatchedInDraftMode` follows the highest layer that defines it.

- [ ] Tests covering the override matrix from spec §6.2.

- [ ] Commit `feat(connectors): three-layer binding resolver`.

---

## Task 28: Mode router + dedup + audit

**Files:**

- Create: `lib/connectors/mode-router.ts`, `dedup.ts`, `audit.ts`
- Wire into bus: modify `lib/connectors/bus.ts`
- Tests: `*.test.ts` for each

`mode-router.ts` exports `routeInbound(event, resolved) → "ai-run" | "manual-store" | "draft-prepare" | "store-only" | "drop"`, given the resolved policy + mode and policy evaluation result.

`dedup.ts` exports `recordAndCheckInbound(adapterId, msgId)` returning false if duplicate (delegates to `lib/db/inbound-ledger.ts`).

`audit.ts` exports `appendAudit(entry)` (delegates to `lib/db/connector-audit.ts` + caps at 5000).

The bus `dispatchInbound` now:

1. Calls `recordAndCheckInbound`; if dup → audit `inbound.deduped`, return.
2. Resolves policy/mode/character.
3. Evaluates policy; if blocked → audit `inbound.policy_blocked`, drop (or store if draft-mode + storeUnmatched).
4. Calls `routeInbound`; dispatches to the appropriate handler (Task 29 wires AI-run; manual-store inserts into ChatSession; draft-prepare runs AI silently and writes to drafts).

- [ ] Add an end-to-end bus test that drives a fake adapter through every mode × every router branch, asserting the right Dexie rows + audit entries materialise.

- [ ] Commit `feat(connectors): wire bus through dedup/policy/mode router with audit trail`.

---

# 🔍 Checkpoint A — Foundation

**Stop here. Verify:**

```powershell
rtk pnpm exec jest types/connectors lib/connectors lib/db
rtk pnpm typecheck
rtk pnpm lint
cd src-tauri && rtk cargo test -p app_lib && cd ..
```

All green. Bus operates end-to-end with a fake adapter; no real network yet.

**Request human review** before starting CP-B.

---

# CP-B — Telegram lit up

## Task 29: Telegram parse — inbound updates → NormalizedInboundEvent

**Files:**

- Create: `lib/connectors/adapters/telegram/parse.ts`
- Create: `lib/connectors/adapters/telegram/fixtures/private-message.json` (real-shape Telegram update, with bot id, chat, message)
- Create: `lib/connectors/adapters/telegram/fixtures/group-mention.json`
- Create: `lib/connectors/adapters/telegram/fixtures/reply-to-bot.json`
- Create: `lib/connectors/adapters/telegram/fixtures/photo-with-caption.json`
- Test: `parse.test.ts`

Inputs: `(adapterId, selfId, update)` where update is one element of `getUpdates`'s `result[]`. Produces `NormalizedInboundEvent`. Cover: text, photo, document, voice, sticker, reply, mention (text and entity-based), inline-bot edit, supergroup forum thread (`message_thread_id`).

- [ ] Failing tests = one `it()` per fixture + edge case (channel post, edited_message, callback_query → not phase-1, parse returns `null` and a TODO note).

- [ ] Implement parser. ~150 LOC.

- [ ] Commit `feat(connectors/telegram): parser with golden fixture coverage`.

---

## Task 30: Telegram serialize — OutboundRequest → sendMessage payload

**Files:**

- Create: `lib/connectors/adapters/telegram/serialize.ts`
- Create: `lib/connectors/adapters/telegram/markdown-v2.ts`
- Tests: same names + `.test.ts`

`markdown-v2.ts` exports `escapeMdV2(text: string)` — the byte-for-byte escaper from the official Bot API docs (escape `_*[]()~` ` `>#+-=|{}.!`). Test with the canonical 14-char escape table.

`serialize.ts` walks segments, building either:

- `sendMessage` for text/markdown
- `sendPhoto` / `sendDocument` / `sendVoice` etc. for media
- Multi-call for mixed-segment messages (cognia-next sends as a sequence, threading via `reply_to_message_id`)

Honors `replyTo` and `threadId` (Telegram supergroup forum topics).

- [ ] Tests: one per segment type + one for "text + image" sequence.

- [ ] Commit `feat(connectors/telegram): outbound serialiser with MarkdownV2 escaping`.

---

## Task 31: Telegram capability flags

**Files:**

- Create: `lib/connectors/adapters/telegram/capability.ts`
- Test: `capability.test.ts`

Exports a const `TELEGRAM_CAPS: readonly Capability[]` enumerating every flag the parser/serialiser supports. Test asserts the constant is sorted (for stable diff) and includes the Phase-1 ship-set.

- [ ] Commit `feat(connectors/telegram): declare capability flags`.

---

## Task 32: Telegram long-poll transport

**Files:**

- Create: `lib/connectors/adapters/telegram/transport-longpoll.ts`
- Test: `transport-longpoll.test.ts`

`startLongPoll(ctx, opts) → AsyncIterable<TelegramUpdate>` calling `connectors_http_request` from Rust. Honors `ctx.signal`. Tracks `offset` cursor for getUpdates. Backs off on transient errors.

- [ ] Test: mock Tauri command, drive 3 polls (one with updates, one empty, one error), assert offset advances + retry behavior.

- [ ] Commit `feat(connectors/telegram): long-poll transport`.

---

## Task 33: Telegram webhook transport (TS half)

**Files:**

- Create: `lib/connectors/adapters/telegram/transport-webhook.ts`
- Test: `transport-webhook.test.ts`

When the user opts into webhook mode, this module:

1. Calls `connectors_bind_webhook_route(adapterId, "/webhook/telegram/<adapterId>")` so Rust routes that path to a TS subscriber.
2. Subscribes to the `connectors://webhook/<adapterId>` Tauri event stream.
3. Emits each event into the bus via `ctx.emit(parse(update))`.

- [ ] Test mocks the bind command and the event channel, drives a payload through, asserts an event surfaces.

- [ ] Commit `feat(connectors/telegram): webhook transport (TS subscriber)`.

---

## Task 34: Rust Telegram webhook signature verification

**Files:**

- Create: `src-tauri/src/connectors/sigverify/mod.rs` + `telegram.rs`

`telegram.rs::verify_secret_token(req_headers, expected_token)`. Header `X-Telegram-Bot-Api-Secret-Token` constant-time compared against expected. Returns `Result<(), SigError>`.

- [ ] In-file test with reference vector.

- [ ] Commit `feat(connectors/telegram): webhook signature verification (Rust)`.

---

## Task 35: Telegram adapter assembly

**Files:**

- Create: `lib/connectors/adapters/telegram/index.ts`
- Test: `index.test.ts`

`createTelegramAdapter(opts: { id, displayName, transport: "longpoll" | "webhook", botToken: () => Promise<string> })` returns a `PlatformAdapter`. Implements `start`, `stop`, `health`, `send`, `edit`, `delete`, `setTyping`, `uploadFile`, `fetchHistory`, `refreshCredentials`. Each delegates to the parse/serialize/transport modules from prior tasks.

- [ ] Test: build with mocked `botToken` resolver and a stubbed `AdapterContext`; drive a fake `getUpdates` response; assert parsed events emit; call `send` and assert the right HTTP request.

- [ ] Commit `feat(connectors/telegram): adapter assembly`.

---

## Task 36: Telegram contract test suite

**Files:**

- Create: `lib/connectors/adapters/telegram/contract.test.ts`

Generic contract suite that takes any `PlatformAdapter` and exercises every advertised capability flag. Imports the Telegram adapter and runs through:

- Send text → asserts MessageRow + outboundJob row + audit entry.
- Send markdown with special chars → asserts MarkdownV2 escape applied.
- Send image → asserts sendPhoto call.
- Send reply → asserts `reply_to_message_id`.
- Edit → asserts editMessageText.
- Delete → asserts deleteMessage.
- Typing → asserts sendChatAction.
- Reaction (if declared) → setMessageReaction.
- History fetch → drives the iterator through 2 batches.

This suite is the template for all 4 remaining adapters; design it generically (parameterised on adapter factory + fixture set).

- [ ] Run, expect all green for Telegram.

- [ ] Commit `test(connectors/telegram): contract suite green`.

---

## Task 37: Hook Telegram into bus runtime + AI run

**Files:**

- Create: `lib/connectors/runtime.ts`
- Test: `runtime.test.ts`

`installRuntime(bus, sendPrompt)` sets the bus inbound handler. The handler:

1. Checks dedup (ledger).
2. Resolves binding via `policy-resolve.ts`.
3. Looks up / creates the ChatSession for this `conversationKey` (with `platformBinding`).
4. Inserts the inbound `StoredMessage` into Dexie via `lib/db/messages.ts`.
5. Evaluates policy.
6. Branches by mode:
   - **auto** + matched → call `sendPrompt(sessionId, content, options)` (the existing function in `lib/claude/ipc.ts`); on result, enqueue `OutboundJob` per assistant message.
   - **manual** → toast + raise unread; no further work.
   - **draft** + matched → run AI in a "ghost" mode (still call `sendPrompt`, but capture output to `connectorDrafts` instead of inserting an assistant message; toast "Draft ready").
   - **draft** + unmatched + `storeUnmatchedInDraftMode` → only insert inbound, no draft.

- [ ] Test exercises every branch with a fake `sendPrompt` mock.

- [ ] Commit `feat(connectors): bus runtime that drives sendPrompt`.

---

## Task 38: Outbound runner — backoff + circuit breaker + idempotency

**Files:**

- Create: `lib/connectors/outbound-runner.ts`, `circuit-breaker.ts`, `rate-limit.ts`
- Tests for each

The outbound runner pulls due `OutboundJob`s from `lib/db/outbound-jobs.ts`, picks the FIFO lane per conversationKey, calls the adapter's `send`, and:

- On success → mark sent, audit `delivery.success`.
- On retryable error → exponential backoff (`min(60_000, 1000 * 2^attempts) + jitter(0..500)`), reschedule; cap at 5 → deadletter + audit.
- On non-retryable error → deadletter immediately.
- Circuit breaker: per adapter sliding-window 30s; ≥5 events with ≥50% failures → open 30s; half-open after; close on 3 successes. While open, fail fast with `circuit_open`.
- Rate limit: per adapter+conversation token bucket. Defaults from spec §9.6.

- [ ] Tests: drive synthetic schedules with a fake clock (`jest.useFakeTimers()`); assert backoff timing, circuit transitions, rate-limit refill, dead-letter semantics, idempotency (same key → reuse stored result, no double send).

- [ ] Commit `feat(connectors): reliability primitives — backoff/breaker/rate-limit/idempotency`.

---

## Task 39: Per-conversation FIFO lane

**Files:**

- Modify: `lib/connectors/outbound-queue.ts` (add lane orchestration)
- Test: extend `outbound-queue.test.ts`

`Map<conversationKey, Promise<void>>` chains. Send N jobs to 2 conversations interleaved; assert per-conversation order is preserved while overall throughput parallelises.

- [ ] Commit `feat(connectors): per-conversation FIFO outbound lanes`.

---

## Task 40: Manual-mode end-to-end

**Files:**

- Modify: `components/chat/composer.tsx`
- Test: `components/chat/composer.platform-binding.test.tsx`

When the active session has `platformBinding`:

- If mode === "manual": composer's "Send" button bypasses `sendPrompt` and instead enqueues an outbound job whose segments are the composer text. The user message is also stored in Dexie (so it shows in the chat).
- If mode === "draft": composer button reads "Edit draft" when a pending draft exists; clicking opens the draft editor (Task 49 builds the dialog).
- If mode === "auto": existing behavior (call `sendPrompt`).

- [ ] RTL test asserts the three branches via fake-indexeddb sessions with platformBinding set.

- [ ] Commit `feat(connectors): composer respects auto/manual/draft for platform sessions`.

---

## Task 41: ConnectorBusProvider

**Files:**

- Create: `components/connectors/connector-bus-provider.tsx`
- Modify: `app/layout.tsx`
- Test: `connector-bus-provider.test.tsx`

Mounts the bus on app boot in Tauri mode:

1. Hydrates Zustand `useConnectorsStore` from Dexie (adapter list + drafts + recent audit).
2. For every enabled `AdapterInstance`, calls `bus.registerAdapter(createAdapterFromRow(row))`.
3. Wires `installRuntime(bus, sendPrompt)` from `lib/connectors/runtime.ts`.
4. Starts the connectors axum server (defaults to loopback 47822 for OneBot; the public-port toggle lives per-adapter).
5. Subscribes to `connectors://event/inbound/<adapterId>` Tauri events to receive parsed events from Rust transports.
6. Stops + unregisters everything on unmount.

In web mode the provider mounts a no-op stub that just hydrates Dexie reads.

- [ ] Test the Tauri-mode boot path with mocks; the no-op web path with `(isTauri as jest.Mock).mockReturnValue(false)`.

- [ ] Commit `feat(connectors): boot provider`.

---

## Task 42: ConnectorDeepLinkRouter

**Files:**

- Create: `components/connectors/connector-deep-link-router.tsx`
- Modify: `app/layout.tsx`
- Test: same

Subscribes to `deep-link://received` Tauri events. When URL matches `cognia://connector/oauth/<adapterType>?code=…&state=…`:

1. Validates `state` against the session-storage value the OAuth start screen wrote.
2. Calls the right adapter's exchange-code function.
3. Stores tokens in keyring; flips `AdapterInstance.enabled = true`; toasts success.

- [ ] Tests with a fake deep-link emitter.

- [ ] Commit `feat(connectors): OAuth deep-link router`.

---

## Task 43: Connections settings tab — overview + adapters list

**Files:**

- Create: `components/settings/connections/connections-section.tsx`
- Create: `components/settings/connections/tabs/overview-tab.tsx`
- Create: `components/settings/connections/tabs/adapters-tab.tsx`
- Modify: `components/settings/settings-nav-config.ts` (add `connections` to `extensions` group)
- Modify: `components/settings/settings-shell.tsx` (case)
- Tests for each

Pattern source: `components/settings/remote-control/remote-control-section.tsx` — copy the tabbed shell with `?connectionsTab=` URL hydration.

Tabs in this initial pass:

- **Overview** — server status badge, bound URL, registered adapter count, audit summary.
- **Adapters** — list of `AdapterInstance` rows + "Add adapter" dropdown (Telegram + Discord + Slack + Lark + OneBot stubs); per-row enable/disable toggle + mode chip + bot-token reveal/copy.

Other tabs (Conversations / Inbox / Outbound / Audit) come in Task 51 after the Inbox UI is done.

- [ ] Tests: navigate to settings, switch tabs, mock useLiveQuery to assert the adapter list.

- [ ] Commit `feat(connectors): Connections settings section (overview + adapters)`.

---

## Task 44: Telegram adapter form

**Files:**

- Create: `components/settings/connections/forms/adapter-form.tsx` (generic JSON-Schema-driven form)
- Create: `components/settings/connections/forms/telegram-config.tsx` (extra Telegram quick-helpers: webhook vs longpoll switcher; "Test bot token" button calls `getMe` via Rust HTTP client)
- Tests for each

- [ ] Test: render form with the Telegram configSchema; assert Save calls `createAdapterInstance` + `connectors_keyring_set`.

- [ ] Commit `feat(connectors): generic adapter form + Telegram quick-config`.

---

## Task 45: Audit + Outbound tabs

**Files:**

- Create: `components/settings/connections/tabs/audit-tab.tsx`, `outbound-tab.tsx`
- Tests

Audit: virtualised list of `connectorAudit` rows with kind/adapter filter chips, time-range picker, redaction reminder banner.

Outbound: live `outboundQueue` view — pending / sending / sent / failed / deadlettered, click-to-retry, click-to-cancel.

- [ ] Tests using mocked `useLiveQuery`.

- [ ] Commit `feat(connectors): audit + outbound settings tabs`.

---

## Task 46: Manual ship test — real Telegram bot

**Files:**

- Create: `docs/content/docs/connectors/telegram-setup.md` (Phase 1 docs)

- [ ] **Step 1**: Create a real Telegram bot via @BotFather (developer doing this manually).
- [ ] **Step 2**: Open cognia-next desktop, Settings → Connections → Add adapter → Telegram → paste bot token → enable.
- [ ] **Step 3**: From a real Telegram client, DM the bot.
- [ ] **Step 4**: Verify a ChatSession appears in `/inbox/c/<conversationKey>` (or in the chat sidebar pre-Inbox UI).
- [ ] **Step 5**: Verify auto reply in the Telegram client matches the AI output.
- [ ] **Step 6**: Switch mode to manual → DM again → verify no auto reply, manual send works.
- [ ] **Step 7**: Switch mode to draft → DM again → verify draft toast → approve → reply lands.

- [ ] Commit `docs(connectors): Telegram setup guide` once the doc reflects what you actually did.

---

# 🔍 Checkpoint B — Telegram lit up

**Stop. Verify:**

```powershell
rtk pnpm exec jest lib/connectors lib/db components/settings/connections components/connectors components/chat
rtk pnpm typecheck && rtk pnpm lint
cd src-tauri && rtk cargo test -p app_lib && cd ..
```

All green. Manual ship test pass. **Request human review.**

---

# CP-C — Inbox UI

## Tasks 47–58: Inbox shell + routes + per-conversation features

Files locked-in in §"File structure" above. For each task:

- [ ] **Task 47**: `app/inbox/layout.tsx` + `app/inbox/page.tsx` (redirect to /inbox/all). Test: smoke-render + redirect assertion.
- [ ] **Task 48**: `components/inbox/inbox-shell.tsx` — three-pane layout (sidebar / list / detail). Test: RTL render with mocked Dexie.
- [ ] **Task 49**: `components/inbox/inbox-sidebar.tsx` — three view modes (by adapter / by platform / unified). Test: filter switch.
- [ ] **Task 50**: `components/inbox/conversation-list.tsx` — virtualised, sorted unread-first then pinned then by time. Test: ordering.
- [ ] **Task 51**: `components/inbox/conversation-header.tsx` + `mode-switcher.tsx` + `policy-info.tsx`. Test: mode change writes `conversationOverrides` row + cancels in-flight via `claude_interrupt`.
- [ ] **Task 52**: `components/inbox/draft-banner.tsx` + `draft-editor.tsx`. Test: edit/approve/reject lifecycle.
- [ ] **Task 53**: `components/inbox/outbound-status-pill.tsx`. Test: status mapping.
- [ ] **Task 54**: `components/inbox/platform-badge.tsx` + `unread-pill.tsx`. Test: visual variants per platform.
- [ ] **Task 55**: `components/connectors/identity-merge-dialog.tsx`. Test: drag-and-drop two identities → merge writes the merge with `mergedFromIds`.
- [ ] **Task 56**: `app/inbox/c/[conversationKey]/page.tsx` — opens the underlying ChatSession with platform-aware header. Test: routing.
- [ ] **Task 57**: `app/inbox/adapter/[adapterId]/page.tsx` + `app/inbox/platform/[kind]/page.tsx`. Test: filter scoping.
- [ ] **Task 58**: Add `Conversations` and `Inbox` settings tabs (same `connections-section.tsx` shell). Inbox tab is read-only summary; Conversations tab manages overrides (mode, character, archive, pin, trigger overrides).

Each task: failing test → impl → pass → commit.

---

# 🔍 Checkpoint C — Inbox UI

**Stop. Verify:**

```powershell
rtk pnpm exec jest app/inbox components/inbox components/settings/connections
rtk pnpm typecheck && rtk pnpm lint
rtk pnpm build  # static export still works
```

Manual: navigate Inbox three ways; flip a conversation between auto/manual/draft via the header switcher; merge two identities. **Request human review.**

---

# CP-D — Discord adapter

Mirror Tasks 29–36 with Discord-specific deltas:

- [ ] **Task 59**: `parse.ts` — Discord Gateway dispatch event `MESSAGE_CREATE`. Fixtures: DM, guild text, thread, with mentions / replies / embeds / attachments.
- [ ] **Task 60**: `serialize.ts` — message create / edit / reply / thread / typing-indicator. Discord markdown is closer to plain Markdown than Telegram's; minimal escape.
- [ ] **Task 61**: `gateway-client.ts` — Discord gateway wss connect (Identify, Resume, Heartbeat at received `heartbeat_interval`, Ready cache). Drive via `connectors_open_ws` Rust command. Reconnect on Code 4014/4007 with exponential backoff.
- [ ] **Task 62**: `capability.ts` — declare flags (Discord supports replies, mentions, threads, edits, deletes, typing, reactions, embed cards but not native voice messages).
- [ ] **Task 63**: `sigverify/discord.rs` — Ed25519 verification for interactions endpoint (`X-Signature-Ed25519` + `X-Signature-Timestamp`). Public key per-bot in keyring.
- [ ] **Task 64**: `index.ts` — adapter assembly.
- [ ] **Task 65**: `discord-config.tsx` — settings form (bot token + public key + intents toggle).
- [ ] **Task 66**: `contract.test.ts` — pass the generic suite for Discord.
- [ ] **Task 67**: Manual ship test — real Discord bot in a real guild, DM and `@bot` exchange.
- [ ] **Task 68**: `docs/content/docs/connectors/discord-setup.md`.

# 🔍 Checkpoint D — Discord

**Stop. Verify** (pattern as before). **Request human review.**

---

# CP-E — Slack adapter

Deltas:

- [ ] **Task 69**: `parse.ts` — Slack Events API `event_callback` envelopes; threaded messages (`thread_ts`).
- [ ] **Task 70**: `block-kit.ts` — Block Kit serialiser for cards. Markdown via `mrkdwn`.
- [ ] **Task 71**: `serialize.ts` — `chat.postMessage` / `chat.update` / `chat.delete` / `reactions.add` / `assistant.threads.setStatus` (typing).
- [ ] **Task 72**: `transport-socket-mode.ts` — Socket Mode WS via `apps.connections.open` then connect; falls back to webhook if user opts out.
- [ ] **Task 73**: `capability.ts`.
- [ ] **Task 74**: `sigverify/slack.rs` — `v0:<ts>:<body>` HMAC-SHA256 with signing secret; reject if `|now - ts| > 5 minutes`.
- [ ] **Task 75**: OAuth start helper — `https://slack.com/oauth/v2/authorize?…&redirect_uri=cognia://connector/oauth/slack&state=…`.
- [ ] **Task 76**: `index.ts`.
- [ ] **Task 77**: `slack-config.tsx` — OAuth button + manual signing-secret entry + Socket Mode toggle.
- [ ] **Task 78**: `contract.test.ts`.
- [ ] **Task 79**: Manual ship test — real Slack workspace.
- [ ] **Task 80**: `docs/content/docs/connectors/slack-setup.md`.

# 🔍 Checkpoint E — Slack

**Stop / verify / review.**

---

# CP-F — Lark / Feishu adapter

Deltas:

- [ ] **Task 81**: `parse.ts` — Lark event-subscription envelope (`event` payload + `header.event_type` discriminator). Handle `message.receive_v1`, `message.message_read_v1`, etc.
- [ ] **Task 82**: `card.ts` — Lark card serialiser (im_v1 + cards 2.0); plain markdown via `text` message_type.
- [ ] **Task 83**: `serialize.ts` — `im/v1/messages` POST; reply via `reply_in_thread`; reactions via `im/v1/messages/:id/reactions`.
- [ ] **Task 84**: `transport-webhook.ts` — handles encrypt-decrypt + verification token. Lark also offers a long-connection (lark-event skill) — Phase 1 ships **webhook + long-connection optional** with longpoll being the simpler Phase-1 default to avoid tunnel.
- [ ] **Task 85**: `transport-long-conn.ts` — Lark WSS long connection client; reuse `lark-event` skill knowledge.
- [ ] **Task 86**: `capability.ts`.
- [ ] **Task 87**: `sigverify/lark.rs` — encrypt-key body decrypt + verification-token compare.
- [ ] **Task 88**: OAuth via app-store install; tenant-access-token caching with refresh.
- [ ] **Task 89**: `index.ts`.
- [ ] **Task 90**: `lark-config.tsx` — App ID / App Secret / encrypt-key / verification-token.
- [ ] **Task 91**: `contract.test.ts`.
- [ ] **Task 92**: Manual ship test — real Lark group with bot.
- [ ] **Task 93**: `docs/content/docs/connectors/lark-setup.md`.

# 🔍 Checkpoint F — Lark

**Stop / verify / review.**

---

# CP-G — OneBot (QQ ecosystem)

Deltas:

- [ ] **Task 94**: `segments.ts` — OneBot CQ-code & v12 segment ↔ MessageSegment mapping (text, image, at, reply, face, record, video, file).
- [ ] **Task 95**: `v11.ts` — v11 message event parser (`message_type: private | group`, `sub_type`, `raw_message`, `message_id`).
- [ ] **Task 96**: `v12.ts` — v12 event parser (`detail_type`, `message[].type`).
- [ ] **Task 97**: `parse.ts` — auto-detects v11 vs v12 based on first event shape; selects parser.
- [ ] **Task 98**: `serialize.ts` — `send_private_msg` / `send_group_msg` + edit / delete / typing (no native typing; falls back to silent).
- [ ] **Task 99**: `transport-reverse-ws.rs` — Rust axum-side handles the `/ws/onebot/<adapterId>` upgrade with `Authorization: Bearer <token>` validation; emits `connectors://onebot/<adapterId>/{open,event,close}` events.
- [ ] **Task 100**: `transport-reverse-ws.ts` — TS side subscribes, parses, emits inbound events.
- [ ] **Task 101**: `capability.ts`.
- [ ] **Task 102**: `index.ts`.
- [ ] **Task 103**: `onebot-config.tsx` — bot UIN, optional bearer token, "expected client" hint (NapCat / Lagrange / LLOneBot).
- [ ] **Task 104**: `contract.test.ts`.
- [ ] **Task 105**: Manual ship test — NapCat connecting to cognia-next reverse-WS; QQ private + group messages.
- [ ] **Task 106**: `docs/content/docs/connectors/onebot-setup.md` — covers NapCat config + Lagrange config + LLOneBot config.
- [ ] **Task 107**: `docs/content/docs/connectors/qq-via-onebot-faq.md` — common gotchas (UIN vs OpenID, frames, etc.).

# 🔍 Checkpoint G — OneBot

**Stop / verify / review.**

---

# CP-H — Polish + Ship Gate

## Task 108: Proactive outbound via scheduler

**Files:**

- Modify: `lib/scheduler/event-integration.ts` (register `connection:outbound:send` + `connection:scheduled:digest`)
- Create: `lib/connectors/scheduled-outbound.ts`
- Test: same

Wires the existing scheduler so a cron task with payload `{ kind: "outbound", adapterId, conversationKey, segments }` enqueues an OutboundJob, and `{ kind: "scheduled-digest", adapterId, conversationKey, characterId, prompt }` runs the AI pipeline then enqueues the result.

- [ ] Tests + `feat(connectors): proactive outbound via scheduler`.

---

## Task 109: Quiet hours + global mute

**Files:**

- Modify: `lib/connectors/outbound-runner.ts` (consult `AdapterInstanceRow.quietHours` + `muted` before sending)
- Modify: settings forms to expose both
- Test: clock-driven test for quiet hours; on/off switch test for mute

- [ ] Commit.

---

## Task 110: Plugin extension API

**Files:**

- Modify: `types/plugin/plugin.ts` (`PluginCapability` += `"connectors"`, `PluginManifest.connectors`)
- Create: `lib/plugin/connectors-bridge.ts` — discovers manifest entries, calls `factory(ctx)` to build adapters, registers with bus.
- Test: plugin runtime test.
- Documentation in `docs/content/docs/connectors/extending-with-plugins.md` with a worked example.

- [ ] Commit `feat(connectors): plugin extension API`.

---

## Task 111: Web-mode degradation banners

**Files:**

- Modify: `components/settings/connections/connections-section.tsx` — add banner when `!isTauri()`.
- Modify: `components/inbox/conversation-header.tsx` — disable mode switcher in web mode.
- Modify: `components/chat/composer.tsx` — disable Send for platform-bound sessions in web mode.
- Tests for each: `(isTauri as jest.Mock).mockReturnValue(false)`.

- [ ] Commit `feat(connectors): web-mode read-only degradation`.

---

## Task 112: ADR-0008 documentation

**Files:**

- Create: `docs/content/docs/adr/0008-platform-connectors.md` — accepts the spec verbatim plus the implementation outcome notes (any deltas from the original spec).

- [ ] Commit `docs(connectors): ADR-0008`.

---

## Task 113: Playwright E2E with mock Telegram

**Files:**

- Create: `tests/e2e/connectors/telegram-mock-server.ts` (Express app implementing the subset of Bot API used)
- Create: `tests/e2e/connectors/telegram-bidirectional.spec.ts`

The E2E spec follows spec §15.3 step-by-step.

- [ ] Run via `rtk pnpm test:e2e -- connectors`.

- [ ] Commit `test(connectors): Playwright E2E with mock Telegram`.

---

## Task 114: CLAUDE.md update

**Files:**

- Modify: `D:\Project\cognia-next\CLAUDE.md` — add a Platform Connectors section mirroring the Twin / External Bridge sections, with reference to ADR-0008.

- [ ] Commit `docs: document Platform Connectors in CLAUDE.md`.

---

## Task 115: Coverage check + final lint/type/build pass

```powershell
rtk pnpm test:coverage
rtk pnpm typecheck
rtk pnpm lint
rtk pnpm build
cd src-tauri && rtk cargo test -p app_lib && rtk cargo clippy -- -D warnings && cd ..
```

Expected: all green; coverage ≥90% on every new file under `lib/connectors/`, `types/connectors/`, `stores/connectors/`.

- [ ] If anything fails: fix and re-commit.

---

## Task 116: Tauri release bundle smoke

```powershell
rtk pnpm tauri build --debug
```

Expected: successful Windows installer (and macOS arm64 if running on a Mac CI).

- [ ] Commit any bundle-config tweaks (Cargo profile, capabilities) needed.

---

## Task 117: Final manual ship gate

Phase 1 ship gate per spec §15.4:

- [ ] Real Telegram bot DM round-trip in auto, manual, draft modes.
- [ ] Real NapCat / Lagrange OneBot QQ message round-trip (auto mode).
- [ ] Real Discord guild `@bot` round-trip.
- [ ] Real Slack thread reply round-trip.
- [ ] Real Lark group bot exchange.

Once all five are confirmed working, the branch is ready for PR.

- [ ] Use `superpowers:finishing-a-development-branch` skill to package the PR.

---

# Self-Review

After writing this plan I checked:

**1. Spec coverage:**

- §1 Goals/Non-goals → covered by all CP-A through CP-H scope.
- §2 Existing infra reuse → Tasks 19-24 anchor each Rust pattern back to `remote_control/`.
- §3 Architecture diagram → Tasks 19-24 (Rust) + 25-28 (TS bus).
- §4 PlatformAdapter / AdapterContext → Task 9.
- §4.2 Capabilities → Task 6.
- §4.3 NormalizedInboundEvent → Task 4.
- §4.4 OutboundRequest/Result → Task 5.
- §4.5 MessageSegment → Task 3.
- §5 Dexie v18 → Task 11 (corrected from spec's v16; v17 already exists).
- §6 TriggerPolicy + override stack + modes → Tasks 7, 26, 27, 28, 37.
- §7 Inbox UI → CP-C (Tasks 47-58).
- §8 Proactive outbound → Task 108.
- §9 Reliability primitives → Task 38, 39.
- §10 Security: signature verification → Tasks 34, 63, 74, 87, plus per-adapter; credentials → Task 21; public-port/tunnel → handled implicitly in Task 20 axum + per-adapter forms; OAuth → Task 42, 75, 88.
- §11 Web mode degradation → Task 111.
- §12 Phase-1 platforms → CP-B (Telegram), CP-D, CP-E, CP-F, CP-G.
- §13 Plugin extension → Task 110.
- §14 Files to create/modify → all enumerated in §"File structure" header.
- §15 Verification plan → Task 115; manual gates baked into per-CP review.
- §17 Verification commands → Task 115.
- §18 Out-of-scope items → not implemented (correct).

**2. Placeholder scan:** None of "TBD / TODO / similar to Task N / fill in details / appropriate error handling" patterns found.

**3. Type-name consistency:**

- `PlatformKind` used everywhere matches Task 2.
- `MessageSegment` discriminator `type` consistent across Tasks 3, 5, 6, 9.
- `ConversationReference` opaque shape consistent in Tasks 4, 5, 9, runtime references.
- `AdapterMeta.type` field name (not `kind`) consistent across Tasks 9, 11, 12.
- `NormalizedInboundEvent.adapterId` matches `AdapterInstanceRow.id` in Task 11.
- `OutboundJobRow.idempotencyKey` matches `OutboundRequest.metadata.idempotencyKey`.

**4. Scope:** Phase 1 only. Phases 2-3 (DingTalk/WeCom/WeChat OA/QQ Bot/Email/Matrix/KOOK/LINE/Mattermost) are NOT in this plan and need their own plan(s) when scheduled.

---

# Execution Choice

This plan has **117 tasks across 8 checkpoints**. Two execution paths:

**1. Subagent-Driven (recommended for plans this size)**
Use `superpowers:subagent-driven-development`. I dispatch a fresh subagent per task or small batch (~5 tasks); review between batches; clean context per dispatch; faster overall iteration; review burden is one batch at a time.

**2. Inline Execution**
Use `superpowers:executing-plans`. Tasks executed in this same session, batched at checkpoints. Better when context continuity matters across consecutive tasks; risk: this session's context fills up before CP-D.

Which approach?
