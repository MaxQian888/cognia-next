---
name: performance-daily-report
description: Collect, normalize, render, preview, and deliver daily performance reports from the super_aiden Slardar dashboard 591721. Use when Codex needs to generate a daily or custom-range performance summary, create the approved Feishu Card 2.0 report, quick-test a card by sending it from the configured bot to the current user, or deliver a confirmed report to a Feishu user or group.
---

# Performance Daily Report

Use deterministic scripts for data collection. Keep authentication, query construction, normalization, and validation out of ad-hoc shell commands.

Run examples from this skill directory. From another working directory, replace every
`scripts/...` path with its absolute path under the discovered skill directory.

Prerequisites:

- Node.js and `bytedcli` for collection; `bytedcli` must already have working ByteCloud SSO.
- `lark-cli` only for Feishu preview or delivery. Delivery always uses the configured
  bot identity; self-preview also needs the current user identity.
- In an Aiden runtime, `http://127.0.0.1:43201/context` exposes the expected bot
  identity for the current task. Treat it as identity metadata, not as credentials.
- Never put app secrets, access tokens, browser cookies, or JWT values in arguments or files.

## Generate the daily Feishu card

Use the generator as the default end-to-end path. It collects the data and renders the
user-approved Card 2.0 layout without reusing an old card or manually editing timestamps.
The output is the inner card DSL used as `--content`, not an `im.message.receive_v1`
event envelope or the escaped `event.message.content.user_dsl` string:

```bash
node scripts/generate-feishu-card.mjs \
  --date 2026-07-28 \
  --output /absolute/path/performance-daily-report-card-2026-07-28.json \
  --pretty
```

Omit `--date` to use the previous complete `Asia/Shanghai` day. The generator refuses
to replace an existing output unless `--force` is explicit. It renders missing values as
`N/A`, marks partial reports, applies the approved Chinese copy, and constructs the
Slardar button URL with the dashboard's verified daily date-display semantics. Keep the
approved grouped rhythm: blue header with the report period and data status, one dominant
`今日关注` block, a compact `今日概览` plus regression-first `环比变化` block, a diagnostic
block for slow APIs and entry counts, optional warnings, and the source button. Keep `hr`
elements inside related blocks instead of using them as the card's primary structure.

Render an existing normalized report instead of collecting again:

```bash
node scripts/generate-feishu-card.mjs \
  --report /absolute/path/normalized-report.json \
  --output /absolute/path/card.json \
  --pretty
```

Generate a custom range directly when needed:

```bash
node scripts/generate-feishu-card.mjs \
  --start-time 1785168000 \
  --end-time 1785427200 \
  --output /absolute/path/card.json \
  --pretty
```

Read [references/report-schema.md](references/report-schema.md) only when changing
the renderer, report schema, metric policy, or card copy.

## Collect a Slardar report

Default to the previous complete calendar day in `Asia/Shanghai` and the `production` environment:

```bash
node scripts/collect-slardar-report.mjs --pretty
```

Collect a specific day:

```bash
node scripts/collect-slardar-report.mjs --date 2026-07-30 --pretty
```

Collect a custom range:

```bash
node scripts/collect-slardar-report.mjs \
  --start-time 1785168000 \
  --end-time 1785427200 \
  --pretty
```

Run the script from this skill directory, or use its absolute path. Do not reconstruct the underlying `bytedcli` calls manually.

The script writes one JSON envelope to stdout:

- `status: "success"` with a versioned report under `data`.
- `status: "error"` with a stable error code and nonzero exit status.

Treat `data.report_status == "partial"` as usable only after reporting its warnings. Never convert invalid or missing values to zero.

## Apply environment rules

Use `production` unless the user explicitly chooses another real application environment. Do not pass `Slardar_All`: current `bytedcli` Flex queries inject `common.env`, and `Slardar_All` returns invalid data instead of matching the dashboard's all-environment UI semantics.

If exact `Slardar_All` parity is required, stop and explain the limitation. Use the browser capture fallback only after the user accepts that dependency or after `bytedcli` adds an all-environment mode. Read [references/slardar-source.md](references/slardar-source.md) for the verified boundary and query routing.

## Interpret the report

Use these report sections:

1. Overall period and report status.
2. Homepage experience: LCP, FCP, and composer-ready P90.
3. First-message experience: create TTFB (`首Token`) and TTFM (`首消息`) by entry type.
4. Top three slow dependencies and entry-type sample counts.
5. Source link and warnings.

Format millisecond metrics as integer milliseconds below 1000 ms and seconds with two decimals at or above 1000 ms. For latency metrics, a positive delta is a regression and a negative delta is an improvement.

In user-visible Chinese copy, always call TTFB `首Token` and TTFM `首消息`. Do not use
`首字节`, `首字节创建时间`, or similar labels, even if the underlying Slardar item title does.

Do not claim SLA compliance until the user supplies explicit thresholds. Use trend language only.

## Quick-test a Feishu card

Resolve the expected bot before previewing or delivering:

```bash
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:43201/context \
  | jq '[paths(scalars) as $p
      | ($p | map(tostring) | join(".")) as $field
      | select($field | test("bot|app(_?id|\\.id|_?name|\\.name)"; "i"))
      | select(($field | test("secret|token|cookie|jwt|authorization|credential|password"; "i")) | not)
      | {field: $field, value: getpath($p)}]'
lark-cli auth status --verify
```

From the context response, inspect only the bot identity fields needed for confirmation,
such as its display name, app ID, or open bot ID. Do not paste the complete context response
into chat, logs, arguments, or files, and never copy tokens or secrets from it. Then verify
that `lark-cli auth status --verify` reports the intended bot as ready. If both sources expose
a stable bot identifier and they disagree, stop instead of sending. If the context endpoint is
unavailable outside an Aiden runtime, report that the runtime identity could not be cross-checked
and use the verified `lark-cli` bot identity only after the user accepts that limitation.

After constructing and validating a Card 2.0 payload with the `lark-im` card workflow,
send it to the current `lark-cli` user for visual review with one command:

```bash
node scripts/quick-test-card.mjs --card /absolute/path/to/card.json --pretty
```

The script always runs `lark-cli auth status --verify`, requires its bot identity to be
ready, validates the Card 2.0 root, and sends with an explicit `--as bot`. When no recipient
override is supplied, it also reads the current user's `open_id` for the self-preview. It runs
a `lark-cli` dry-run before the external write and never accepts or stores app credentials.
Use `--user-id ou_xxx` only for an explicit recipient override, and use `--dry-run`
to stop before the external write.

Treat a non-dry-run invocation as an external write. Confirm the card file, recipient,
and the bot identity resolved from runtime context and verified by `lark-cli` before running it.
Return the script's `message_id` and reported bot identity after a successful send.

## Deliver to Feishu

Default to generating the card without sending it. Use `lark-cli im +messages-send` for the
external write, following the available `lark-im` card workflow. The generator output is the
Card 2.0 payload; do not reconstruct it, reuse a dated card, or hand-edit the Slardar timestamps.

Before sending, confirm all three external-write inputs:

1. Recipient: group `chat_id` or user `open_id`.
2. Final report content and period.
3. Bot identity: resolve the expected bot from `curl http://127.0.0.1:43201/context`
   when available, then verify the configured bot with `lark-cli auth status --verify`.

Always pass `--as bot` explicitly. Never deliver a performance report with `--as user` or by
relying on a CLI default:

```bash
lark-cli im +messages-send \
  --as bot \
  --chat-id oc_xxx \
  --msg-type interactive \
  --content '<generated_card_json>' \
  --idempotency-key perf-591721-20260730
```

For a direct message, replace `--chat-id oc_xxx` with `--user-id ou_xxx`. Run the same
command with `--dry-run` first. Do not pass context data, app credentials, or tokens to
`lark-cli`; it uses its configured bot credentials internally.

For a self-preview, prefer `scripts/quick-test-card.mjs`; it creates a unique key for every
intentional preview and refuses to proceed without a ready bot. For other recipients, use an
idempotency key no longer than 50 characters, such as `perf-591721-20260730`. Return the
resulting `message_id` and confirmed bot identity. If `lark-cli` is unavailable, return the
generated card without sending.

## Validate changes

After editing the skill, run:

```bash
node --test scripts/collect-slardar-report.test.mjs
node --test scripts/generate-feishu-card.test.mjs
node --test scripts/quick-test-card.test.mjs
python3 ../.system/skill-creator/scripts/quick_validate.py .
```

Also generate one known live day and run `quick-test-card.mjs --dry-run` on the result
when Slardar and Feishu access are available. A unit-test pass alone does not validate
authentication, the current dashboard contract, or Card 2.0 acceptance.
