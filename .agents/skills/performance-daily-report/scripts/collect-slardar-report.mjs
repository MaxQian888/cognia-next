#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

export const DEFAULT_DASHBOARD_URL =
  "https://slardar.bytedance.net/node/web/kanban/detail/591721?env=Slardar_All&bid=super_aiden&site_type=web&lang=zh&region=cn";
export const DEFAULT_ENV = "production";
export const REPORT_SCHEMA_VERSION = "1.0";
export const REPORT_TIME_ZONE = "Asia/Shanghai";

const DAY_SECONDS = 86_400;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RANGE_SECONDS = 31 * DAY_SECONDS;

const TITLE_KEYS = new Map([
  ["首页 LCP P90", "lcp_p90"],
  ["首页 FCP P90", "fcp_p90"],
  ["首页输入框可交互 P90", "composer_ready_p90"],
  ["创建任务 - 模型返回首字节耗时（90分位）", "create_ttfb_p90"],
  ["创建任务 - 首消息出现耗时（90分位）", "create_ttfm_p90"],
  ["切换任务 - 首消息出现耗时（90分位）", "switch_ttfm_p90"],
  ["跳转与刷新任务 - 首消息出现耗时（90分位）", "navigation_ttfm_p90"],
]);

const REQUIRED_INDICATOR_KEYS = new Set(TITLE_KEYS.values());

export class ReportError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ReportError";
    this.code = code;
    this.details = details;
  }
}

function usage() {
  return `Usage: collect-slardar-report.mjs [options]

Options:
  --dashboard-url <url>  Slardar dashboard URL (default: dashboard 591721)
  --date <YYYY-MM-DD>    One complete Asia/Shanghai calendar day
  --start-time <unix>    Custom range start in Unix seconds
  --end-time <unix>      Custom range end in Unix seconds
  --compare-shift <sec>  Comparison shift (default: range duration)
  --env <env>            Slardar application environment (default: production)
  --concurrency <n>      Concurrent Flex queries, 1-6 (default: 3)
  --timeout-ms <ms>      Timeout per bytedcli call (default: 30000)
  --allow-partial        Continue when an individual chart query fails
  --pretty               Pretty-print the JSON envelope
  --help                 Show this help
`;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new ReportError("INVALID_ARGUMENT", `${flag} requires a value.`);
  }
  return value;
}

function parseInteger(value, flag, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!/^-?\d+$/.test(String(value))) {
    throw new ReportError("INVALID_ARGUMENT", `${flag} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ReportError("INVALID_ARGUMENT", `${flag} is outside the supported range.`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const options = {
    dashboardUrl: DEFAULT_DASHBOARD_URL,
    env: DEFAULT_ENV,
    concurrency: DEFAULT_CONCURRENCY,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    allowPartial: false,
    pretty: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--dashboard-url":
        options.dashboardUrl = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--date":
        options.date = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--start-time":
        options.startTime = parseInteger(requireValue(argv, index, arg), arg, { min: 0 });
        index += 1;
        break;
      case "--end-time":
        options.endTime = parseInteger(requireValue(argv, index, arg), arg, { min: 1 });
        index += 1;
        break;
      case "--compare-shift":
        options.compareShift = parseInteger(requireValue(argv, index, arg), arg, { min: 1 });
        index += 1;
        break;
      case "--env":
        options.env = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--concurrency":
        options.concurrency = parseInteger(requireValue(argv, index, arg), arg, { min: 1, max: 6 });
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = parseInteger(requireValue(argv, index, arg), arg, { min: 1_000, max: 300_000 });
        index += 1;
        break;
      case "--allow-partial":
        options.allowPartial = true;
        break;
      case "--pretty":
        options.pretty = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new ReportError("INVALID_ARGUMENT", `Unknown option: ${arg}`);
    }
  }

  if (options.date && (options.startTime !== undefined || options.endTime !== undefined)) {
    throw new ReportError("INVALID_ARGUMENT", "Use --date or --start-time/--end-time, not both.");
  }
  if ((options.startTime === undefined) !== (options.endTime === undefined)) {
    throw new ReportError("INVALID_ARGUMENT", "--start-time and --end-time must be provided together.");
  }
  if (!options.env.trim()) {
    throw new ReportError("INVALID_ARGUMENT", "--env must not be empty.");
  }
  if (options.env.trim().toLowerCase() === "slardar_all") {
    throw new ReportError(
      "UNSUPPORTED_ALL_ENV",
      "Slardar_All is not a valid Flex query environment in the current bytedcli contract. Use production or an explicit application environment.",
    );
  }

  return options;
}

function datePartsInShanghai(now) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: REPORT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function validateDateLabel(dateLabel) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateLabel);
  if (!match) {
    throw new ReportError("INVALID_DATE", "--date must use YYYY-MM-DD.");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new ReportError("INVALID_DATE", `Invalid calendar date: ${dateLabel}`);
  }
  return { year, month, day };
}

function previousShanghaiDate(now) {
  const parts = datePartsInShanghai(now);
  const todayUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const previous = new Date(todayUtc - DAY_SECONDS * 1_000);
  return [
    previous.getUTCFullYear(),
    String(previous.getUTCMonth() + 1).padStart(2, "0"),
    String(previous.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function shanghaiDateStart(dateLabel) {
  validateDateLabel(dateLabel);
  return Math.floor(Date.parse(`${dateLabel}T00:00:00+08:00`) / 1_000);
}

function formatShanghaiTimestamp(unixSeconds) {
  const shifted = new Date((unixSeconds + 8 * 3_600) * 1_000);
  return shifted.toISOString().replace("Z", "+08:00");
}

export function resolvePeriod(options, now = new Date()) {
  let startTime;
  let endTime;
  let date = null;

  if (options.startTime !== undefined) {
    startTime = options.startTime;
    endTime = options.endTime;
  } else {
    date = options.date ?? previousShanghaiDate(now);
    startTime = shanghaiDateStart(date);
    endTime = startTime + DAY_SECONDS;
  }

  const duration = endTime - startTime;
  if (duration <= 0) {
    throw new ReportError("INVALID_RANGE", "end_time must be greater than start_time.");
  }
  if (duration > MAX_RANGE_SECONDS) {
    throw new ReportError("INVALID_RANGE", "The report range must not exceed 31 days.");
  }

  return {
    date,
    start_time: startTime,
    end_time: endTime,
    start_iso: formatShanghaiTimestamp(startTime),
    end_iso: formatShanghaiTimestamp(endTime),
    time_zone: REPORT_TIME_ZONE,
    comparison_shift_seconds: options.compareShift ?? duration,
  };
}

function parseJsonOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) {
    throw new ReportError("BYTEDCLI_EMPTY_OUTPUT", "bytedcli returned no JSON output.");
  }
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
    for (const line of lines) {
      try {
        return JSON.parse(line);
      } catch {
        // Continue looking for the final JSON envelope.
      }
    }
  }
  throw new ReportError("BYTEDCLI_INVALID_JSON", "bytedcli output was not valid JSON.");
}

function upstreamError(envelope) {
  const source = envelope?.error;
  if (!source) return "Unknown bytedcli error.";
  if (typeof source === "string") return source;
  return source.message || source.hint || source.code || "Unknown bytedcli error.";
}

export async function runBytedcliJson(args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cliArgs = ["--json", "--no-color", "--no-auto-upgrade", ...args];
  let stdout = "";
  try {
    const result = await execFileAsync("bytedcli", cliArgs, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        BYTEDCLI_NO_AUTO_UPGRADE: "1",
        NO_COLOR: "1",
      },
    });
    stdout = result.stdout;
  } catch (error) {
    stdout = error.stdout ?? "";
    let envelope;
    try {
      envelope = parseJsonOutput(stdout);
    } catch {
      envelope = undefined;
    }
    throw new ReportError(
      error.code === "ENOENT" ? "BYTEDCLI_NOT_FOUND" : error.killed ? "BYTEDCLI_TIMEOUT" : "BYTEDCLI_FAILED",
      envelope ? upstreamError(envelope) : "bytedcli failed. Check installation, authentication, and network access.",
      envelope?.error ? { upstream: envelope.error } : undefined,
    );
  }

  const envelope = parseJsonOutput(stdout);
  if (envelope.status !== "success") {
    throw new ReportError("BYTEDCLI_FAILED", upstreamError(envelope), { upstream: envelope.error });
  }
  return envelope;
}

function parseDashboardEnvelope(envelope) {
  const summary = envelope?.data;
  const rawEnvelope = summary?.raw;
  if (!summary || !rawEnvelope || rawEnvelope.errno !== 200 || !rawEnvelope.data) {
    throw new ReportError("DASHBOARD_INVALID", "Dashboard response is missing a successful raw payload.");
  }
  const dashboard = rawEnvelope.data;
  if (!Array.isArray(dashboard.items)) {
    throw new ReportError("DASHBOARD_INVALID", "Dashboard items are missing.");
  }
  const items = dashboard.items.map((item) => {
    let config;
    try {
      config = typeof item.data === "string" ? JSON.parse(item.data) : item.data;
    } catch {
      throw new ReportError("DASHBOARD_ITEM_INVALID", `Dashboard item ${item.id ?? item.title ?? "unknown"} has invalid JSON data.`);
    }
    return {
      id: item.id,
      title: item.title,
      config,
    };
  });
  return {
    id: String(dashboard.id ?? summary.dashboardId),
    name: dashboard.name ?? summary.name,
    origin: summary.origin,
    bid: summary.bid,
    siteType: summary.siteType,
    region: summary.region,
    lang: summary.lang,
    items,
  };
}

export function buildQueryRequest(config, period) {
  const request = {
    start_time: period.start_time,
    end_time: period.end_time,
    measure_list: Array.isArray(config.measure_list) ? config.measure_list : [],
    filter_list: Array.isArray(config.filter_list) ? config.filter_list : [],
    cond_settings: config.cond_settings ?? { exclude_null: "false" },
  };

  if (config.chart === "indicator_card") {
    request.time_shift_list = [{ time_shift: period.comparison_shift_seconds }];
  } else {
    request.time_shift_list = Array.isArray(config.time_shift_list) ? config.time_shift_list : [];
  }
  if (Array.isArray(config.group_by_list)) request.group_by_list = config.group_by_list;
  if (config.granularity) request.granularity = String(config.granularity);
  if (config.need_time_rollup !== undefined) request.need_time_rollup = Boolean(config.need_time_rollup);
  if (config.topn) request.topn = config.topn;
  if (config.long_term_options) request.long_term_options = config.long_term_options;
  return request;
}

function chartCommand(chart) {
  if (chart === "indicator_card") return "indicator-card";
  if (chart === "line") return "series";
  if (chart === "pie") return "pie";
  return null;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstFinite(...values) {
  for (const value of values) {
    const parsed = finiteNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function metricUnit(item) {
  const measure = item.config.measure_list?.[0];
  const declared = measure?.unit?.unit;
  const text = `${item.title} ${measure?.name ?? ""} ${measure?.raw_measure_list?.[0]?.measure_name ?? ""}`.toLowerCase();
  if (declared === "ms" || /lcp|fcp|duration_ms|composer_ready/.test(text)) return "ms";
  return declared || "number";
}

export function normalizeIndicator(item, queryData) {
  const source = queryData?.data?.items?.[0];
  const rawValue = firstFinite(source?.data, source?.value);
  const valid = source?.data_validity !== false && rawValue !== null;
  const shift = source?.time_shift_indicator_cards?.[0];
  const rawPrevious = firstFinite(shift?.item?.data, shift?.item?.value);
  const previousValid = shift?.item?.data_validity !== false && rawPrevious !== null;
  let deltaRatio = firstFinite(shift?.data_delta);
  if (deltaRatio === null && valid && previousValid && rawPrevious !== 0) {
    deltaRatio = rawValue / rawPrevious - 1;
  }
  return {
    key: TITLE_KEYS.get(item.title) ?? `indicator_${item.id}`,
    label: item.title,
    unit: metricUnit(item),
    value: valid ? rawValue : null,
    previous_value: previousValid ? rawPrevious : null,
    delta_ratio: valid ? deltaRatio : null,
    valid,
  };
}

function groupLabel(source) {
  const group = source?.group_by_values?.[0] ?? source?.group_values?.[0];
  if (typeof group === "string") return group;
  if (group && typeof group === "object") return group.label ?? group.value ?? "";
  return "";
}

export function normalizeSeries(queryData) {
  const xAxis = queryData?.data?.xAxis ?? queryData?.data?.x_axis ?? [];
  const rows = [];
  for (const series of queryData?.data?.series ?? []) {
    const points = Array.isArray(series.data) ? series.data : Array.isArray(series.source) ? series.source : [];
    const validity = Array.isArray(series.data_validity) ? series.data_validity : [];
    let latestIndex = -1;
    for (let index = points.length - 1; index >= 0; index -= 1) {
      if (finiteNumber(points[index]) !== null && validity[index] !== false) {
        latestIndex = index;
        break;
      }
    }
    if (latestIndex < 0) continue;
    const validPoints = points.filter((point, index) => finiteNumber(point) !== null && validity[index] !== false);
    rows.push({
      path: groupLabel(series) || series.name || "unknown",
      latest_p90_ms: points[latestIndex],
      latest_timestamp: finiteNumber(xAxis[latestIndex]),
      average_daily_p90_ms: firstFinite(series.avg) ?? validPoints.reduce((sum, point) => sum + point, 0) / validPoints.length,
      maximum_daily_p90_ms: Math.max(...validPoints),
      points: validPoints.length,
    });
  }
  return rows.sort((left, right) => right.latest_p90_ms - left.latest_p90_ms);
}

export function normalizePie(queryData) {
  const counts = {};
  for (const item of queryData?.data?.items ?? []) {
    const label = groupLabel(item) || item.name || "unknown";
    const value = firstFinite(item.data, item.value);
    if (value !== null && item.data_validity !== false) counts[label] = value;
  }
  return counts;
}

async function mapWithConcurrency(values, concurrency, worker) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function runWorker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => runWorker()));
  return results;
}

async function queryDashboardItem(item, context) {
  const command = chartCommand(item.config.chart);
  if (!command) {
    return { item, skipped: true, warning: `Unsupported chart type '${item.config.chart}' for '${item.title}'.` };
  }
  const request = buildQueryRequest(item.config, context.period);
  const args = [
    "slardar", "web", "flex", "query", command,
    "--origin", context.dashboard.origin,
    "--bid", context.dashboard.bid,
    "--env", context.env,
    "--site-type", context.dashboard.siteType,
    "--region", context.dashboard.region,
    "--lang", context.dashboard.lang,
    "--request-json", JSON.stringify(request),
  ];

  let lastPending;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const envelope = await context.runner(args, { timeoutMs: context.timeoutMs });
    if (!envelope.data?.isAsyncPending) {
      return { item, command, request, queryData: envelope.data, attempts: attempt };
    }
    lastPending = envelope.data;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** (attempt - 1)));
  }
  throw new ReportError("QUERY_PENDING", `Query remained pending for '${item.title}'.`, {
    item_id: item.id,
    async_info: lastPending?.asyncInfo,
  });
}

function warning(code, message, details = undefined) {
  return { code, message, ...(details ? { details } : {}) };
}

export async function collectReport(options, dependencies = {}) {
  const runner = dependencies.runner ?? runBytedcliJson;
  const now = dependencies.now ?? new Date();
  const period = resolvePeriod(options, now);
  const dashboardEnvelope = await runner(
    ["slardar", "web", "dashboard", "get", "--url", options.dashboardUrl, "--with-raw"],
    { timeoutMs: options.timeoutMs },
  );
  const dashboard = parseDashboardEnvelope(dashboardEnvelope);
  const warnings = [];
  const queryContext = {
    runner,
    period,
    dashboard,
    env: options.env,
    timeoutMs: options.timeoutMs,
  };

  const results = await mapWithConcurrency(dashboard.items, options.concurrency, async (item) => {
    try {
      return await queryDashboardItem(item, queryContext);
    } catch (error) {
      if (!options.allowPartial) throw error;
      return {
        item,
        error,
        warning: `Failed to query '${item.title}': ${error.message}`,
      };
    }
  });

  const metrics = [];
  let slowApis = [];
  let entryCounts = {};
  const queries = [];

  for (const result of results) {
    if (result.warning) {
      warnings.push(warning(result.error ? "QUERY_FAILED" : "QUERY_SKIPPED", result.warning, { item_id: result.item.id }));
    }
    if (!result.queryData) {
      queries.push({ item_id: result.item.id, title: result.item.title, chart: result.item.config.chart, status: result.skipped ? "skipped" : "error" });
      continue;
    }
    queries.push({
      item_id: result.item.id,
      title: result.item.title,
      chart: result.item.config.chart,
      status: "success",
      attempts: result.attempts,
    });
    if (result.item.config.chart === "indicator_card") {
      const metric = normalizeIndicator(result.item, result.queryData);
      metrics.push(metric);
      if (!metric.valid) {
        warnings.push(warning("INVALID_METRIC", `${metric.label} returned no valid data.`, { key: metric.key }));
      }
    } else if (result.item.config.chart === "line") {
      slowApis = normalizeSeries(result.queryData).slice(0, 3);
    } else if (result.item.config.chart === "pie") {
      entryCounts = normalizePie(result.queryData);
    }
  }

  const observedKeys = new Set(metrics.map((metric) => metric.key));
  for (const requiredKey of REQUIRED_INDICATOR_KEYS) {
    if (!observedKeys.has(requiredKey)) {
      warnings.push(warning("MISSING_METRIC", `Required metric '${requiredKey}' is missing from the dashboard.`));
    }
  }

  return {
    schema_version: REPORT_SCHEMA_VERSION,
    report_status: warnings.length > 0 ? "partial" : "complete",
    generated_at: now.toISOString(),
    source: {
      type: "slardar",
      collector: "bytedcli",
      dashboard_id: dashboard.id,
      dashboard_name: dashboard.name,
      dashboard_url: options.dashboardUrl,
      bid: dashboard.bid,
      env: options.env,
      site_type: dashboard.siteType,
      region: dashboard.region,
      item_count: dashboard.items.length,
    },
    period,
    metrics,
    slow_apis: slowApis,
    entry_counts: entryCounts,
    queries,
    warnings,
  };
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
    const data = await collectReport(options);
    process.stdout.write(`${JSON.stringify({ status: "success", data, error: null }, null, options.pretty ? 2 : 0)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(errorEnvelope(error), null, options?.pretty ? 2 : 0)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
