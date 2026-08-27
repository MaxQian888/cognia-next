/**
 * Logging Hooks
 *
 * React hooks for log streaming and management
 */

export {
  useLogStream,
  useLogModules,
  type LogStreamOptions,
  type LogStreamResult,
} from "./use-log-stream"
export {
  useAgentTraceAsLogs,
  type UseAgentTraceLogsOptions,
  type UseAgentTraceLogsReturn,
} from "./use-agent-trace-logs"
export {
  useTransportHealth,
  type UseTransportHealthOptions,
  type UseTransportHealthResult,
} from "./use-transport-health"
export {
  useLogPanelFilters,
  type LogPanelFilterState,
  type UseLogPanelFiltersOptions,
  type ViewMode,
  type PanelSource,
} from "./use-log-panel-filters"
export { useCrashLogs, type UseCrashLogsResult } from "./use-crash-logs"
export { useRecentErrorLogs } from "./use-recent-error-logs"
export {
  useTraceList,
  TRACE_PAGE_SIZE,
  type UseTraceListOptions,
  type UseTraceListResult,
} from "./use-trace-list"
export {
  useThemeColors,
  DEFAULT_THEME_COLORS,
  THEME_KEYS,
  type ThemeColors,
} from "./use-theme-colors"
