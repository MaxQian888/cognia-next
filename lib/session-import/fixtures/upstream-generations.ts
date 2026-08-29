/** Redacted fixture provenance. Parser-specific payload fixtures remain co-located with each adapter. */
export interface SessionImportGenerationFixture {
  sourceId: string
  generation: "current" | "previous"
  version: string
  verifiedAt: "2026-08-29"
  evidence: string
  capabilities: string[]
  redactedSample: Record<string, unknown>
}

export interface ExecutableGenerationArtifact {
  name: string
  path: string
  content: string
}

/** Minimal redacted artifact that is parsed by the registered adapter in the fixture gate. */
export function executableGenerationArtifact(
  fixture: SessionImportGenerationFixture
): ExecutableGenerationArtifact {
  const id = `${fixture.sourceId}-${fixture.generation}`
  switch (fixture.sourceId) {
    case "claude-code":
      return {
        name: `${id}.jsonl`,
        path: `/fixtures/.claude/projects/project/${id}.jsonl`,
        content: [
          {
            type: "user",
            uuid: "u1",
            parentUuid: null,
            sessionId: id,
            message: { role: "user", content: "fixture prompt" },
          },
          {
            type: "assistant",
            uuid: "a1",
            parentUuid: "u1",
            sessionId: id,
            ...(fixture.generation === "previous" ? { isSidechain: false } : {}),
            message: { role: "assistant", content: [{ type: "text", text: "fixture reply" }] },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n"),
      }
    case "codex":
      return {
        name: `rollout-${id}.jsonl`,
        path: `/fixtures/.codex/sessions/2026/08/29/rollout-${id}.jsonl`,
        content: [
          { type: "session_meta", payload: { id, cli_version: fixture.version } },
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "fixture prompt" }],
            },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n"),
      }
    case "gemini-cli":
      return {
        name: `${id}.${fixture.generation === "current" ? "json" : "jsonl"}`,
        path: `/fixtures/.gemini/tmp/project/chats/${id}.jsonl`,
        content:
          fixture.generation === "current"
            ? JSON.stringify([{ role: "user", parts: [{ text: "fixture prompt" }] }])
            : [
                { sessionId: id, projectHash: "[redacted]" },
                { id: "u1", type: "user", content: [{ text: "fixture prompt" }] },
              ]
                .map((line) => JSON.stringify(line))
                .join("\n"),
      }
    case "continue-dev":
      return {
        name: `${id}.json`,
        path: `/fixtures/.continue/sessions/${id}.json`,
        content: JSON.stringify({
          sessionId: id,
          history: [{ message: { role: "user", content: "fixture prompt" } }],
        }),
      }
    case "aider":
      return {
        name: ".aider.chat.history.md",
        path: `/fixtures/${id}/.aider.chat.history.md`,
        content: "#### fixture prompt\n\nfixture reply\n",
      }
    case "pi":
      return {
        name: `${id}.jsonl`,
        path: `/fixtures/.pi/agent/sessions/project/${id}.jsonl`,
        content: [
          {
            type: "session",
            version: fixture.generation === "current" ? 3 : 2,
            id,
            cwd: "/fixture",
          },
          {
            type: "message",
            id: "u1",
            parentId: null,
            message: { role: "user", content: "fixture prompt" },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n"),
      }
    case "opencode":
      return {
        name: `${id}.json`,
        path: `/fixtures/opencode/${id}.json`,
        content: JSON.stringify({
          id,
          title: "Fixture",
          time: { created: 1, updated: 2 },
          messages: [
            {
              role: "user",
              time: { created: 1 },
              parts: [{ type: "text", text: "fixture prompt" }],
            },
          ],
        }),
      }
    default:
      return {
        name: `${id}.json`,
        path: `/fixtures/.${fixture.sourceId}/${id}.json`,
        content: JSON.stringify({
          sessionId: id,
          messages: [{ id: "u1", role: "user", content: "fixture prompt" }],
        }),
      }
  }
}

const fixture = (
  sourceId: string,
  generation: "current" | "previous",
  version: string,
  evidence: string,
  capabilities: string[],
  redactedSample: Record<string, unknown>
): SessionImportGenerationFixture => ({
  sourceId,
  generation,
  version,
  verifiedAt: "2026-08-29",
  evidence,
  capabilities,
  redactedSample,
})

export const SESSION_IMPORT_GENERATION_FIXTURES: readonly SessionImportGenerationFixture[] = [
  fixture(
    "claude-code",
    "current",
    "2.1.251",
    "https://code.claude.com/docs/en/sub-agents",
    ["independent-subagent", "team", "background"],
    { type: "assistant", sessionId: "[session]", agentId: "[agent]" }
  ),
  fixture(
    "claude-code",
    "previous",
    "legacy-sidechain",
    "https://code.claude.com/docs/en/sub-agents",
    ["isSidechain"],
    { type: "assistant", isSidechain: true }
  ),
  fixture(
    "codex",
    "current",
    "0.150.1",
    "https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs",
    ["parent-thread", "collab", "rollback", "compaction"],
    { type: "event_msg", payload: { type: "collab_agent_spawn_begin" } }
  ),
  fixture(
    "codex",
    "previous",
    "legacy-rollout",
    "https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs",
    ["response-item"],
    { type: "response_item", payload: { type: "message" } }
  ),
  fixture(
    "opencode",
    "current",
    "1.18.25",
    "https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/schema.ts",
    ["sqlite", "child-session", "job", "attachment"],
    { session: { id: "[session]", parentID: "[parent]" } }
  ),
  fixture(
    "opencode",
    "previous",
    "v1-json",
    "https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/schema.ts",
    ["share-export"],
    { id: "[session]", messages: [] }
  ),
  fixture(
    "gemini-cli",
    "current",
    "0.57.0",
    "https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingTypes.ts",
    ["set", "rewindTo", "agentId", "multimodal"],
    { type: "content", agentId: "[agent]", content: [] }
  ),
  fixture(
    "gemini-cli",
    "previous",
    "legacy-checkpoint",
    "https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingTypes.ts",
    ["checkpoint"],
    { sessionId: "[session]", messages: [] }
  ),
  fixture(
    "continue-dev",
    "current",
    "2.1.0",
    "https://github.com/continuedev/continue",
    ["mode", "model", "usage", "tool-result"],
    { id: "[session]", history: [] }
  ),
  fixture(
    "continue-dev",
    "previous",
    "legacy-history",
    "https://github.com/continuedev/continue",
    ["history"],
    { sessionId: "[session]", messages: [] }
  ),
  fixture(
    "aider",
    "current",
    "0.86.2",
    "https://aider.chat/docs/usage.html",
    ["configured-history", "markdown"],
    { path: "[repo]/.aider.chat.history.md" }
  ),
  fixture(
    "aider",
    "previous",
    "default-history",
    "https://aider.chat/docs/usage.html",
    ["markdown"],
    { path: ".aider.chat.history.md" }
  ),
  fixture(
    "pi",
    "current",
    "0.84.4",
    "https://github.com/badlogic/pi-mono",
    ["branch", "subagent", "bash", "compaction"],
    { type: "session", id: "[session]" }
  ),
  fixture("pi", "previous", "pre-migration", "https://github.com/badlogic/pi-mono", ["branch"], {
    type: "message",
    role: "user",
  }),
  fixture(
    "cursor",
    "current",
    "1.7",
    "https://docs.cursor.com/en/agent/chat/history",
    ["sqlite", "subagent", "markdown-export"],
    { composerId: "[session]", bubbles: [] }
  ),
  fixture(
    "cursor",
    "previous",
    "legacy-composer",
    "https://docs.cursor.com/en/agent/chat/history",
    ["composer"],
    { conversationId: "[session]", messages: [] }
  ),
  fixture(
    "cline",
    "current",
    "3.38",
    "https://github.com/cline/cline/blob/main/sdk/packages/core/src/services/storage/sqlite-session-store.ts",
    ["sessions-db", "manifest", "compaction", "team-task"],
    { sessionId: "[session]", messages_path: "[artifact]" }
  ),
  fixture(
    "cline",
    "previous",
    "task-folder",
    "https://github.com/cline/cline/blob/main/sdk/packages/core/src/services/storage/sqlite-session-store.ts",
    ["api-conversation-history"],
    { path: "[task]/api_conversation_history.json" }
  ),
  fixture(
    "copilot-cli",
    "current",
    "0.0.350",
    "https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle",
    ["events-jsonl", "sqlite", "checkpoint", "background"],
    { sessionId: "[session]", type: "checkpoint" }
  ),
  fixture(
    "copilot-cli",
    "previous",
    "events-only",
    "https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle",
    ["events-jsonl"],
    { type: "message", role: "user" }
  ),
  fixture(
    "qwen-code",
    "current",
    "0.16-alpha",
    "https://qwenlm.github.io/qwen-code-docs/en/users/features/commands/",
    ["export", "resume", "branch", "fork", "rewind"],
    { sessionId: "[session]", events: [] }
  ),
  fixture(
    "qwen-code",
    "previous",
    "legacy-export",
    "https://qwenlm.github.io/qwen-code-docs/en/users/features/commands/",
    ["json-export"],
    { id: "[session]", messages: [] }
  ),
]
