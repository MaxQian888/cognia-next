import type { BootCapability } from "./capabilities"

const ROUTE_PREFIXES: ReadonlyArray<readonly [string, BootCapability]> = [
  ["/plugins", "plugin-runtime"],
  ["/me/plugins", "plugin-runtime"],
  ["/workflows", "workflow-automation"],
  ["/scheduler", "workflow-automation"],
  ["/goals", "workflow-automation"],
  ["/a2ui", "workflow-automation"],
  ["/integrations", "integrations"],
  ["/inbox", "integrations"],
  ["/lark", "integrations"],
  ["/servers", "integrations"],
  ["/devices", "integrations"],
  ["/me/connectors", "integrations"],
  ["/me/mcp", "integrations"],
  ["/memory", "knowledge-agents"],
  ["/twin", "knowledge-agents"],
  ["/squads", "knowledge-agents"],
  ["/squads", "desktop-tools"],
  ["/agent-teams", "knowledge-agents"],
  ["/agent-teams", "desktop-tools"],
  ["/templates", "knowledge-agents"],
  ["/skills", "knowledge-agents"],
  ["/skills", "desktop-tools"],
  ["/me/memory-settings", "knowledge-agents"],
  ["/me/agent-teams-settings", "knowledge-agents"],
  ["/me/ocr", "knowledge-agents"],
  ["/me/subagents", "knowledge-agents"],
  ["/me/teams", "knowledge-agents"],
  ["/me/scheduler", "workflow-automation"],
  ["/me/workflows-settings", "workflow-automation"],
  ["/me/a2ui", "workflow-automation"],
  ["/browser", "desktop-tools"],
  ["/source-control", "desktop-tools"],
  ["/remote-sessions", "desktop-tools"],
  ["/fleet", "desktop-tools"],
  ["/selection-toolbar", "desktop-tools"],
  ["/tray-panel", "desktop-tools"],
  ["/island", "desktop-tools"],
  ["/me/terminal", "desktop-tools"],
  ["/me/computer-use", "desktop-tools"],
  ["/me/command-history", "desktop-tools"],
  ["/me/external-agents", "desktop-tools"],
]

const SETTINGS_CAPABILITIES: Readonly<Record<string, BootCapability>> = {
  desktop: "desktop-tools",
  plugins: "plugin-runtime",
  workflows: "workflow-automation",
  scheduler: "workflow-automation",
  automation: "workflow-automation",
  integrations: "integrations",
  connectors: "integrations",
  mcp: "integrations",
  memory: "knowledge-agents",
  twin: "knowledge-agents",
  squads: "knowledge-agents",
  "agent-teams": "knowledge-agents",
  characters: "knowledge-agents",
  skills: "knowledge-agents",
  ocr: "knowledge-agents",
  a2ui: "workflow-automation",
  terminal: "desktop-tools",
  "computer-use": "desktop-tools",
  "agent-runtime": "desktop-tools",
  "external-agents": "desktop-tools",
}

export function resolveRouteBootCapabilities(pathname: string, search = ""): BootCapability[] {
  const capabilities = new Set<BootCapability>()
  for (const [prefix, capability] of ROUTE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) capabilities.add(capability)
  }
  if (pathname === "/settings") {
    const section = new URLSearchParams(search).get("section")
    if (section && SETTINGS_CAPABILITIES[section]) {
      capabilities.add(SETTINGS_CAPABILITIES[section])
      if (section === "skills") capabilities.add("desktop-tools")
    }
  }
  return [...capabilities]
}
