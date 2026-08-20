import { ALL_MODES } from "@/types/connectors/policy"
import type { ConnectorMode } from "@/types/connectors/policy"

import {
  approvalModeFromAuthority,
  authorityFromApprovalMode,
  autonomyFromConnectorMode,
  connectorModeFromComposition,
  engagementFromConnectorMode,
  projectStoredMode,
  type ImTargetKind,
} from "./mode-projection"

const TARGETS: ImTargetKind[] = ["direct", "team", "workflow"]

describe("autonomyFromConnectorMode", () => {
  it("maps the three legacy modes onto their axis levels", () => {
    expect(autonomyFromConnectorMode("manual")).toBe("observe")
    expect(autonomyFromConnectorMode("draft")).toBe("suggest")
    expect(autonomyFromConnectorMode("auto")).toBe("act")
  })

  it("never resolves an auto-replying bot to autopilot", () => {
    // `auto` has always been bounded below "may do anything without asking";
    // `act` is that ceiling stated in axis terms.
    expect(autonomyFromConnectorMode("auto")).not.toBe("autopilot")
  })
})

describe("engagementFromConnectorMode", () => {
  it("follows the target, not the mode", () => {
    expect(engagementFromConnectorMode("auto", "direct")).toBe("inline")
    expect(engagementFromConnectorMode("auto", "team")).toBe("background")
    expect(engagementFromConnectorMode("auto", "workflow")).toBe("background")
  })

  it("keeps a team-bound conversation detached even in draft mode", () => {
    // The bug this pins: the old `draft-prepare` branch resolved no target,
    // so a team-bound conversation silently produced a single-character
    // draft. Draft is now an autonomy level, not a route.
    expect(engagementFromConnectorMode("draft", "team")).toBe("background")
    expect(engagementFromConnectorMode("draft", "workflow")).toBe("background")
    expect(engagementFromConnectorMode("draft", "direct")).toBe("inline")
  })

  it("lets manual override the target, because no agent loop runs", () => {
    for (const target of TARGETS) {
      expect(engagementFromConnectorMode("manual", target)).toBe("human")
    }
  })
})

describe("connectorModeFromComposition", () => {
  it("round-trips every legacy mode through the axes and back", () => {
    for (const mode of ALL_MODES as readonly ConnectorMode[]) {
      for (const target of TARGETS) {
        const autonomy = autonomyFromConnectorMode(mode)
        const engagement = engagementFromConnectorMode(mode, target)
        expect(connectorModeFromComposition(autonomy, engagement)).toBe(mode)
      }
    }
  })

  it("mirrors the two levels with no legacy spelling to auto", () => {
    expect(connectorModeFromComposition("confirm", "inline")).toBe("auto")
    expect(connectorModeFromComposition("autopilot", "background")).toBe("auto")
  })

  it("treats a human assignee as manual whatever the autonomy says", () => {
    expect(connectorModeFromComposition("autopilot", "human")).toBe("manual")
    expect(connectorModeFromComposition("act", "human")).toBe("manual")
  })

  it("treats observe as manual whatever the engagement says", () => {
    expect(connectorModeFromComposition("observe", "background")).toBe("manual")
  })
})

describe("approvalMode <-> authority", () => {
  it("maps yolo onto bypassPermissions and prompt onto default", () => {
    expect(authorityFromApprovalMode("yolo")).toBe("bypassPermissions")
    expect(authorityFromApprovalMode("prompt")).toBe("default")
  })

  it("keeps an unset approvalMode as no opinion", () => {
    // Collapsing it to `default` would let a conversation that never chose
    // anything override a preset recommendation.
    expect(authorityFromApprovalMode(undefined)).toBeUndefined()
    expect(approvalModeFromAuthority(undefined)).toBeUndefined()
  })

  it("round-trips both legacy values", () => {
    for (const value of ["prompt", "yolo"] as const) {
      expect(approvalModeFromAuthority(authorityFromApprovalMode(value))).toBe(value)
    }
  })

  it("mirrors every non-bypass authority to prompt", () => {
    expect(approvalModeFromAuthority("plan")).toBe("prompt")
    expect(approvalModeFromAuthority("acceptEdits")).toBe("prompt")
  })
})

describe("projectStoredMode", () => {
  it("resolves a row that has never seen an axis write", () => {
    expect(projectStoredMode({ mode: "draft", targetKind: "team" })).toEqual({
      autonomy: "suggest",
      engagement: "background",
      authority: undefined,
    })
  })

  it("prefers the axis fields when present", () => {
    expect(
      projectStoredMode({
        mode: "auto",
        targetKind: "direct",
        autonomy: "confirm",
        engagement: "background",
        approvalMode: "prompt",
        authority: "acceptEdits",
      })
    ).toEqual({ autonomy: "confirm", engagement: "background", authority: "acceptEdits" })
  })

  it("never mixes an axis field with a legacy one for the same pair", () => {
    // Reading autonomy from the new field and engagement from the legacy pair
    // could produce a combination no writer ever stored.
    const projected = projectStoredMode({
      mode: "manual",
      targetKind: "team",
      autonomy: "act",
    })
    expect(projected.autonomy).toBe("act")
    expect(projected.engagement).toBe("human")
  })
})
