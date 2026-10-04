/**
 * `/performance` query state: which tab, which Resources section, which
 * overview metric.
 *
 * The tabs used to be uncontrolled (`defaultValue`), so every entry point
 * landed on Overview: the status-bar capture chip's "Open" took you away from
 * the capture you were recording, and a link could not point at Processes.
 * The page writes these params with `history.replaceState` — the static export
 * must not re-evaluate the route, the same rule `/logs` follows.
 */

import { isPerfMetricId, type PerfMetricId } from "./metric-catalog"

export const PERF_DASHBOARD_TABS = ["overview", "diagnose", "resources", "captures"] as const
export type PerfDashboardTab = (typeof PERF_DASHBOARD_TABS)[number]

export const PERF_RESOURCE_SECTIONS = ["processes", "runtime", "managed", "system"] as const
export type PerfResourceSection = (typeof PERF_RESOURCE_SECTIONS)[number]

export interface PerfDashboardUrlState {
  tab: PerfDashboardTab
  resource: PerfResourceSection
  metric: PerfMetricId | null
}

export const PERF_TAB_PARAM = "tab"
export const PERF_RESOURCE_PARAM = "resource"
export const PERF_METRIC_PARAM = "metric"

export const DEFAULT_PERF_DASHBOARD_STATE: PerfDashboardUrlState = {
  tab: "overview",
  resource: "processes",
  metric: null,
}

function isTab(value: string | null | undefined): value is PerfDashboardTab {
  return (PERF_DASHBOARD_TABS as readonly string[]).includes(value ?? "")
}

function isResource(value: string | null | undefined): value is PerfResourceSection {
  return (PERF_RESOURCE_SECTIONS as readonly string[]).includes(value ?? "")
}

/** Unknown values fall back to defaults rather than rendering an empty tab. */
export function parsePerfDashboardParams(
  params: Pick<URLSearchParams, "get"> | null | undefined
): PerfDashboardUrlState {
  const tab = params?.get(PERF_TAB_PARAM)
  const resource = params?.get(PERF_RESOURCE_PARAM)
  const metric = params?.get(PERF_METRIC_PARAM)
  return {
    tab: isTab(tab) ? tab : DEFAULT_PERF_DASHBOARD_STATE.tab,
    resource: isResource(resource) ? resource : DEFAULT_PERF_DASHBOARD_STATE.resource,
    metric: metric && isPerfMetricId(metric) ? metric : null,
  }
}

/**
 * Merge `state` into `search`, dropping params that hold their default so a
 * plain `/performance` stays plain. Params this page does not own survive.
 */
export function mergePerfDashboardParams(
  search: string,
  state: Partial<PerfDashboardUrlState>
): string {
  const params = new URLSearchParams(search)
  if (state.tab !== undefined) {
    if (state.tab === DEFAULT_PERF_DASHBOARD_STATE.tab) params.delete(PERF_TAB_PARAM)
    else params.set(PERF_TAB_PARAM, state.tab)
  }
  if (state.resource !== undefined) {
    if (state.resource === DEFAULT_PERF_DASHBOARD_STATE.resource) params.delete(PERF_RESOURCE_PARAM)
    else params.set(PERF_RESOURCE_PARAM, state.resource)
  }
  if (state.metric !== undefined) {
    if (state.metric === null) params.delete(PERF_METRIC_PARAM)
    else params.set(PERF_METRIC_PARAM, state.metric)
  }
  return params.toString()
}

/** Build a link into the dashboard, e.g. `perfDashboardHref({ tab: "captures" })`. */
export function perfDashboardHref(state: Partial<PerfDashboardUrlState> = {}): string {
  const query = mergePerfDashboardParams("", state)
  return query ? `/performance?${query}` : "/performance"
}

/**
 * Write the dashboard's params in place without a navigation. Returns the
 * resulting query string (without `?`), or `null` outside a browser.
 */
export function writePerfDashboardParams(state: Partial<PerfDashboardUrlState>): string | null {
  if (typeof window === "undefined") return null
  const query = mergePerfDashboardParams(window.location.search, state)
  try {
    window.history.replaceState(
      window.history.state,
      "",
      query ? `${window.location.pathname}?${query}` : window.location.pathname
    )
  } catch {
    // Sandboxed contexts can refuse history writes; component state still drives the UI.
  }
  return query
}
