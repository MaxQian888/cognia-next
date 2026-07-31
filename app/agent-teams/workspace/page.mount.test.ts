/**
 * Runtime-proof guard: the team workspace page must mount the HITL gate host
 * and the durable run-history list. Both are ADR-0022 deliverables that were
 * built + unit-tested but historically left unmounted ("built-but-dormant").
 * This source-level assertion keeps them wired so a refactor can't silently
 * re-orphan them.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const src = readFileSync(join(__dirname, "page.tsx"), "utf8")

describe("agent-teams workspace page wiring", () => {
  it("imports and renders GateModalsHost (HITL gate consumer)", () => {
    expect(src).toMatch(
      /import\s*{\s*GateModalsHost\s*}\s*from\s*"@\/components\/agent\/team\/gate-modals-host"/
    )
    expect(src).toMatch(/<GateModalsHost\s*\/>/)
  })

  it("mounts AgentTeamActivity, which wires the durable run history", () => {
    expect(src).toMatch(
      /import\s*{\s*AgentTeamActivity\s*}\s*from\s*"@\/components\/agent\/workspace\/activity"/
    )
    expect(src).toMatch(/<AgentTeamActivity/)
  })

  it("keeps TeamRunsList (durable run history) wired inside the activity tab", () => {
    const activitySrc = readFileSync(
      join(__dirname, "../../../components/agent/workspace/activity.tsx"),
      "utf8"
    )
    expect(activitySrc).toMatch(/import\s*{\s*TeamRunsList\s*}\s*from\s*"\.\.\/team\/runs-list"/)
    expect(activitySrc).toMatch(/<TeamRunsList\s+teamId=/)
  })

  it("builds the Claude virtual runtime model through the provider-resolution helper", () => {
    expect(src).toMatch(
      /import\s*{\s*buildTeamClaudeRuntimeModel\s*}\s*from\s*"@\/lib\/agent-team\/provider-model"/
    )
    expect(src).toMatch(/claude:\s*{\s*model:\s*buildTeamClaudeRuntimeModel\(settings\)\s*}/)
    expect(src).not.toMatch(/getProviderModel\(\{\s*provider:\s*"anthropic"/s)
  })

  it("wires live file activity into the active project editor", () => {
    expect(src).toMatch(/onFileActivity:\s*handleAgentFileActivity/)
    expect(src).toMatch(/openInProjectEditor\(absolutePath, activity\.line, activity\.column\)/)
  })

  // Console layout invariants. The header carries the live status and the run
  // controls; the moment it goes back inside the scroll container it stops being
  // reachable on long tabs, which is the exact regression this shell replaced.
  it("keeps the header outside the panel scroll container", () => {
    const headerIdx = src.indexOf("<WorkspaceHeader")
    const scrollIdx = src.indexOf('data-testid="workspace-panel-scroll"')
    expect(headerIdx).toBeGreaterThan(-1)
    expect(scrollIdx).toBeGreaterThan(-1)
    expect(headerIdx).toBeLessThan(scrollIdx)
  })

  it("hands the run controls to the header, not the Overview tab", () => {
    expect(src).toMatch(/<WorkspaceHeader[\s\S]*?onAbort={[\s\S]*?abortTeam\(team\.id/)
    expect(src).toMatch(/<AgentTeamOverview[\s\S]*?chrome="header"/)
    // Overview must no longer receive them, or both surfaces would draw them.
    expect(src).not.toMatch(/<AgentTeamOverview[\s\S]*?onStart=/)
  })

  // The unread subsystem (`AgentTeamMessage.read` + four store actions) shipped
  // with zero consumers. These pin the consumer in place — and specifically pin
  // the mark-read side, without which the badge is a number that only climbs.
  it("feeds the tab rail an unread count and a pending-gate count", () => {
    expect(src).toMatch(
      /import\s*{\s*countUnread\s*}\s*from\s*"@\/components\/agent\/workspace\/unread"/
    )
    expect(src).toMatch(/countUnread\(s\.messages, teamId\)/)
    expect(src).toMatch(/usePendingGatesStore\(/)
    expect(src).toMatch(/signals={{[\s\S]*?chat:\s*{\s*count:/)
  })

  it("marks the thread read while the chat tab is active", () => {
    expect(src).toMatch(/markTeamMessagesRead\(teamId\)/)
    expect(src).toMatch(/activeTab !== "chat"/)
  })

  it("gives every tab one scroll model (no per-tab full-height branch)", () => {
    expect(src).not.toMatch(/isFullHeight/)
    expect(src).toMatch(/<SidebarInset className="min-h-0 overflow-hidden"/)
  })

  // In CodeServer mode a native webview is pinned over the editor pane and
  // cannot be composited with an animating ancestor — globals.css already
  // force-collapses transitions under `html[data-pro-ide-active]` for the same
  // reason. Animating the panel wrapper into that tab would tear it.
  it("excludes the editor tab and reduced-motion users from the panel cross-fade", () => {
    expect(src).toMatch(/const animatePanels = !reduceMotion && tab !== "editor"/)
    expect(src).toMatch(/panelMotion\s*=\s*animatePanels/)
    expect(src).toMatch(/\{ initial: false as const \}/)
  })

  it("defers conversation file navigation until the editor tab mounts", () => {
    expect(src).toMatch(
      /deferProjectEditorOpen\(target\.absolutePath, target\.line, target\.column\)/
    )
    expect(src).toMatch(/setWorkspaceTab\("editor"\)/)
    expect(src).toMatch(/onOpenProjectFile={handleConversationFileOpen}/)
  })
})
