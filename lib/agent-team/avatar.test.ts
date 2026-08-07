import {
  AGENT_TEAM_AVATAR_IDS,
  assignAgentTeamAvatarId,
  getAgentTeamAvatarPath,
  resolveAgentTeamAvatarId,
} from "./avatar"

describe("agent team avatar resolver", () => {
  it("reserves the coordinator portrait for the team lead", () => {
    expect(
      resolveAgentTeamAvatarId({
        id: "lead-1",
        name: "Team Lead",
        role: "lead",
      })
    ).toBe("coordinator")
  })

  it.each([
    ["Security auditor", "Reviews permissions and safety", "security-guardian"],
    ["Data analyst", "Builds metrics and reports", "data-analyst"],
    ["Browser scout", "Searches the web for sources", "browser-scout"],
    ["Research bot", "Investigates product questions", "researcher"],
    ["本地化专家", "负责翻译和国际化", "translator"],
  ])("maps %s to a role-specific portrait", (name, description, expected) => {
    expect(resolveAgentTeamAvatarId({ id: name, name, description })).toBe(expected)
  })

  it("keeps an explicitly selected portrait", () => {
    expect(
      resolveAgentTeamAvatarId({
        id: "member-1",
        name: "Any member",
        avatarId: "creative-agent",
      })
    ).toBe("creative-agent")
  })

  it("uses a stable fallback and avoids portraits already used by the team", () => {
    const subject = { id: "member-2", name: "Specialist" }
    const first = assignAgentTeamAvatarId(subject, new Set())
    const second = assignAgentTeamAvatarId(subject, new Set([first]))

    expect(assignAgentTeamAvatarId(subject, new Set())).toBe(first)
    expect(second).not.toBe(first)
    expect(second).not.toBe("coordinator")
  })

  it("returns the static WebP asset path", () => {
    expect(getAgentTeamAvatarPath("reviewer")).toBe("/icons/cognia-agent-team/webp/reviewer.webp")
  })

  it("reuses the preferred portrait after every teammate portrait is occupied", () => {
    const subject = { id: "member-full", name: "Security specialist" }
    const used = new Set(AGENT_TEAM_AVATAR_IDS.filter((avatarId) => avatarId !== "coordinator"))

    expect(assignAgentTeamAvatarId(subject, used)).toBe("security-guardian")
  })
})
