# External Agent session import research — 2026-08-29

## Scope

This pass covers local storage, stable official CLI/API surfaces, and user-provided exports. It does not
add cloud-account authorization, scrape hosted histories, or fabricate private runtime transcripts.
`CanonicalSession` stays at version 1; all new fields are optional.

## Findings and implementation

| Source               | Evidence checked                                                                                                                                                             | Implemented projection                                                                                                                             | Remaining limit                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Claude Code 2.1.251  | [Subagents](https://code.claude.com/docs/en/sub-agents)                                                                                                                      | independent subagent files, resumed agent identity, branch/fork lineage, team dependencies, background lifecycle                                   | non-public runtime state becomes bounded diagnostic/loss                  |
| Codex 0.150.1        | [Protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs), [models](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs) | session metadata, parent/fork, response/turn items, shell/web/image/tools, plan/goal, rollback, compaction, collaboration and inter-agent messages | unknown rollout events are retained redacted and size-limited             |
| Gemini CLI 0.57.0    | [Recording types](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingTypes.ts)                                                    | `$set`, `$rewindTo`, official JSON, multimodal/display content, warnings, scratchpad, token classes, tool status and `agentId`                     | source-private scratch state is not invented                              |
| OpenCode 1.18.25     | [Session schema](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/schema.ts)                                                                         | current SQLite/V2 sessions, arbitrary-depth children, background jobs, attachment, patch/snapshot, retry/compaction/step/tool lifecycle            | local DB/share export only                                                |
| Continue 2.1.0       | upstream repository and read-only history contract                                                                                                                           | mode/model/usage, structured content and tool-result correlation                                                                                   | no upstream subagent transcript semantics                                 |
| Aider 0.86.2         | official usage/history behavior                                                                                                                                              | configured non-default history paths and Markdown transcript                                                                                       | Markdown is explicitly lossy                                              |
| Pi 0.84.4            | current repository format/migrations                                                                                                                                         | branch vs subagent, direct bash, labels/session info and compaction                                                                                | recovery depends on live `pi-rpc` capability                              |
| Cursor 1.7           | [History docs](https://docs.cursor.com/en/agent/chat/history)                                                                                                                | local `state.vscdb`, Markdown export and `~/.cursor/subagents`                                                                                     | hosted/background history requires separate authorization and is not read |
| Cline 3.38           | [SQLite store](https://github.com/cline/cline/blob/main/sdk/packages/core/src/services/storage/sqlite-session-store.ts)                                                      | `sessions.db`, manifest/messages/compaction artifacts, team history and legacy task folders                                                        | local artifacts only                                                      |
| Copilot CLI 0.0.350  | [Chronicle](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle)                                                                                        | `~/.copilot/session-state`, SQLite subset, workspace artifacts, tasks/background/checkpoints                                                       | no hosted Copilot history                                                 |
| Qwen Code 0.16-alpha | [Session commands](https://qwenlm.github.io/qwen-code-docs/en/users/features/commands/)                                                                                      | official JSON/JSONL exports and local service artifacts with resume/branch/fork/rewind relationships                                               | no dependency on undocumented private layouts                             |

Kiro, Droid, and DeepSeek Harness remain in the generated runtime capability matrix but have no import
adapter because a stable public transcript format was not found.

## Canonical and synchronization decisions

- `parseGraph` is authoritative for built-ins and returns canonical nodes, graph revision, and per-node
  loss. `parseSession` remains the legacy plugin entry and is wrapped with an explicit fidelity downgrade.
- Content digests include message content, parts, tool state, relationship, and lifecycle. Equal counts or
  timestamps no longer hide edits.
- `source-mirror` applies upstream rewind/removal and tombstones missing children while retaining local
  decoration. `cognia-owned` never mirrors over local continuation. `native-bound` deduplicates file-watch
  echoes against native session/revision identity.
- Unknown events are never silently discarded: a bounded, credential-key-redacted diagnostic is stored and
  an exact loss entry identifies the source event kind.
- Desktop SQLite transports are read-only and source-allowlisted. No source data is shell-concatenated.

## Native recovery gate

Native recovery uses `ExternalAgentManager.resumeSession` only after matching native id + preset,
connected/executable runtime, live `session/resume: supported`, and existing cwd checks. The ownership
transition is committed only after the handshake. Missing CLI/config/capability/cwd and runtime failure
produce distinct diagnostics; no configuration or process is created implicitly.

## Fixture policy

`lib/session-import/fixtures/upstream-generations.ts` records a redacted current and previous generation
for all eleven sources, including upstream version, verification date, evidence URL, and capability tags.
Parser tests cover nested agents, background terminal states, dependencies, fork/rewind/rollback,
compaction, multimodal content, tool errors, partial JSONL, SQLite evolution, and orphan children.
