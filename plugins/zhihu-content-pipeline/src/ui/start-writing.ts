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
 * runtime. `ctx.session.startSeededSession` creates the session, persists the
 * seed as its first user message and moves the UI to it in one call.
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
  markTopicStatus: (id: string, status: TopicStatus, sessionId?: string) => Promise<void>
  /** The session's title in the user's language (`session.title`). */
  sessionTitle: (topicTitle: string) => string
}

/**
 * Open a Writer-character chat session seeded with the topic instruction, then
 * mark the topic `selected` and record the session. Returns the session id.
 *
 * The order matters: marking first stranded the topic — out of the candidate
 * list, with no session behind it — whenever the session failed to start.
 * The seed stays in Chinese on purpose: it instructs the Writer on a Chinese
 * platform, it is content, not interface.
 */
export async function startWritingForTopic(
  topic: Pick<TopicRow, "id" | "title" | "url" | "reason">,
  deps: StartWritingDeps
): Promise<string> {
  const { sessionId } = await deps.startSeededSession({
    title: deps.sessionTitle(topic.title),
    characterId: zhihuRoleCharacterId("writer"),
    seedUserMessage: buildWritingSeed(topic),
  })
  await deps.markTopicStatus(topic.id, "selected", sessionId)
  return sessionId
}
