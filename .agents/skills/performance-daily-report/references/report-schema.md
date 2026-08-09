# Normalized report schema

The collector returns this envelope:

```json
{
  "status": "success",
  "data": {
    "schema_version": "1.0",
    "report_status": "complete",
    "source": {},
    "period": {},
    "metrics": [],
    "slow_apis": [],
    "entry_counts": {},
    "queries": [],
    "warnings": []
  },
  "error": null
}
```

## Report status

- `complete`: every supported dashboard query succeeded and every required indicator is valid.
- `partial`: one or more values are missing, invalid, unsupported, or explicitly allowed to fail.
- Process exit code is nonzero only for a fatal collection failure.

## Metrics

Each indicator metric has:

| Field | Meaning |
|---|---|
| `key` | Stable report key, independent of the Slardar measure UUID |
| `label` | Current dashboard title |
| `unit` | Normalized unit; performance latency is `ms` |
| `value` | Current period value, or `null` when invalid |
| `previous_value` | Previous equal-period value, or `null` |
| `delta_ratio` | `(current / previous) - 1`, or `null` |
| `valid` | Whether the current value is safe to render |

Known keys:

- `lcp_p90`
- `fcp_p90`
- `composer_ready_p90`
- `create_ttfb_p90`
- `create_ttfm_p90`
- `switch_ttfm_p90`
- `navigation_ttfm_p90`

Latency is lower-is-better. Render a positive `delta_ratio` as regression and a negative ratio as improvement.

## Slow APIs

`slow_apis` contains at most three rows, ranked by the latest valid daily P90 point:

- `path`
- `latest_p90_ms`
- `latest_timestamp`
- `average_daily_p90_ms`
- `maximum_daily_p90_ms`
- `points`

Do not describe `average_daily_p90_ms` as the whole-period P90; it is the average of returned daily P90 points.

## Entry counts

`entry_counts` maps Slardar `entry_type` values to valid report counts, for example:

- `create_task`
- `task_tab_switch`
- `direct_open`
- `page_reload`
- `back_forward`

## Rendering rules

- Render `null` as `N/A`, never `0`.
- Render values below 1000 ms as integer milliseconds.
- Render values at or above 1000 ms as seconds with two decimals.
- Render deltas as percentages with a sign and two decimals.
- Include warnings in previews and delivered reports.
- Do not infer SLA status from trend alone.

Use `scripts/generate-feishu-card.mjs`; do not recreate the Card 2.0 payload manually.
The renderer selects the largest valid positive `delta_ratio` for `今日关注`; if there
is no regression, it selects the largest improvement, then the first valid current metric.

## Feishu payload boundary

A received `im.message.receive_v1` event is not a sendable card payload. When an example
event contains an interactive message, treat `event.message.content.user_dsl` as the visual
reference only. Do not copy the event header, sender, chat/thread/message IDs, fallback image,
or escaped wrapper into a new report. `scripts/generate-feishu-card.mjs` must output the
unescaped inner Card 2.0 object that is passed directly to `lark-cli --content`.

Keep the card structure close to the approved optimized report example:

- `schema: "2.0"`.
- Blue header with the report date in `YYYY-MM-DD` form, the period in the subtitle,
  and the valid-data status in a text tag.
- One dominant `今日关注` block with the largest regression or improvement.
- One grouped performance block containing `今日概览` and a regression-first `环比变化`:
  expand every regression, then summarize improvements on one compact line.
- One diagnostic block containing a true ordered slow-API list and entry counts. Never
  prefix ordered rows with `-`; that creates the broken nested bullet/letter rendering.
- Optional data-quality warnings and the Slardar source button.
- `config.enable_forward_interaction: false` and `config.streaming_mode: false`.
- No callback interaction; the source button uses only `open_url`.

For LCP and FCP, use the absolute millisecond change in the homepage block. Treat an
absolute change up to 150 ms as the user-approved `约 100 ms` normal range. If either
metric exceeds that range, identify it explicitly instead of showing the blanket normal-range copy.

For partial reports, keep all valid sections, render invalid metrics as `N/A`, use the
`部分数据` status, and show the valid-data count plus warning count.

## Card copy baseline

Keep the user-approved Chinese labels below when rendering the Feishu card. Values,
dates, status, and deltas remain dynamic.

- Section title: `对话详情页` with suffix `P90 · 环比前一日`.
- `create_ttfb_p90`: `首Token`.
- `create_ttfm_p90`: `首消息`.
- `switch_ttfm_p90`: `切换任务首消息出现`.
- `navigation_ttfm_p90`: `跳转/刷新首消息出现`.
- Source action: `查看本期 Slardar 看板`.

Never render `create_ttfb_p90` as `首字节`, `首字节创建时间`, or similar wording.
The underlying dashboard item title may retain that source wording, but user-visible cards
must use `首Token`. Likewise, render TTFM as `首消息`.

## Dashboard link boundary

Keep Flex query timestamps and the Slardar button timestamps separate. For a complete
daily report, the dashboard page currently needs both button timestamps shifted forward
by 86,400 seconds so its date selector displays the intended report day. Do not apply
that display-only offset to data collection or to custom ranges. The generator owns this rule.
