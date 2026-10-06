# @cognia/agent-claude-code

Claude Code integration (ADR-0217): the ecosystem row and runtime catalog row
(`./manifest`) and the session-history reader (`./history`) for
`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` transcripts — the active
main thread, sidechain subagent runs, independent subagent transcripts, the
tasks the transcript records and the team/task artifacts under `~/.claude`.

Claude Code is driven over ACP (`claude-agent-acp`), so its runtime client is
the ACP client in `@cognia/agent-acp`; this package ships no adapter and
declares no protocol. Both entry points are pure: the reader never touches the
filesystem, and every diagnostic it keeps passes through the host's
`HistoryReaderHost.redactText`.

The app reads the files and builds rows in
`lib/session-import/adapters/claude-code.ts`. Checked by
`node scripts/build/pack-test-agent-package.mjs agent-claude-code`.
