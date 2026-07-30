import { RISK_SURFACES } from "@/lib/policy/risk/risk-surfaces"
import {
  classifyNodeRisk,
  RISKY_NODE_KINDS,
  RISKY_NODE_KIND_IDS,
  tierForSurface,
} from "./node-risk"

describe("classifyNodeRisk", () => {
  describe("the risky kinds", () => {
    it.each([
      ["action.connector.send", "external-send", "high"],
      ["action.connector.forward", "external-send", "high"],
      ["action.mobile.share", "external-send", "high"],
      ["action.git.push", "external-send", "high"],
      ["action.desktop.getAppState", "computer-use", "high"],
      ["action.desktop.performAction", "computer-use", "high"],
      ["action.system.terminal", "native-command", "high"],
      ["action.terminal.script", "native-command", "high"],
      ["action.terminal.session.run", "native-command", "high"],
      ["action.connector.delete", "data-destructive", "high"],
    ])("%s → %s (%s)", (type, surface, tier) => {
      const a = classifyNodeRisk({ type })
      expect(a.tier).toBe(tier)
      expect(a.surfaces.map((s) => s.id)).toEqual([surface])
      expect(a.surfaces[0].evidence).toBe(type)
      expect(a.reason).toBe(`${tier} — ${surface}`)
    })
  })

  describe("the deliberate absences", () => {
    // Each of these destroys or writes something, and each is deliberately NOT
    // gated. Gating routine automation trains operators to switch riskGating
    // off, which would lose the shell/mouse/send gating that is the point.
    it.each([
      "action.connector.draft",
      "action.connector.reaction",
      "action.git.commit",
      "action.git.stage",
      "action.git.branch",
      "action.mobile.notify",
      "action.goal.delete",
      "action.plan.delete",
      "action.scheduler.task.delete",
      "action.plugin.invoke",
      "action.skill.invoke",
      "action.desktop.listApps",
      "action.desktop.queryElements",
      "action.desktop.expandElement",
    ])("%s stays low", (type) => {
      expect(classifyNodeRisk({ type }).tier).toBe("low")
    })

    it("leaves ordinary flow and trigger nodes alone", () => {
      for (const type of [
        "flow.branch",
        "flow.loop",
        "flow.set",
        "trigger.cron",
        "trigger.manual",
      ]) {
        expect(classifyNodeRisk({ type }).tier).toBe("low")
      }
    })

    it("treats an unknown kind as low — unknown is not risky", () => {
      const a = classifyNodeRisk({ type: "action.some.future.node" })
      expect(a.tier).toBe("low")
      expect(a.surfaces).toEqual([])
      expect(a.reason).toBe("low — no risk surfaces detected")
    })
  })

  describe("tierForSurface", () => {
    it.each([
      ["external-send", "high"],
      ["computer-use", "high"],
      ["native-command", "high"],
      ["data-destructive", "high"],
    ] as const)("%s → %s", (surface, tier) => {
      expect(tierForSurface(surface)).toBe(tier)
    })

    it.each([
      ["credential-auth", "medium"],
      ["file-write-broad", "medium"],
    ] as const)("%s (elevated) → %s", (surface, tier) => {
      // No node kind maps to these yet. The branch is kept because severity is
      // the taxonomy's call, not this map's — it must stay correct the day one
      // is added.
      expect(tierForSurface(surface)).toBe(tier)
    })
  })

  describe("the taxonomy", () => {
    it("maps every risky kind to a surface that exists in RISK_SURFACES", () => {
      for (const [kind, surface] of Object.entries(RISKY_NODE_KINDS)) {
        expect(RISK_SURFACES[surface]).toBeDefined()
        expect(kind).toMatch(/^action\./)
      }
    })

    it("never classifies an approval node as risky — it IS the gate", () => {
      expect(classifyNodeRisk({ type: "action.approval.request" }).tier).toBe("low")
      expect(RISKY_NODE_KIND_IDS).not.toContain("action.approval.request")
    })
  })
})
