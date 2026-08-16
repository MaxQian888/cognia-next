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

On a self-hosted (headless) deployment both base URLs are plain `.env` entries
passed through to the `cognia-server` container — see
[`deploy/compose/README.md`](../../deploy/compose/README.md) § _Lark / Feishu
entry surfaces_. `cognia-server serve` validates them on boot: a value that
cannot work (no scheme, plaintext `http://` on a public host, a query string,
embedded credentials) refuses to start and names the variable, so a typo never
reaches a user as an opaque 503. Loopback bases and a `COGNIA_LARK_WEB_BASE`
with no `COGNIA_LARK_PUBLIC_BASE` behind it print a warning and start.

## 2. Lark developer-console configuration

### 2.1 OAuth (Web SSO)

1. 安全设置 → 重定向 URL: add
   `{COGNIA_LARK_PUBLIC_BASE}/integrations/lark/web/callback`.
2. Required scopes: none beyond basic identity (`authen` user info). The SSO
   flow only reads `open_id` / `tenant_key`.

### 2.1b Send-as-user OAuth (optional)

A second, separate redirect. Add
`{COGNIA_LARK_PUBLIC_BASE}/connectors/oauth/lark/callback` (self-hosted) or
`{tunnel}/oauth/lark/callback` (desktop) as a 重定向 URL, and grant
`offline_access im:message`.

The authorization is driven by the **brain**, which mints the `state` + PKCE
verifier, keeps them in the adapter's encrypted secret store, and spends them
when the relay hands the code back — one implementation for both hosts. On the
desktop, Settings → Connections → the adapter → _Send as me_ → **Connect**. A
self-hosted install has no such dialog and uses the operator channel:

```bash
cognia-agent lark authorize --adapter <id>     # add --redirect for a proxied origin
```

It prints an authorize URL; open it in a browser signed in to Feishu. The link
is good for 10 minutes and completion lands in the running `serve` process —
so the brain must be up, and the redirect must match this console entry byte
for byte.

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

Generate the exact list rather than transcribing it:

```bash
cognia-agent lark menu-manifest          # or --json
```

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

Run the automated half first — it drives the real adapter code against the
real Feishu API and tells you which console permissions actually landed:

```bash
LARK_APP_ID=cli_… LARK_APP_SECRET=… pnpm lark:verify-entry
# optional: LARK_TEST_CHAT_ID=oc_…  LARK_WEB_BASE=https://…  LARK_VERIFY_KEEP=1
```

It covers tenant admission, bind approval → principal resolution, chat
enumeration, Chat Tab and group-menu create/update/withdraw plus their
idempotency, prints the console menu manifest, and then lists the steps below
with the audit kind and metric each should produce.

The rest needs a human in a Feishu client. Run per platform (PC / iOS /
Android) before widening any flag:

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

## 4. Rollout — the flags ship ON

Resolution order is **env → per-adapter (settings card) → localStorage →
default**, and every entry flag now defaults **on**. Note the order: an env
var wins over the settings card, so a fleet-wide `COGNIA_LARK_*` silently
overrides what an operator toggles in the UI.

Each surface is inert until its platform-side half exists — an unpublished
Chat Tab has no URL to reconcile, a shortcut nobody added in the console is
never opened — so "on" means "works once you complete §2", not "starts doing
something you did not ask for".

The one flag with immediate effect is `larkPrincipalRegistry`: unbound
senders fail closed. It is safe on because the registry seeds itself from the
Feishu identities this workspace has already conversed with (and re-tries on
the first inbound event, since `tenant_key` is only learnable from traffic).
What to watch on first deploy:

1. `principal.unbound` audits / `cognia_lark_principal_unbound_total` — a
   spike means seeding did not cover someone. Approve them: settings card →
   _Feishu identity registry_, or `cognia-agent lark list` then
   `cognia-agent lark approve <code>`.
2. `cognia_lark_callback_auth_denied_total` — enforcement is the default now
   (§6). Any denial is a real refusal; check whether it needs an operator
   entry in _Run operators_ rather than a mode downgrade.
3. `cognia_lark_chat_tab_sync_failures_total` /
   `cognia_lark_group_menu_sync_failures_total` — separate series, because
   `im:chat.tabs` and `im:chat.menu_tree` are granted separately. A `blocked`
   row in the settings card names the missing scope and stops retrying.

To stage more slowly, turn a surface **off** per adapter and re-enable after
its console configuration lands. Turning a Chat Tab / group-menu flag off
also withdraws what was already published.

## 5. Alert thresholds (companion `/metrics`)

| Series                                     | Alert                                                |
| ------------------------------------------ | ---------------------------------------------------- |
| `cognia_lark_sso_failures_total`           | > 5/min sustained → OAuth misconfig or secret drift  |
| `cognia_lark_entry_resolve_denied_total`   | spike vs `_ok_total` → link farming or clock skew    |
| `cognia_lark_principal_unbound_total`      | steady growth post-gray → missing bindings           |
| `cognia_lark_callback_auth_denied_total`   | ANY after enforce flip → investigate before widening |
| `cognia_lark_chat_tab_sync_failures_total` | > 0 persistent → scope missing or bot not in chat    |
| `cognia_lark_message_import_denied_total`  | spike → membership probes or flag misconfig          |

## 6. Callback authorization (enforce by default)

Denials block. Audit mode still exists for migration, but it is not a resting
state: in audit `consumedAt` is never written, so a stale re-click of an
approval card can still re-grant a session bypass.

**Before widening a bot to a large group**, if you want a look-first window:

1. Settings card → _Callback authorization mode_ → **Audit** on that adapter.
2. Watch `cognia_lark_callback_auth_would_deny_total` and the
   `callback.authorization_would_deny` audit rows (filter per adapter; the
   Audit tab labels every kind now).
3. Quiet for a window → set the mode back to **Enforce**.

**If enforcement refuses something legitimate**, the fix is usually an
operator entry, not a downgrade: settings card → _Run operators_ takes the
platform user ids allowed to act on runs they did not start. That list is also
the fallback approver when a workflow approval card has no known requester —
empty, those cards cannot be actioned by anyone.

## 7. Rollback

Every lever is independent and hot (settings reads are per-event):

- **Any entry surface misbehaving** → flip its flag off on the adapter; the
  legacy path is untouched by design. Flipping a Chat Tab / group-menu flag
  off now also withdraws the published tab/menu (`delete_tabs` /
  `menu_tree` DELETE) and retires the row as `removed`, so no dangling public
  URL is left behind. A delete that could not land is audited
  `chat_tab.removed` with reason `platform_delete_failed` — those need a
  manual sweep.
- **Callback enforcement breaking flows** → add the blocked people to _Run
  operators_ first; only if that is not enough, set the mode to **audit**
  (emergency: `off`). Denied clicks were terminal, not corrupted — users
  simply re-click after the downgrade.
- **Principal registry rejecting legitimate users** → approve them
  (settings card, or `cognia-agent lark approve <code>`); flag off only as a
  blunt instrument, since that restores pre-registry identity handling for
  the whole adapter. Parked `history_only` jobs remain auditable; they are not
  auto-replayed.
- **SSO incident** → rotate the companion secret: invalidates every
  `lark_web` session and outstanding entry token at once (by design).
