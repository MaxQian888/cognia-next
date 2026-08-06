# Slardar data-source contract

## Scope

- Dashboard: `591721`
- Dashboard name: `主对话性能看板`
- BID: `super_aiden`
- Site type: `web`
- Control region: `cn`
- Default application environment for reports: `production`

## Stable command path

Read the dashboard definition with:

```bash
bytedcli --json --no-auto-upgrade slardar web dashboard get \
  --url "<dashboard-url>" \
  --with-raw
```

Each dashboard item's `data` field is JSON. Route its `chart` value as follows:

| `chart` | bytedcli command | Slardar endpoint |
|---|---|---|
| `indicator_card` | `flex query indicator-card` | `/api_web/web/flex/query_indicator_card` |
| `line` | `flex query series` | `/api_web/web/flex/query_series` |
| `pie` | `flex query pie` | `/api_web/web/flex/query_pie` |

Use `scripts/collect-slardar-report.mjs` instead of issuing these commands manually. The script uses argv arrays, bounded concurrency, timeouts, async-state retries, and a versioned output envelope.

## Authentication

Direct unauthenticated HTTP requests redirect to Slardar SSO. `bytedcli` obtains a ByteCloud JWT through its configured SSO flow and sends it without exposing the token to the script.

Never:

- read or print browser cookies, local storage, or JWT values;
- persist request headers;
- put a token in `SKILL.md`, a reference file, a fixture, or a command argument.

## Environment limitation

The dashboard URL uses `env=Slardar_All`, but the current Flex CLI requires `--env` and merges that value into `common.env`.

Verified behavior on 2026-07-31:

- `--env production` returns valid Flex data.
- `--env Slardar_All` returns `data_validity: false` for the tested custom performance metric.
- The browser's all-environment dashboard request omits `common.env`, so the two requests are not equivalent.

Fail closed when `Slardar_All` is requested. Do not publish an empty report as a successful all-environment report.

## Dashboard link timestamps

Keep the Flex query period in exact `Asia/Shanghai` Unix seconds. Do not modify collector
timestamps to match the dashboard date label.

For complete daily cards only, `scripts/generate-feishu-card.mjs` shifts both timestamps
in the Slardar button URL forward by 86,400 seconds. This is a display-only compatibility
rule verified against dashboard 591721 on 2026-07-31. Custom-range links use the raw range.

## Drift checks

Treat these as contract drift:

- dashboard response no longer contains `raw.data.items`;
- an item `data` field is not valid JSON;
- a required chart changes to an unsupported chart type;
- a Flex result remains asynchronous after three attempts;
- required indicator titles disappear;
- values are present but `data_validity` is false.

When drift occurs, report the failing item ID/title and preserve all valid normalized results only if `--allow-partial` was explicitly selected.
