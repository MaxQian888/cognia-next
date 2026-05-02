"use client"

import { useTranslations } from "next-intl"
import { Card } from "@/components/ui/card"
import type { AgentTeamMessage } from "@/types/agent/agent-team"

export interface AgentTeamChatProps {
  messages: AgentTeamMessage[]
}

function formatTimestamp(ts: Date): string {
  // Stable, locale-free formatting for tests + UI alike.
  return new Date(ts).toISOString()
}

export function AgentTeamChat({ messages }: AgentTeamChatProps) {
  const t = useTranslations("agentTeamsWorkspace.chat")
  if (messages.length === 0) {
    return (
      <Card className="p-4 text-center text-xs text-muted-foreground" data-testid="chat-empty">
        {t("empty")}
      </Card>
    )
  }
  return (
    <div className="space-y-2" data-testid="workspace-chat">
      {messages.map((msg) => (
        <Card key={msg.id} className="space-y-1 p-3" data-testid={`chat-msg-${msg.id}`}>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="font-medium">{msg.senderName}</span>
            <span className="font-mono text-[10px]">{formatTimestamp(msg.timestamp)}</span>
          </div>
          <p className="whitespace-pre-wrap text-sm">{msg.content}</p>
        </Card>
      ))}
    </div>
  )
}
