export {
  useMcpPanelView,
  isMcpPanelView,
  isMcpPanelGroupBy,
  DEFAULT_MCP_PANEL_PREFS,
  type McpPanelView,
  type McpPanelGroupBy,
  type McpPanelPrefs,
  type UseMcpPanelView,
} from "./use-mcp-panel-view"

// `use-mcp-server-tools` is deliberately NOT re-exported here. It pulls in the
// runtime gateway and the sidecar feature-call module, and this barrel is
// imported by every MCP surface — including ones that only want the view
// preferences. Import it from its own path.
