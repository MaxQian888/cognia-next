// Cognia exports ChatMode from `@/types/core/session`. cognia-next doesn't
// have a parallel session-mode union, so we declare the locally-needed shape
// inline — only the intent classifier consumes it, and only as a string tag
// to bias toward agent vs. chat task drafts.
type ChatMode = "chat" | "agent" | "research" | "learning" | "plan"
import type { ConversationalTaskDraft } from "./conversational-task-authoring"
import {
  createScheduledAgentTaskDraft,
  createScheduledChatTaskDraft,
} from "./conversational-task-authoring"

export interface ConversationalSchedulerIntentContext {
  mode: ChatMode
  sessionId?: string
  timezone?: string
  provider?: string
  model?: string
}

const EXPLICIT_SCHEDULER_PATTERNS = [
  /(?:定时|计划任务|提醒我|每[天周月年]|工作日|schedule|scheduled|every day|every week|every month|remind me|run .*?(?:daily|weekly|monthly))/i,
]
const TIME_MENTION_PATTERN = /(?:早上|中午|下午|晚上|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b)/i
const SCHEDULING_ACTION_PATTERN =
  /(?:提醒|发送|发给|运行|执行|开始|schedule|scheduled|remind|run|start)/i

const AGENT_HINT_PATTERNS = [/\bagent\b/i, /代理/i, /智能体/i]

const CHAT_HINT_PATTERNS = [/聊天/i, /消息/i, /发送/i, /提醒/i, /\bchat\b/i, /\bmessage\b/i]

function hasSchedulerIntent(message: string): boolean {
  return (
    EXPLICIT_SCHEDULER_PATTERNS.some((pattern) => pattern.test(message)) ||
    (TIME_MENTION_PATTERN.test(message) && SCHEDULING_ACTION_PATTERN.test(message))
  )
}

function hasExplicitAgentIntent(message: string): boolean {
  return AGENT_HINT_PATTERNS.some((pattern) => pattern.test(message))
}

function hasExplicitChatIntent(message: string): boolean {
  return CHAT_HINT_PATTERNS.some((pattern) => pattern.test(message))
}

export function detectConversationalSchedulerDraft(
  message: string,
  context: ConversationalSchedulerIntentContext
): ConversationalTaskDraft | null {
  const normalizedMessage = message.trim()
  if (!normalizedMessage || !hasSchedulerIntent(normalizedMessage)) {
    return null
  }

  const defaults = {
    timezone: context.timezone,
    provider: context.provider,
    model: context.model,
  }
  const explicitAgentIntent = hasExplicitAgentIntent(normalizedMessage)
  const explicitChatIntent = hasExplicitChatIntent(normalizedMessage)

  if (explicitChatIntent && !explicitAgentIntent) {
    return createScheduledChatTaskDraft(
      {
        message: normalizedMessage,
        sessionId: context.sessionId,
      },
      defaults
    )
  }

  if (explicitAgentIntent && !explicitChatIntent) {
    return createScheduledAgentTaskDraft(
      {
        agentTask: normalizedMessage,
      },
      defaults
    )
  }

  if (explicitAgentIntent) {
    return createScheduledAgentTaskDraft(
      {
        agentTask: normalizedMessage,
      },
      defaults
    )
  }

  if (context.mode === "agent") {
    return createScheduledAgentTaskDraft(
      {
        agentTask: normalizedMessage,
      },
      defaults
    )
  }

  return createScheduledChatTaskDraft(
    {
      message: normalizedMessage,
      sessionId: context.sessionId,
    },
    defaults
  )
}
