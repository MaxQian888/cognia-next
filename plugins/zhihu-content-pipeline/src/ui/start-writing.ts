/**
 * Writing handoff — turn a selected topic into a tool-enabled Writer chat.
 *
 * The tool-enabled path is the chat/sidecar runner (`resolveSendOptions` →
 * `sendPrompt`), so we bind a chat session to the **Writer pack character**
 * (which carries the zhihu-answer-writer skill) rather than instantiating an
 * Agent Team (whose teammate dispatch is text-only). The Writer's skill is an
 * inherently single-author interactive 4-step flow, so a single character fits
 * it better than a group chat.
 *
 * Dependencies are injected so the handoff is unit-testable without the chat
 * runtime. NOTE (verify in-app): seeding the first user message persists it to
 * the transcript; whether the agent auto-replies or needs a nudge is a
 * chat-runtime behavior to confirm under `pnpm tauri dev`.
 */

import { zhihuRoleCharacterId } from "../characters/pack"
import type { TopicRow, TopicStatus } from "../db/tables"

/** Build the seed instruction handed to the Writer for a chosen topic. */
export function buildWritingSeed(topic: Pick<TopicRow, "title" | "url" | "reason">): string {
  const lines = [
    "请按 zhihu-answer-writer 技能的四步多轮确认流程，为下面这个选题写一篇有高赞气质的知乎回答。",
    "",
    `选题：${topic.title}`,
  ]
  if (topic.reason) lines.push(`角度/为什么值得写：${topic.reason}`)
  if (topic.url) lines.push(`相关链接：${topic.url}`)
  lines.push("", "先做问题拆解 + 立场 + 候选钩子，和我确认后再往下。")
  return lines.join("\n")
}

export interface StartWritingDeps {
  /**
   * `startSeededSession` from `@cognia/plugin-sdk/api/agent-turn` — creates the
   * session, persists the seed message and moves the UI in one call. Injected
   * so the handoff stays unit-testable without the chat runtime.
   */
  startSeededSession: (input: {
    title?: string
    characterId?: string
    seedUserMessage?: string
  }) => Promise<{ sessionId: string }>
  markTopicStatus: (id: string, status: TopicStatus) => Promise<void>
}

/**
 * Mark the topic selected, open a Writer-character chat session seeded with the
 * topic instruction, and activate it. Returns the new session id.
 */
export async function startWritingForTopic(
  topic: Pick<TopicRow, "id" | "title" | "url" | "reason">,
  deps: StartWritingDeps
): Promise<string> {
  await deps.markTopicStatus(topic.id, "selected")
  const { sessionId } = await deps.startSeededSession({
    title: `知乎写作：${topic.title}`,
    characterId: zhihuRoleCharacterId("writer"),
    seedUserMessage: buildWritingSeed(topic),
  })
  return sessionId
}
