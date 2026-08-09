/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { AgentTeamAvatar, mentionTargetAvatarSubject } from "./agent-team-avatar"
import type { MentionTarget } from "@/lib/agent-team/runtime-targets"

describe("AgentTeamAvatar", () => {
  it("renders a role-matched portrait for a teammate without persisted avatar data", () => {
    render(
      <AgentTeamAvatar
        subject={{ id: "legacy-1", name: "Code reviewer", description: "Reviews changes" }}
      />
    )

    expect(screen.getByTestId("agent-team-avatar-legacy-1")).toHaveAttribute(
      "src",
      "/icons/cognia-agent-team/webp/reviewer.webp"
    )
  })

  it("renders the coordinator portrait for a lead", () => {
    render(<AgentTeamAvatar subject={{ id: "lead-1", name: "Lead", role: "lead" }} />)

    expect(screen.getByTestId("agent-team-avatar-lead-1")).toHaveAttribute(
      "src",
      "/icons/cognia-agent-team/webp/coordinator.webp"
    )
  })

  it("uses the subject name when the portrait is informative", () => {
    render(
      <AgentTeamAvatar
        subject={{ id: "bot-1", name: "Research bot", avatarId: "researcher" }}
        decorative={false}
      />
    )

    expect(screen.getByTestId("agent-team-avatar-bot-1")).toHaveAttribute("alt", "Research bot")
  })

  it("preserves teammate identity and specialization for mention portraits", () => {
    const teammate = {
      kind: "teammate",
      id: "tm-mention",
      name: "Mention name",
      runtime: "claude",
      description: "Mention description",
      nameCollision: false,
      teammate: {
        id: "persisted-id",
        name: "Persisted name",
        specialization: "security",
        config: { specialization: "design" },
      },
    } as MentionTarget

    expect(mentionTargetAvatarSubject(teammate)).toMatchObject({
      id: "tm-mention",
      name: "Mention name",
      description: "Mention description",
      specialization: "security",
    })
  })

  it("falls back to configured specialization and maps virtual runtimes", () => {
    const teammate = {
      kind: "teammate",
      id: "tm-config",
      name: "Configured",
      runtime: "claude",
      description: "",
      nameCollision: false,
      teammate: { config: { specialization: "design" } },
    } as MentionTarget
    const virtual = {
      kind: "virtual",
      id: "__virtual_claude__",
      name: "claude",
      runtime: "claude",
      description: "Anthropic Claude API",
    } as MentionTarget

    expect(mentionTargetAvatarSubject(teammate).specialization).toBe("design")
    expect(mentionTargetAvatarSubject(virtual).avatarId).toBe("researcher")
    expect(
      mentionTargetAvatarSubject({ ...virtual, id: "__virtual_codex__", runtime: "codex" }).avatarId
    ).toBe("coder")
  })
})
