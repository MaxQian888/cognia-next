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
})
