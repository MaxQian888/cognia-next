# Runbook — Lark Unified Identity & Dual-Entry Surfaces (ADR-0091)

Operations companion to the 2026-07-24 dual-entry epic. Everything here is a
**real-tenant step that code cannot perform**: Lark admin-console configuration,
live-client verification, gray release, and rollback. Code-side behavior is
documented in ADR-0091.

## 1. Prerequisites

- A deployed web entry: the static export served at a public **https** URL
  reachable from inside Lark clients (`webEntryBaseUrl`, settings →
  Connections → Lark adapter → _Web entry & Lark surfaces_; env fallbacks
  `COGNIA_LARK_WEB_BASE` / `NEXT_PUBLIC_COGNIA_WEB_BASE`).
- The companion API reachable at a public https URL
  (`COGNIA_LARK_PUBLIC_BASE`) — hosts `/integrations/lark/*` (SSO, entry
  resolve, intents, JSSDK signature).
- Adapter credentials (`appId`/`appSecret`) already in the connectors keyring.

## 2. Lark developer-console configuration

### 2.1 OAuth (Web SSO)

1. 安全设置 → 重定向 URL: add
   `{COGNIA_LARK_PUBLIC_BASE}/integrations/lark/web/callback`.
2. Required scopes: none beyond basic identity (`authen` user info). The SSO
   flow only reads `open_id` / `tenant_key`.

### 2.2 Permissions (tenant token)

| Capability            | Scope to enable                                                       |
| --------------------- | --------------------------------------------------------------------- |
| Chat Tab reconcile    | `im:chat.tabs:write_only` (+ `im:chat.tabs:read`)                     |
| Group menu reconcile  | `im:chat.menu_tree:write_only` (+ `im:chat.menu_tree:read`)           |
| Member check / import | `im:chat.members:read` (or umbrella `im:chat`), `im:message:readonly` |
| JSSDK ticket          | enabled automatically with the web app capability                     |

### 2.3 Bot menu (机器人自定义菜单)

Single chats only; two action types are used:

| Menu item                 | Action   | event_key / payload     |
| ------------------------- | -------- | ----------------------- |
| 新任务 New task           | 推送事件 | `cognia.new_task`       |
| 状态 Status               | 推送事件 | `cognia.status`         |
| 帮助 Help                 | 推送事件 | `cognia.help`           |
| 打开工作台 Open workbench | 推送事件 | `cognia.open_workbench` |

Reserved `cognia.*` keys resolve without adapter configuration; adapter rows
shadow them. The reserved batch is gated by the **Command menu batch**
(`larkNativeSlash`) flag on the adapter — until it is enabled, reserved
clicks answer the same "not configured" notice as unknown keys
(adapter-configured rows are never gated). The workbench link additionally
mints a personal single-use entry link when **Web SSO** + the principal
registry are on; otherwise it falls back to the bare web base URL. Unknown
keys always answer with a fixed bilingual notice (audit `menu.unknown_key`)
— they are never forwarded to the model, so a typo'd `event_key` is visible
immediately.

### 2.4 Command menu batch (`nativeExposed`)

Feishu has **no** slash-command API for bots (verified 2026-07 against the
bot capability overview — a typed "/x" arrives as a plain message). Expose
the batch as additional bot-menu items with action 发送文字消息 (requires
client ≥ V7.22) posting the literal command text:

`/new` · `/status` · `/help` · `/sessions` · `/switch`

(Source of truth: `lib/connectors/commands/registry.ts` — items marked
`nativeExposed`.)

### 2.5 Message shortcut (消息快捷操作)

网页应用能力 → 添加场景 → 消息快捷操作:

- AppLink target: `{webEntryBaseUrl}/lark/shortcut?adapter_id={adapterId}`
- PC mode `sidebar-semi` is for mini-programs; web apps use `mode=sidebar`.
- Lark caps a selection at **20 messages**; the brain enforces the same cap.

### 2.6 `+` menu (输入框加号菜单)

添加场景 → “+”菜单, AppLink
`{webEntryBaseUrl}/lark/shortcut?adapter_id={adapterId}` (the same page
handles both; the official “+”-menu doc is JS-rendered and could not be
content-verified — confirm the exact launch params during 3.x verification
and record them here).

Minimum client versions: bot menu 发送文字消息 requires **V7.22+**; JSSDK
`getBlockActionSourceDetail` requires a current client — verify on the
oldest fleet version during 3.x.

## 3. Real-client verification matrix

Run per platform (PC / iOS / Android) before widening any flag:

| #    | Check                                       | Expect                                                                        |
| ---- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| 3.1  | Bot menu click (each reserved key)          | mapped keys run; workbench link replies with `{webEntryBaseUrl}` URL          |
| 3.2  | Unknown menu key                            | bilingual "not configured" reply, `menu.unknown_key` audit, NO model turn     |
| 3.3  | Chat Tab open (member)                      | SSO once → lands in `/inbox/c` for that chat                                  |
| 3.4  | Chat Tab open (non-member with copied link) | `forbidden` error page                                                        |
| 3.5  | Personal entry link re-open                 | `entry_consumed` (single-use)                                                 |
| 3.6  | Message shortcut, ≤20 messages              | import lands; delimited block in a fresh session; re-run replays SAME session |
| 3.7  | Message shortcut with a recalled message    | import succeeds, recalled id listed as skipped                                |
| 3.8  | `+` menu                                    | new session bound to the chat                                                 |
| 3.9  | Unbound sender DM (registry flag on)        | bind-code reply once/day; nothing executes                                    |
| 3.10 | JSSDK signature                             | `h5sdk.config` succeeds on the shortcut page (no `ticket` errors in console)  |

Record the observed `+`-menu / shortcut launch-query params (2.6) and the
JSSDK detail payload shape; `extractMessageRefs` scans tolerantly but pinning
the real shape tightens it.

## 4. Gray-release order

Flags are per-adapter (settings card) → env → default off. Widen in this
order, one step per observation window:

1. `larkPrincipalRegistry` **on one pilot adapter** after binding pilot
   principals — watch `principal.unbound` audits for false rejections.
2. `larkWebSso` + personal entry links (bot-menu workbench link).
3. `larkChatTab` on pilot chats → `larkGroupMenu`.
4. `larkMessageShortcut` → `larkPlusMenu`.
5. `larkStrictCallbackAuthorization`: keep **audit** until
   `callback.authorization_would_deny` is quiet for a full window (§6), then
   set **enforce** per adapter.

## 5. Alert thresholds (companion `/metrics`)

| Series                                     | Alert                                                |
| ------------------------------------------ | ---------------------------------------------------- |
| `cognia_lark_sso_failures_total`           | > 5/min sustained → OAuth misconfig or secret drift  |
| `cognia_lark_entry_resolve_denied_total`   | spike vs `_ok_total` → link farming or clock skew    |
| `cognia_lark_principal_unbound_total`      | steady growth post-gray → missing bindings           |
| `cognia_lark_callback_auth_denied_total`   | ANY after enforce flip → investigate before widening |
| `cognia_lark_chat_tab_sync_failures_total` | > 0 persistent → scope missing or bot not in chat    |
| `cognia_lark_message_import_denied_total`  | spike → membership probes or flag misconfig          |

## 6. Enforce flip (callback authorization)

1. Confirm 7 quiet days of `callback.authorization_would_deny` (audit log,
   filter per adapter).
2. Settings card → _Callback authorization mode_ → **Enforce** (or
   `COGNIA_LARK_STRICT_CALLBACK_AUTH=enforce` fleet-wide).
3. Watch `cognia_lark_callback_auth_denied_total` + user reports for one
   window.

## 7. Rollback

Every lever is independent and hot (settings reads are per-event):

- **Any entry surface misbehaving** → flip its flag off on the adapter; the
  legacy path is untouched by design. Chat Tab / menu rows stay in
  `larkChatSurfaces` (status only); platform-side tabs can be removed
  manually if needed (`delete_tabs` / `menu_tree` DELETE).
- **Callback enforcement breaking flows** → set mode back to **audit**
  (emergency: `off`). Denied clicks were terminal, not corrupted — users
  simply re-click after the downgrade.
- **Principal registry rejecting legitimate users** → flag off (legacy
  identity), fix bindings, re-enable. Parked `history_only` jobs remain
  auditable; they are not auto-replayed.
- **SSO incident** → rotate the companion secret: invalidates every
  `lark_web` session and outstanding entry token at once (by design).
