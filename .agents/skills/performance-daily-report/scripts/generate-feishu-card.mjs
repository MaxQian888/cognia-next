#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { collectReport, parseArgs as parseCollectorArgs } from "./collect-slardar-report.mjs";

const NORMAL_WEB_VITAL_DELTA_MS = 150;
const DASHBOARD_DAILY_LINK_OFFSET_SECONDS = 86_400;

const METRIC_LABELS = {
  lcp_p90: "首页 · LCP P90",
  fcp_p90: "首页 · FCP P90",
  composer_ready_p90: "首页 · 输入框可交互 P90",
  create_ttfb_p90: "创建任务 · 首Token P90",
  create_ttfm_p90: "创建任务 · 首消息 P90",
  switch_ttfm_p90: "切换任务 · 首消息 P90",
  navigation_ttfm_p90: "跳转/刷新 · 首消息 P90",
};

const COMPARISON_LABELS = {
  lcp_p90: "LCP",
  fcp_p90: "FCP",
  composer_ready_p90: "输入框可交互",
  create_ttfb_p90: "首Token",
  create_ttfm_p90: "首消息",
  switch_ttfm_p90: "切换任务首消息出现",
  navigation_ttfm_p90: "跳转/刷新首消息出现",
};

export class CardGenerationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "CardGenerationError";
    this.code = code;
    this.details = details;
  }
}

function usage() {
  return `Usage: generate-feishu-card.mjs [options]

Collect a daily Slardar report and render the user-approved Feishu Card 2.0 layout.
Without --output, the card JSON is written to stdout.

Options:
  --date <YYYY-MM-DD>  Complete Asia/Shanghai day (default: previous day)
  --start-time <unix>  Custom range start in Unix seconds
  --end-time <unix>    Custom range end in Unix seconds
  --compare-shift <s>  Comparison shift for a custom range
  --report <path>      Render an existing normalized report JSON instead of collecting
  --env <env>          Slardar environment for live collection (default: production)
  --output <path>      Write card JSON to this path
  --force              Replace an existing --output file
  --allow-partial      Continue after an individual Slardar query failure
  --timeout-ms <ms>    Timeout per bytedcli call (default: 30000)
  --pretty             Pretty-print card JSON
  --help               Show this help
`;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CardGenerationError("INVALID_ARGUMENT", `${flag} requires a value.`);
  }
  return value;
}

function parseInteger(value, flag, { min, max }) {
  if (!/^\d+$/.test(String(value))) {
    throw new CardGenerationError("INVALID_ARGUMENT", `${flag} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new CardGenerationError("INVALID_ARGUMENT", `${flag} is outside the supported range.`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const options = {
    allowPartial: false,
    force: false,
    pretty: false,
    timeoutMs: 30_000,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--date":
        options.date = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--report":
        options.reportPath = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--start-time":
        options.startTime = parseInteger(requireValue(argv, index, arg), arg, { min: 0, max: Number.MAX_SAFE_INTEGER });
        index += 1;
        break;
      case "--end-time":
        options.endTime = parseInteger(requireValue(argv, index, arg), arg, { min: 1, max: Number.MAX_SAFE_INTEGER });
        index += 1;
        break;
      case "--compare-shift":
        options.compareShift = parseInteger(requireValue(argv, index, arg), arg, { min: 1, max: Number.MAX_SAFE_INTEGER });
        index += 1;
        break;
      case "--env":
        options.env = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--output":
        options.outputPath = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = parseInteger(requireValue(argv, index, arg), arg, {
          min: 1_000,
          max: 300_000,
        });
        index += 1;
        break;
      case "--allow-partial":
        options.allowPartial = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--pretty":
        options.pretty = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new CardGenerationError("INVALID_ARGUMENT", `Unknown option: ${arg}`);
    }
  }

  const hasCustomRange = options.startTime !== undefined || options.endTime !== undefined;
  if ((options.startTime === undefined) !== (options.endTime === undefined)) {
    throw new CardGenerationError("INVALID_ARGUMENT", "--start-time and --end-time must be provided together.");
  }
  if (options.date && hasCustomRange) {
    throw new CardGenerationError("INVALID_ARGUMENT", "Use --date or --start-time/--end-time, not both.");
  }
  if (options.reportPath && (options.date || hasCustomRange || options.compareShift !== undefined)) {
    throw new CardGenerationError("INVALID_ARGUMENT", "Use --report or live collection range options, not both.");
  }
  if (options.reportPath && options.env) {
    throw new CardGenerationError("INVALID_ARGUMENT", "--env applies only to live collection, not --report.");
  }
  if (options.force && !options.outputPath) {
    throw new CardGenerationError("INVALID_ARGUMENT", "--force requires --output.");
  }
  return options;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function formatLatency(value) {
  if (!isFiniteNumber(value)) return "N/A";
  if (Math.abs(value) < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(2)} s`;
}

function formatCount(value) {
  if (!isFiniteNumber(value)) return "N/A";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function escapeMarkdownText(value) {
  const replacements = {
    "&": "&#38;",
    "<": "&#60;",
    ">": "&#62;",
    "*": "&#42;",
    "~": "&#126;",
    "[": "&#91;",
    "]": "&#93;",
    "(": "&#40;",
    ")": "&#41;",
    "#": "&#35;",
    "_": "&#95;",
  };
  return String(value).replace(/[&<>*~\[\]()#_]/g, (character) => replacements[character]);
}

function metricMap(report) {
  return new Map((report.metrics ?? []).map((metric) => [metric.key, metric]));
}

function isValidMetric(metric) {
  return Boolean(metric?.valid && isFiniteNumber(metric.value));
}

function ratioMarkup(metric) {
  if (!isValidMetric(metric) || !isFiniteNumber(metric.delta_ratio)) {
    return "<font color='grey'>暂无有效对比</font>";
  }
  const percentage = metric.delta_ratio * 100;
  if (percentage > 0) return `<font color='red'>▲ +${percentage.toFixed(2)}%</font>`;
  if (percentage < 0) return `<font color='green'>▼ ${percentage.toFixed(2)}%</font>`;
  return "<font color='blue'>0.00%</font>";
}

export function selectAttentionMetric(metrics) {
  const comparable = (metrics ?? []).filter(
    (metric) => isValidMetric(metric) && isFiniteNumber(metric.previous_value) && isFiniteNumber(metric.delta_ratio),
  );
  const regressions = comparable.filter((metric) => metric.delta_ratio > 0).sort((a, b) => b.delta_ratio - a.delta_ratio);
  if (regressions.length > 0) {
    return { metric: regressions[0], caption: "最大环比回退" };
  }
  const improvements = comparable.filter((metric) => metric.delta_ratio < 0).sort((a, b) => a.delta_ratio - b.delta_ratio);
  if (improvements.length > 0) {
    return { metric: improvements[0], caption: "最大环比改善" };
  }
  const current = (metrics ?? []).find(isValidMetric);
  return current ? { metric: current, caption: "当前 P90" } : { metric: null, caption: "暂无有效数据" };
}

function webVitalNote(lcp, fcp) {
  const items = [
    { name: "LCP", metric: lcp },
    { name: "FCP", metric: fcp },
  ].map(({ name, metric }) => {
    if (!isValidMetric(metric) || !isFiniteNumber(metric.previous_value)) {
      return { normal: false, direction: null, text: `<font color='grey'>${name} 暂无有效对比</font>` };
    }
    const delta = metric.value - metric.previous_value;
    const absoluteDelta = Math.abs(delta);
    if (absoluteDelta <= NORMAL_WEB_VITAL_DELTA_MS) {
      return { normal: true, direction: "normal", text: `${name} 波动 ${formatLatency(absoluteDelta)}` };
    }
    const direction = delta > 0 ? "regression" : "improvement";
    const color = direction === "regression" ? "red" : "green";
    const trend = direction === "regression" ? "变慢" : "改善";
    return {
      normal: false,
      direction,
      text: `<font color='${color}'>${name} ${trend} ${formatLatency(absoluteDelta)}</font>`,
    };
  });

  if (items.every((item) => item.normal)) {
    return "<font color='grey'>LCP、FCP 较昨日均在约 100 ms 日常波动范围</font>";
  }
  const comparable = items.filter((item) => item.direction && item.direction !== "normal");
  const suffix = comparable.length === 2 && comparable[0].direction === comparable[1].direction ? "，均为明显变化" : "";
  return `${items.map((item) => item.text).join("｜")}${suffix}`;
}

function plainText(content) {
  return { tag: "plain_text", content };
}

function markdown(content, extras = {}) {
  return { tag: "markdown", content, ...extras };
}

function dailyDateLabel(report) {
  const date = report.period?.date ?? String(report.period?.start_iso ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new CardGenerationError("INVALID_REPORT", "Report period has no valid calendar date.");
  }
  return date;
}

function periodPresentation(report) {
  const date = dailyDateLabel(report);
  const startIso = String(report.period?.start_iso ?? "");
  const endIso = String(report.period?.end_iso ?? "");
  const isDaily = Boolean(report.period?.date) && report.period.end_time - report.period.start_time === 86_400;
  const startLabel = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(startIso)
    ? `${startIso.slice(5, 10)} ${startIso.slice(11, 16)}`
    : `${date.slice(5)} 00:00`;
  const endLabel = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(endIso)
    ? `${endIso.slice(5, 10)} ${endIso.slice(11, 16)}`
    : "结束时间 N/A";

  if (isDaily) {
    return {
      title: `AIDEN 主对话性能日报 · ${date}`,
      subtitle: `${date} 全天 · 北京时间`,
      comparison: "昨日同一时间窗口",
    };
  }
  return {
    title: `AIDEN 主对话性能报告 · ${startLabel.slice(0, 5)}–${endLabel.slice(0, 5)}`,
    subtitle: `${startLabel} ~ ${endLabel} · 北京时间`,
    comparison: "前一等长周期使用相同时间窗口",
  };
}

export function buildDashboardUrl(report) {
  const source = report.source ?? {};
  const period = report.period ?? {};
  if (!isFiniteNumber(period.start_time) || !isFiniteNumber(period.end_time)) {
    throw new CardGenerationError("INVALID_REPORT", "Report period must include Unix start_time and end_time.");
  }
  const isCompleteDailyRange = Boolean(period.date) && period.end_time - period.start_time === 86_400;
  const linkOffset = isCompleteDailyRange ? DASHBOARD_DAILY_LINK_OFFSET_SECONDS : 0;
  const dashboardId = source.dashboard_id ?? "591721";
  const url = new URL(`https://slardar.bytedance.net/node/web/kanban/detail/${dashboardId}`);
  url.searchParams.set("env", source.env ?? "production");
  url.searchParams.set("bid", source.bid ?? "super_aiden");
  url.searchParams.set("site_type", source.site_type ?? "web");
  url.searchParams.set("lang", "zh");
  url.searchParams.set("region", source.region ?? "cn");
  url.searchParams.set("start_time", String(period.start_time + linkOffset));
  url.searchParams.set("end_time", String(period.end_time + linkOffset));
  url.searchParams.set("layout", "normal");
  return url.toString();
}

function validDataSummary(report) {
  const indicatorCount = (report.metrics ?? []).filter(isValidMetric).length;
  const seriesCount = (report.slow_apis ?? []).length > 0 ? 1 : 0;
  const pieCount = Object.keys(report.entry_counts ?? {}).length > 0 ? 1 : 0;
  const valid = indicatorCount + seriesCount + pieCount;
  const total = report.source?.item_count ?? report.queries?.length ?? (report.metrics?.length ?? 0) + 2;
  const warningCount = report.warnings?.length ?? 0;
  if (report.report_status === "complete") {
    return { valid, total, warningCount, label: `数据完整 · ${valid}/${total}` };
  }
  return { valid, total, warningCount, label: `部分数据 · ${valid}/${total} · ${warningCount} 告警` };
}

function metricComparisonLine(metric, label) {
  return `- **${label}**：${formatLatency(metric?.value)}（昨日 ${formatLatency(metric?.previous_value)}）｜${ratioMarkup(metric)}`;
}

function slowApiContent(report) {
  const items = (report.slow_apis ?? []).slice(0, 3);
  if (items.length === 0) return "🐢 **慢接口 TOP3**\n- 暂无有效慢接口数据";
  const first = items[0];
  const second = items[1];
  const hasOutlier =
    isFiniteNumber(first?.latest_p90_ms) &&
    isFiniteNumber(second?.latest_p90_ms) &&
    second.latest_p90_ms > 0 &&
    first.latest_p90_ms >= 60_000 &&
    first.latest_p90_ms / second.latest_p90_ms >= 5;
  const lines = [
    "🐢 **慢接口 TOP3**",
    ...items.map((item, index) => {
      const outlier = index === 0 && hasOutlier ? "　<font color='red'>异常候选</font>" : "";
      return `${index + 1}. \`${String(item.path ?? "N/A").replaceAll("`", "&#96;")}\`：${formatLatency(item.latest_p90_ms)}${outlier}`;
    }),
  ];
  if (hasOutlier) {
    lines.push("<font color='grey'>首项显著高于其余接口，建议确认采样口径。</font>");
  }
  return lines.join("\n");
}

function entryCountContent(report) {
  const counts = report.entry_counts ?? {};
  return [
    "🚪 **入口样本数**",
    `任务切换 ${formatCount(counts.task_tab_switch)}｜直接打开 ${formatCount(counts.direct_open)}｜创建任务 ${formatCount(counts.create_task)}`,
    `页面刷新 ${formatCount(counts.page_reload)}｜前进 / 后退 ${formatCount(counts.back_forward)}`,
  ].join("\n");
}

function warningContent(report) {
  const warnings = report.warnings ?? [];
  if (warnings.length === 0) return null;
  return [
    "⚠️ **数据质量**",
    ...warnings.map((warning) => `- ${escapeMarkdownText(warning.code ?? "WARNING")}：${escapeMarkdownText(warning.message ?? "未知采集告警")}`),
  ].join("\n");
}

function groupedBlock(elements, backgroundStyle = "grey-50") {
  return {
    tag: "column_set",
    flex_mode: "none",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        background_style: backgroundStyle,
        padding: "12px",
        vertical_spacing: "8px",
        elements,
      },
    ],
  };
}

function comparisonContent(report) {
  const comparable = (report.metrics ?? []).filter(
    (metric) => isValidMetric(metric) && isFiniteNumber(metric.previous_value) && isFiniteNumber(metric.delta_ratio),
  );
  const regressions = comparable.filter((metric) => metric.delta_ratio > 0).sort((a, b) => b.delta_ratio - a.delta_ratio);
  const improvements = comparable.filter((metric) => metric.delta_ratio < 0).sort((a, b) => a.delta_ratio - b.delta_ratio);
  const stable = comparable.filter((metric) => metric.delta_ratio === 0);
  const lines = ["📈 **环比变化**"];

  if (regressions.length > 0) {
    lines.push(`<font color='red'>▲ ${regressions.length} 项变慢</font>`);
    lines.push(...regressions.map((metric) => metricComparisonLine(metric, COMPARISON_LABELS[metric.key] ?? metric.label)));
  } else {
    lines.push("<font color='green'>今日无变慢指标</font>");
  }

  if (improvements.length > 0) {
    const prefix = regressions.length > 0 ? `其余 ${improvements.length} 项改善` : `${improvements.length} 项改善`;
    const summary = improvements
      .map((metric) => `${COMPARISON_LABELS[metric.key] ?? metric.label} ${(metric.delta_ratio * 100).toFixed(2)}%`)
      .join("｜");
    lines.push(`<font color='green'>▼ ${prefix}</font>：${summary}`);
  }
  if (stable.length > 0) {
    lines.push(`<font color='grey'>${stable.length} 项与昨日持平</font>`);
  }
  if (comparable.length === 0) {
    lines.push("<font color='grey'>暂无有效环比数据</font>");
  }
  return lines.join("\n");
}

function validateReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new CardGenerationError("INVALID_REPORT", "Normalized report must be an object.");
  }
  if (report.schema_version !== "1.0") {
    throw new CardGenerationError("INVALID_REPORT", `Unsupported report schema: ${report.schema_version ?? "missing"}.`);
  }
  if (!Array.isArray(report.metrics) || !report.period || !report.source) {
    throw new CardGenerationError("INVALID_REPORT", "Normalized report is missing metrics, period, or source.");
  }
  if (!new Set(["complete", "partial"]).has(report.report_status)) {
    throw new CardGenerationError("INVALID_REPORT", `Unsupported report status: ${report.report_status ?? "missing"}.`);
  }
}

export function renderPerformanceCard(report) {
  validateReport(report);
  const metrics = metricMap(report);
  const attention = selectAttentionMetric(report.metrics);
  const attentionMetric = attention.metric;
  const isComplete = report.report_status === "complete";
  const presentation = periodPresentation(report);
  const attentionName = attentionMetric ? METRIC_LABELS[attentionMetric.key] ?? attentionMetric.label : "暂无有效指标";
  const attentionValue = formatLatency(attentionMetric?.value);
  const dataSummary = validDataSummary(report);
  const isRegression = isValidMetric(attentionMetric) && isFiniteNumber(attentionMetric.delta_ratio) && attentionMetric.delta_ratio > 0;
  const focusColor = isRegression ? "red" : isValidMetric(attentionMetric) ? "green" : "grey";
  const focusBackground = isRegression ? "red-50" : isValidMetric(attentionMetric) ? "green-50" : "grey-50";
  const attentionPrevious = isFiniteNumber(attentionMetric?.previous_value)
    ? `昨日 ${formatLatency(attentionMetric.previous_value)}　`
    : "";

  const overviewContent = [
    "📊 **今日概览**",
    `**首页**　输入框可交互 ${formatLatency(metrics.get("composer_ready_p90")?.value)}｜LCP ${formatLatency(metrics.get("lcp_p90")?.value)}｜FCP ${formatLatency(metrics.get("fcp_p90")?.value)}`,
    `**创建任务**　首Token ${formatLatency(metrics.get("create_ttfb_p90")?.value)}｜首消息 ${formatLatency(metrics.get("create_ttfm_p90")?.value)}`,
    `**任务恢复**　切换首消息 ${formatLatency(metrics.get("switch_ttfm_p90")?.value)}｜跳转 / 刷新首消息 ${formatLatency(metrics.get("navigation_ttfm_p90")?.value)}`,
    `**Web Vitals**　${webVitalNote(metrics.get("lcp_p90"), metrics.get("fcp_p90"))}`,
  ].join("\n");

  const warning = warningContent(report);
  const elements = [
    groupedBlock(
      [
        markdown(`<font color='${focusColor}'>**今日关注 · ${attention.caption}**</font>`),
        markdown(`## <font color='${focusColor}'>${attentionValue}</font>`),
        markdown(`**${attentionName}**\n<font color='grey'>${attentionPrevious}</font>${ratioMarkup(attentionMetric)}`),
      ],
      focusBackground,
    ),
    groupedBlock([markdown(overviewContent), { tag: "hr" }, markdown(comparisonContent(report))]),
    groupedBlock([markdown(slowApiContent(report)), { tag: "hr" }, markdown(entryCountContent(report))]),
  ];
  if (warning) elements.push(groupedBlock([markdown(warning)], "yellow-50"));
  elements.push({
    tag: "button",
    text: plainText("查看本期 Slardar 看板"),
    type: "primary_filled",
    size: "medium",
    width: "fill",
    behaviors: [{ type: "open_url", default_url: buildDashboardUrl(report) }],
  });

  const card = {
    schema: "2.0",
    config: {
      enable_forward_interaction: false,
      streaming_mode: false,
      width_mode: "default",
    },
    header: {
      title: plainText(presentation.title),
      subtitle: plainText(presentation.subtitle),
      template: "blue",
      icon: { tag: "standard_icon", token: "chart_colorful" },
      text_tag_list: [
        {
          tag: "text_tag",
          text: plainText(dataSummary.label),
          color: isComplete ? "green" : "yellow",
        },
      ],
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 20px 12px",
      vertical_spacing: "12px",
      elements,
    },
  };

  return card;
}

async function readReportFile(reportPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path.resolve(reportPath), "utf8"));
  } catch (error) {
    throw new CardGenerationError("REPORT_READ_FAILED", `Unable to read report JSON: ${error.message}`);
  }
  if (parsed?.status === "error") {
    throw new CardGenerationError(parsed.error?.code ?? "REPORT_ERROR", parsed.error?.message ?? "Report collection failed.");
  }
  return parsed?.status === "success" ? parsed.data : parsed;
}

export async function generateFeishuCard(options, dependencies = {}) {
  let report;
  if (options.reportPath) {
    report = await readReportFile(options.reportPath);
  } else {
    const collectorArgv = [];
    if (options.date) collectorArgv.push("--date", options.date);
    if (options.startTime !== undefined) {
      collectorArgv.push("--start-time", String(options.startTime), "--end-time", String(options.endTime));
    }
    if (options.compareShift !== undefined) collectorArgv.push("--compare-shift", String(options.compareShift));
    if (options.env) collectorArgv.push("--env", options.env);
    if (options.allowPartial) collectorArgv.push("--allow-partial");
    collectorArgv.push("--timeout-ms", String(options.timeoutMs));
    const collectorOptions = parseCollectorArgs(collectorArgv);
    const collector = dependencies.collector ?? collectReport;
    report = await collector(collectorOptions, dependencies.collectorDependencies);
  }
  return { report, card: renderPerformanceCard(report) };
}

async function writeCard(outputPath, card, { force, pretty }) {
  const absolutePath = path.resolve(outputPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  try {
    await writeFile(absolutePath, `${JSON.stringify(card, null, pretty ? 2 : 0)}\n`, {
      encoding: "utf8",
      flag: force ? "w" : "wx",
    });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new CardGenerationError("OUTPUT_EXISTS", `Output already exists: ${absolutePath}. Pass --force to replace it.`);
    }
    throw error;
  }
  return absolutePath;
}

async function assertOutputAvailable(outputPath, force) {
  if (!outputPath || force) return;
  const absolutePath = path.resolve(outputPath);
  try {
    await access(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new CardGenerationError("OUTPUT_EXISTS", `Output already exists: ${absolutePath}. Pass --force to replace it.`);
}

function errorEnvelope(error) {
  return {
    status: "error",
    data: null,
    error: {
      code: error.code ?? "UNEXPECTED_ERROR",
      message: error.message ?? String(error),
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(usage());
      return;
    }
    await assertOutputAvailable(options.outputPath, options.force);
    const { report, card } = await generateFeishuCard(options);
    if (!options.outputPath) {
      process.stdout.write(`${JSON.stringify(card, null, options.pretty ? 2 : 0)}\n`);
      return;
    }
    const outputPath = await writeCard(options.outputPath, card, options);
    process.stdout.write(`${JSON.stringify({
      status: "success",
      data: {
        output_path: outputPath,
        report_status: report.report_status,
        period: report.period,
        warnings: report.warnings ?? [],
      },
      error: null,
    }, null, options.pretty ? 2 : 0)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(errorEnvelope(error), null, options?.pretty ? 2 : 0)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
