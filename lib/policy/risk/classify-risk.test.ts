import { classifyRisk, type RiskInput } from "./classify-risk"
import { COMPUTER_USE_PLUGIN_TOOL_NAMES } from "@/lib/claude/computer-use-tools"
import type { RiskSurfaceId } from "./risk-surfaces"

/** A benign baseline: an analysis run with no tools and no capabilities. */
const base: RiskInput = {
  objective: "Summarize the quarterly report and draft three takeaways",
  taskDescriptions: ["Read the report", "Write the summary"],
  toolIds: [],
  capabilityIds: [],
  sandboxEnabled: false,
}

const input = (over: Partial<RiskInput>): RiskInput => ({ ...base, ...over })

const surfaceIds = (i: RiskInput): RiskSurfaceId[] =>
  [...new Set(classifyRisk(i).surfaces.map((s) => s.id))].sort()

describe("classifyRisk", () => {
  describe("the low-risk default", () => {
    it("returns low for a plain analysis objective with no tools", () => {
      const a = classifyRisk(base)
      expect(a.tier).toBe("low")
      expect(a.surfaces).toEqual([])
      expect(a.reason).toBe("low — no risk surfaces detected")
    })

    it("stays low for read-only tools", () => {
      const a = classifyRisk(input({ toolIds: ["read", "grep", "glob", "ls", "web_search"] }))
      expect(a.tier).toBe("low")
    })

    it("stays low for an unknown tool — unknown is not risky", () => {
      // The deliberate divergence from gate-unless-proven-safe: a classifier
      // that fires on every unrecognized id trains operators to click through.
      const a = classifyRisk(input({ toolIds: ["some_future_plugin_tool"] }))
      expect(a.tier).toBe("low")
    })

    it("stays low for scary-sounding prose with no tool and no destructive verb", () => {
      const a = classifyRisk(
        input({
          objective: "Investigate the production outage and explain the root cause",
          taskDescriptions: ["Review the crash logs for dangerous shell activity"],
        })
      )
      expect(a.tier).toBe("low")
    })

    it("does not treat a substring match as a tool hit", () => {
      // `read_bash_history` normalizes to itself, not to `bash`.
      const a = classifyRisk(input({ toolIds: ["read_bash_history", "computer_vision_notes"] }))
      expect(a.tier).toBe("low")
    })

    it("does not gate on 'clear' or 'remove' — ordinary work, not destruction", () => {
      const a = classifyRisk(
        input({ objective: "Clear up the docs and remove the duplicate import" })
      )
      expect(a.tier).toBe("low")
    })

    it("is origin-blind: a plain IM-bound roster is low risk", () => {
      // The classifier judges what the roster can REACH, never where the run was
      // triggered from. Replying into the thread that summoned the team is the
      // feature, not an irreversible send to an unexpected recipient — gating it
      // would refuse every headless IM-bound team run (the `startTeamRunFromIM`
      // flow) and push operators to blanket-disable riskGating.
      const a = classifyRisk(input({ objective: "Draft a reply to the customer question" }))
      expect(a.tier).toBe("low")
    })
  })

  describe("each surface triggers in isolation", () => {
    it("computer-use → high", () => {
      const i = input({ toolIds: ["computer_use"] })
      expect(classifyRisk(i).tier).toBe("high")
      expect(surfaceIds(i)).toEqual(["computer-use"])
    })

    it.each(COMPUTER_USE_PLUGIN_TOOL_NAMES)(
      "classifies the live computer-use tool %s as computer-use",
      (toolId) => {
        // Regression guard. This set once listed only the pre-app-session
        // spellings, so every real computer-use call classified as ordinary
        // and the risk→ceremony escalation never fired for the most invasive
        // capability in the product. Driving it off the shared constant means
        // renaming or adding a tool cannot silently drop it out of the tier.
        const i = input({ toolIds: [toolId] })
        expect(classifyRisk(i).tier).toBe("high")
        expect(surfaceIds(i)).toContain("computer-use")
      }
    )

    it("native-command → high when unsandboxed", () => {
      const i = input({ toolIds: ["bash"] })
      expect(classifyRisk(i).tier).toBe("high")
      expect(surfaceIds(i)).toEqual(["native-command"])
    })

    it("data-destructive → high from a destructive verb in the objective", () => {
      const i = input({ objective: "Delete the stale customer rows from the archive" })
      expect(classifyRisk(i).tier).toBe("high")
      expect(surfaceIds(i)).toEqual(["data-destructive"])
    })

    it("data-destructive → high from a destructive tool id", () => {
      const i = input({ toolIds: ["directory_delete"] })
      expect(surfaceIds(i)).toEqual(["data-destructive"])
    })

    it("credential-auth → medium (elevated severity)", () => {
      const i = input({ capabilityIds: ["keyring"] })
      expect(classifyRisk(i).tier).toBe("medium")
      expect(surfaceIds(i)).toEqual(["credential-auth"])
    })

    it("file-write-broad → medium when unsandboxed", () => {
      const i = input({ toolIds: ["write"] })
      expect(classifyRisk(i).tier).toBe("medium")
      expect(surfaceIds(i)).toEqual(["file-write-broad"])
    })

    it("external-send → high from an explicit send tool", () => {
      const i = input({ toolIds: ["connector_send"] })
      expect(classifyRisk(i).tier).toBe("high")
      expect(surfaceIds(i)).toEqual(["external-send"])
    })

    it("external-send → high from a plugin-contributed send capability", () => {
      expect(surfaceIds(input({ capabilityIds: ["send_email"] }))).toEqual(["external-send"])
    })
  })

  describe("tool-id normalization", () => {
    it.each([
      ["mcp__cognia-plugin-tools__computer_use", "computer-use"],
      ["computer", "computer-use"],
      ["computer_20251124", "computer-use"],
      ["mcp__cognia-plugin-tools__bash", "native-command"],
      ["bash_20250124", "native-command"],
      ["TEXT_EDITOR", "file-write-broad"],
      ["text_editor_20250728", "file-write-broad"],
    ])("%s → %s", (toolId, expected) => {
      expect(surfaceIds(input({ toolIds: [toolId] }))).toContain(expected)
    })
  })

  describe("the sandbox downgrade", () => {
    it("downgrades native-command from high to medium", () => {
      expect(classifyRisk(input({ toolIds: ["bash"], sandboxEnabled: false })).tier).toBe("high")
      const sandboxed = classifyRisk(input({ toolIds: ["bash"], sandboxEnabled: true }))
      expect(sandboxed.tier).toBe("medium")
      // Still reported — the gate is softer, the surface is not hidden.
      expect(sandboxed.surfaces.map((s) => s.id)).toEqual(["native-command"])
    })

    it("suppresses file-write-broad entirely when sandboxed", () => {
      expect(classifyRisk(input({ toolIds: ["write"], sandboxEnabled: true })).tier).toBe("low")
    })

    it("does not downgrade computer-use — the sandbox does not confine the screen", () => {
      expect(classifyRisk(input({ toolIds: ["computer_use"], sandboxEnabled: true })).tier).toBe(
        "high"
      )
    })
  })

  describe("combined surfaces", () => {
    it("reports every hit and takes the max severity", () => {
      const i = input({
        objective: "Wipe the staging bucket then tell the team in Slack",
        toolIds: ["computer_use", "bash", "write", "connector_send"],
        capabilityIds: ["keyring"],
      })
      const a = classifyRisk(i)
      expect(a.tier).toBe("high")
      expect(surfaceIds(i)).toEqual([
        "computer-use",
        "credential-auth",
        "data-destructive",
        "external-send",
        "file-write-broad",
        "native-command",
      ])
    })

    it("is order-independent across toolIds", () => {
      const a = classifyRisk(input({ toolIds: ["bash", "computer_use"] }))
      const b = classifyRisk(input({ toolIds: ["computer_use", "bash"] }))
      expect(a.tier).toBe(b.tier)
      expect([...a.surfaces].map((s) => s.id).sort()).toEqual(
        [...b.surfaces].map((s) => s.id).sort()
      )
    })

    it("stays medium when only elevated surfaces are hit", () => {
      const a = classifyRisk(input({ toolIds: ["write"], capabilityIds: ["keyring"] }))
      expect(a.tier).toBe("medium")
      expect(a.reason).toBe("medium — credential-auth, file-write-broad")
    })
  })

  describe("keyword matching", () => {
    it.each(["delete", "wipe", "truncate", "rm -rf", "purge", "drop table", "删除", "清空"])(
      "matches the destructive term %s",
      (term) => {
        expect(surfaceIds(input({ objective: `Please ${term} the records` }))).toContain(
          "data-destructive"
        )
      }
    )

    it.each(["credential", "password", "api key", "凭证", "密钥"])(
      "matches the credential term %s",
      (term) => {
        expect(surfaceIds(input({ objective: `Rotate the ${term} for staging` }))).toContain(
          "credential-auth"
        )
      }
    )

    it("requires an object for 'reset' rather than gating on the bare verb", () => {
      expect(classifyRisk(input({ objective: "Reset the retry counter" })).tier).toBe("low")
      expect(surfaceIds(input({ objective: "Reset the database before the demo" }))).toContain(
        "data-destructive"
      )
    })

    it("matches terms in task descriptions, not just the objective", () => {
      expect(surfaceIds(input({ taskDescriptions: ["Run rm -rf on the build cache"] }))).toContain(
        "data-destructive"
      )
    })

    it("prefers tool evidence over keyword evidence for the same surface", () => {
      const a = classifyRisk(
        input({ objective: "Delete the temp files", toolIds: ["directory_delete"] })
      )
      const hit = a.surfaces.find((s) => s.id === "data-destructive")
      expect(hit?.evidence).toBe("directory_delete")
    })
  })

  it("names the tripped surfaces in reason", () => {
    const a = classifyRisk(input({ toolIds: ["connector_send", "computer_use"] }))
    expect(a.reason).toBe("high — external-send, computer-use")
  })
})
