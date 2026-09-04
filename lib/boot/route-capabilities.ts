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
  // Once each. `/agent-teams` and `/me/agent-teams-settings` were both
  // repointed here as they retired, and each repoint appended another pair.
  ["/squads", "knowledge-agents"],
  ["/squads", "desktop-tools"],
  ["/templates", "knowledge-agents"],
  ["/skills", "knowledge-agents"],
  ["/skills", "desktop-tools"],
  ["/me/memory-settings", "knowledge-agents"],
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

/**
 * Which bundle a Settings section needs, keyed by `?section=`.
 *
 * Keys must be real `SettingsSectionId` values. Seven of them were not, so a
 * third of this table never fired and those sections mounted against whatever
 * the route had already requested: `scheduler` (the id is `scheduled-tasks`),
 * `integrations` and `connectors` (the id is `connections`), `computer-use`
 * (the id is `automation`), plus `twin`, `agent-teams` and `external-agents`,
 * which are routes rather than sections and are already covered by
 * `ROUTE_PREFIXES`. `route-capabilities.test.ts` pins the whole key set against
 * the nav config now, because the type here is deliberately not
 * `Record<SettingsSectionId, _>`: that would drag the nav config's icon imports
 * into the boot path.
 */
export const SETTINGS_CAPABILITIES: Readonly<Record<string, BootCapability>> = {
  desktop: "desktop-tools",
  plugins: "plugin-runtime",
  workflows: "workflow-automation",
  "scheduled-tasks": "workflow-automation",
  // Desktop UI automation, not the workflow engine. This section administers
  // the same engine `/me/computer-use` and the automation commands belong to,
  // and every one of those ships in `desktop-tools`.
  automation: "desktop-tools",
  connections: "integrations",
  mcp: "integrations",
  memory: "knowledge-agents",
  squads: "knowledge-agents",
  characters: "knowledge-agents",
  skills: "knowledge-agents",
  ocr: "knowledge-agents",
  a2ui: "workflow-automation",
  terminal: "desktop-tools",
  "agent-runtime": "desktop-tools",
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
