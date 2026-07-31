/**
 * Guard: the chat header mounts the plan-mode tasks sheet. The plan-mode bridge
 * producer (use-claude-chat → applyPlanModeBridge) writes tasks into a synthetic
 * `solo:<sessionId>` team, but the consumer sheet historically had no host, so
 * a non-team chat's plan-mode tasks were computed and never shown. The sheet
 * self-hides when empty, so always-mounting it is safe.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const src = readFileSync(join(__dirname, "chat-header.tsx"), "utf8")

describe("chat header wiring", () => {
  it("imports and renders PlanModeTasksSheet", () => {
    expect(src).toMatch(
      /import\s*{\s*PlanModeTasksSheet\s*}\s*from\s*"@\/components\/agent\/workspace\/plan-mode-tasks-sheet"/
    )
    expect(src).toMatch(/<PlanModeTasksSheet\s+sessionId=/)
  })
})
