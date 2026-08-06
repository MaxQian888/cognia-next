import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDashboardUrl,
  formatLatency,
  parseArgs,
  renderPerformanceCard,
  selectAttentionMetric,
} from "./generate-feishu-card.mjs";

function metric(key, value, previousValue, deltaRatio, valid = true) {
  return {
    key,
    label: key,
    unit: "ms",
    value,
    previous_value: previousValue,
    delta_ratio: deltaRatio,
    valid,
  };
}

function reportFixture(overrides = {}) {
  return {
    schema_version: "1.0",
    report_status: "complete",
    source: {
      dashboard_id: "591721",
      bid: "super_aiden",
      env: "production",
      site_type: "web",
      region: "cn",
      item_count: 9,
    },
    period: {
      date: "2026-07-30",
      start_time: 1785340800,
      end_time: 1785427200,
      start_iso: "2026-07-30T00:00:00.000+08:00",
      end_iso: "2026-07-31T00:00:00.000+08:00",
      time_zone: "Asia/Shanghai",
      comparison_shift_seconds: 86400,
    },
    metrics: [
      metric("lcp_p90", 3060, 2935, 0.0424),
      metric("fcp_p90", 833, 750, 0.1114),
      metric("composer_ready_p90", 3680, 5001, -0.2641),
      metric("create_ttfb_p90", 82890, 94745, -0.1251),
      metric("create_ttfm_p90", 4000, 3295, 0.2139),
      metric("switch_ttfm_p90", 1390, 1122, 0.2393),
      metric("navigation_ttfm_p90", 4620, 4105, 0.1254),
    ],
    slow_apis: [
      { path: "/v1/oauth/check", latest_p90_ms: 1740 },
      { path: "/v1/model-settings/aiproxy-catalog", latest_p90_ms: 1620 },
      { path: "/list-space-project", latest_p90_ms: 1580 },
    ],
    entry_counts: {
      task_tab_switch: 9395,
      direct_open: 1660,
      create_task: 1031,
      page_reload: 841,
      back_forward: 151,
    },
    queries: Array.from({ length: 9 }, (_, index) => ({ item_id: String(index), status: "success" })),
    warnings: [],
    ...overrides,
  };
}

function textContents(card) {
  const contents = [];
  function visit(value) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value.content === "string") contents.push(value.content);
    Object.values(value).forEach(visit);
  }
  visit(card);
  return contents.join("\n");
}

function taggedElements(value, tag) {
  const matches = [];
  function visit(item) {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!item || typeof item !== "object") return;
    if (item.tag === tag) matches.push(item);
    Object.values(item).forEach(visit);
  }
  visit(value);
  return matches;
}

test("parses live-generation and output options", () => {
  assert.deepEqual(parseArgs(["--date", "2026-07-28", "--output", "card.json", "--pretty"]), {
    date: "2026-07-28",
    outputPath: "card.json",
    allowPartial: false,
    force: false,
    pretty: true,
    timeoutMs: 30_000,
    help: false,
  });
  assert.throws(() => parseArgs(["--date", "2026-07-28", "--report", "report.json"]));
  assert.deepEqual(
    parseArgs(["--start-time", "100", "--end-time", "200", "--compare-shift", "100"]),
    {
      startTime: 100,
      endTime: 200,
      compareShift: 100,
      allowPartial: false,
      force: false,
      pretty: false,
      timeoutMs: 30_000,
      help: false,
    },
  );
  assert.throws(() => parseArgs(["--start-time", "100"]));
});

test("formats latency without converting missing values to zero", () => {
  assert.equal(formatLatency(null), "N/A");
  assert.equal(formatLatency(580.8738), "581 ms");
  assert.equal(formatLatency(2721.3115), "2.72 s");
});

test("selects the largest positive ratio as today's attention metric", () => {
  const report = reportFixture();
  const attention = selectAttentionMetric(report.metrics);
  assert.equal(attention.metric.key, "switch_ttfm_p90");
  assert.equal(attention.caption, "最大环比回退");
});

test("renders the approved complete-card copy and daily Slardar link semantics", () => {
  const card = renderPerformanceCard(reportFixture());
  const text = textContents(card);
  assert.equal(card.schema, "2.0");
  assert.deepEqual(card.config, {
    enable_forward_interaction: false,
    streaming_mode: false,
    width_mode: "default",
  });
  assert.deepEqual(card.header, {
    title: { tag: "plain_text", content: "AIDEN 主对话性能日报 · 2026-07-30" },
    subtitle: { tag: "plain_text", content: "2026-07-30 全天 · 北京时间" },
    template: "blue",
    icon: { tag: "standard_icon", token: "chart_colorful" },
    text_tag_list: [
      {
        tag: "text_tag",
        text: { tag: "plain_text", content: "数据完整 · 9/9" },
        color: "green",
      },
    ],
  });
  assert.deepEqual(card.body.elements.map((element) => element.tag), ["column_set", "column_set", "column_set", "button"]);
  assert.ok(taggedElements(card, "column").every((column) => column.corner_radius === undefined));
  assert.match(text, /今日关注 · 最大环比回退/);
  assert.match(text, /今日概览/);
  assert.match(text, /环比变化/);
  assert.match(text, /首Token/);
  assert.match(text, /首消息/);
  assert.doesNotMatch(text, /首字节/);
  assert.match(text, /切换任务首消息出现/);
  assert.match(text, /LCP、FCP 较昨日均在约 100 ms 日常波动范围/);
  assert.match(text, /5 项变慢/);
  assert.match(text, /其余 2 项改善/);
  assert.match(text, /查看本期 Slardar 看板/);
  const [button] = taggedElements(card, "button");
  const url = button.behaviors[0].default_url;
  assert.match(url, /start_time=1785427200/);
  assert.match(url, /end_time=1785513600/);
});

test("renders a partial 0728 report with N/A, warnings, and mixed Web Vital guidance", () => {
  const base = reportFixture();
  const partial = reportFixture({
    report_status: "partial",
    period: {
      ...base.period,
      date: "2026-07-28",
      start_time: 1785168000,
      end_time: 1785254400,
      start_iso: "2026-07-28T00:00:00.000+08:00",
      end_iso: "2026-07-29T00:00:00.000+08:00",
    },
    metrics: [
      metric("lcp_p90", 2721.3115, 2433.9438, 0.1181),
      metric("fcp_p90", 580.8738, 510.89664, 0.137),
      metric("composer_ready_p90", null, null, null, false),
      metric("create_ttfb_p90", 93350.6, 94176.1, -0.0088),
      metric("create_ttfm_p90", 3071.6, 3599.2, -0.1466),
      metric("switch_ttfm_p90", 1245, 1475.7, -0.1563),
      metric("navigation_ttfm_p90", 4932, 4599.2, 0.0724),
    ],
    warnings: [{ code: "INVALID_METRIC", message: "composer-ready is invalid" }],
  });
  const card = renderPerformanceCard(partial);
  const text = textContents(card);
  assert.match(text, /部分数据/);
  assert.match(text, /输入框可交互 N\/A/);
  assert.match(text, /部分数据 · 8\/9 · 1 告警/);
  assert.match(text, /composer-ready is invalid/);
  assert.match(text, /LCP 变慢 287 ms/);
  assert.match(text, /FCP 波动 70 ms/);
  const [button] = taggedElements(card, "button");
  const url = button.behaviors[0].default_url;
  assert.match(url, /start_time=1785254400/);
  assert.match(url, /end_time=1785340800/);
});

test("does not apply the daily display offset to custom ranges", () => {
  const report = reportFixture({
    period: {
      date: null,
      start_time: 100,
      end_time: 200,
      start_iso: "1970-01-01T08:01:40.000+08:00",
      end_iso: "1970-01-01T08:03:20.000+08:00",
      time_zone: "Asia/Shanghai",
      comparison_shift_seconds: 100,
    },
  });
  const url = buildDashboardUrl(report);
  assert.match(url, /start_time=100/);
  assert.match(url, /end_time=200/);
  const card = renderPerformanceCard(report);
  assert.match(card.header.title.content, /主对话性能报告/);
  assert.match(card.header.subtitle.content, /01-01 08:01 ~ 01-01 08:03 · 北京时间/);
});

test("renders slow APIs as a true ordered list and flags a relative outlier", () => {
  const card = renderPerformanceCard(
    reportFixture({
      slow_apis: [
        { path: "/sidebar-run-list", latest_p90_ms: 584_280 },
        { path: "/list-space-project", latest_p90_ms: 2_720 },
        { path: "/v1/oauth/check", latest_p90_ms: 2_430 },
      ],
    }),
  );
  const text = textContents(card);
  assert.match(text, /1\. `\/sidebar-run-list`：584\.28 s.*异常候选/);
  assert.match(text, /首项显著高于其余接口，建议确认采样口径/);
  assert.doesNotMatch(text, /- 1\./);
});
