import Image from "next/image"

import { getAgentTeamAvatarPath, resolveAgentTeamAvatarId } from "@/lib/agent-team/avatar"
import { cn } from "@/lib/utils"
import type { AgentTeamAvatarSubject } from "@/lib/agent-team/avatar"
import type { MentionTarget } from "@/lib/agent-team/runtime-targets"

export interface AgentTeamAvatarProps {
  subject: AgentTeamAvatarSubject
  className?: string
  decorative?: boolean
}

export function mentionTargetAvatarSubject(target: MentionTarget): AgentTeamAvatarSubject {
  if (target.kind === "teammate") {
    return {
      ...target.teammate,
      id: target.id,
      name: target.name,
      description: target.description,
      specialization: target.teammate.specialization ?? target.teammate.config?.specialization,
    }
  }

  return {
    id: target.id,
    name: target.name,
    description: target.description,
    avatarId: target.runtime === "claude" ? "researcher" : "coder",
  }
}

/** Shared portrait renderer for teammates, virtual agents, and bot recommendations. */
export function AgentTeamAvatar({ subject, className, decorative = true }: AgentTeamAvatarProps) {
  const avatarId = resolveAgentTeamAvatarId(subject)

  return (
    <Image
      src={getAgentTeamAvatarPath(avatarId)}
      alt={decorative ? "" : subject.name}
      width={512}
      height={512}
      draggable={false}
      data-testid={`agent-team-avatar-${subject.id}`}
      data-avatar-id={avatarId}
      className={cn("shrink-0 object-contain", className)}
    />
  )
}
