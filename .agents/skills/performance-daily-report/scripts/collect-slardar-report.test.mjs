import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQueryRequest,
  normalizeIndicator,
  normalizePie,
  normalizeSeries,
  parseArgs,
  ReportError,
  resolvePeriod,
} from "./collect-slardar-report.mjs";

test("resolves one Shanghai calendar day to exact Unix boundaries", () => {
  const period = resolvePeriod({ date: "2026-07-30" });
  assert.equal(period.start_time, 1785340800);
  assert.equal(period.end_time, 1785427200);
  assert.equal(period.comparison_shift_seconds, 86400);
  assert.equal(period.start_iso, "2026-07-30T00:00:00.000+08:00");
});

test("defaults to the previous complete Shanghai day", () => {
  const period = resolvePeriod({}, new Date("2026-07-31T05:00:00.000Z"));
  assert.equal(period.date, "2026-07-30");
  assert.equal(period.start_time, 1785340800);
});

test("rejects Slardar_All instead of silently returning invalid Flex data", () => {
  assert.throws(
    () => parseArgs(["--env", "Slardar_All"]),
    (error) => error instanceof ReportError && error.code === "UNSUPPORTED_ALL_ENV",
  );
});

test("builds a comparison request from the selected period", () => {
  const request = buildQueryRequest(
    {
      chart: "indicator_card",
      measure_list: [{ name: "metric" }],
      filter_list: [],
      cond_settings: { exclude_null: "true" },
    },
    {
      start_time: 100,
      end_time: 200,
      comparison_shift_seconds: 100,
    },
  );
  assert.deepEqual(request.time_shift_list, [{ time_shift: 100 }]);
  assert.equal(request.start_time, 100);
  assert.equal(request.end_time, 200);
});

test("normalizes valid indicator data and does not turn invalid data into zero", () => {
  const item = {
    id: "metric-id",
    title: "首页输入框可交互 P90",
    config: {
      measure_list: [{ name: "sdma_web_home_composer_ready", unit: { unit: "" } }],
    },
  };
  const valid = normalizeIndicator(item, {
    data: {
      items: [{
        data: 2859.9,
        data_validity: true,
        time_shift_indicator_cards: [{ data_delta: -0.0372, item: { data: 2970.4, data_validity: true } }],
      }],
    },
  });
  assert.equal(valid.key, "composer_ready_p90");
  assert.equal(valid.unit, "ms");
  assert.equal(valid.value, 2859.9);
  assert.equal(valid.previous_value, 2970.4);
  assert.equal(valid.delta_ratio, -0.0372);

  const invalid = normalizeIndicator(item, {
    data: { items: [{ data: 0, data_validity: false }] },
  });
  assert.equal(invalid.value, null);
  assert.equal(invalid.valid, false);
});

test("sorts series by the latest valid P90 point", () => {
  const rows = normalizeSeries({
    data: {
      xAxis: [10, 20, 30],
      series: [
        {
          name: "request /a",
          data: [100, 200, 300],
          data_validity: [true, true, true],
          group_by_values: [{ label: "/a" }],
          avg: 200,
        },
        {
          name: "request /b",
          data: [400, 500, 250],
          data_validity: [true, true, true],
          group_by_values: [{ label: "/b" }],
          avg: 383.33,
        },
      ],
    },
  });
  assert.deepEqual(rows.map((row) => row.path), ["/a", "/b"]);
  assert.equal(rows[0].latest_timestamp, 30);
  assert.equal(rows[0].maximum_daily_p90_ms, 300);
});

test("normalizes pie values by entry type", () => {
  const counts = normalizePie({
    data: {
      items: [
        { data: 2618, data_validity: true, group_by_values: [{ label: "create_task" }] },
        { data: 0, data_validity: false, group_by_values: [{ label: "invalid" }] },
      ],
    },
  });
  assert.deepEqual(counts, { create_task: 2618 });
});
