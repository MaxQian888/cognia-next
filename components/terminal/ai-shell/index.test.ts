/**
 * Barrel surface guard for the AI Shell components. The terminal dock mounts
 * both panels through `@/components/terminal/ai-shell`; a dropped re-export
 * here renders as an "Element type is invalid" crash at mount time.
 */
import * as aiShell from "./index"
import { AiShellPanel } from "./ai-shell-panel"
import { AiShellPlanView } from "./ai-shell-plan-view"

describe("components/terminal/ai-shell barrel", () => {
  it("re-exports both panels by identity", () => {
    expect(aiShell.AiShellPanel).toBe(AiShellPanel)
    expect(aiShell.AiShellPlanView).toBe(AiShellPlanView)
  })

  it("exports components, not undefined placeholders", () => {
    expect(typeof aiShell.AiShellPanel).toBe("function")
    expect(typeof aiShell.AiShellPlanView).toBe("function")
  })

  it("exposes exactly the documented runtime surface", () => {
    expect(Object.keys(aiShell).sort()).toEqual(["AiShellPanel", "AiShellPlanView"])
  })
})
