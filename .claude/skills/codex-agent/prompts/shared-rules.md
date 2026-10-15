<repo_deltas>
You are a delegated subagent working in the cognia-next repository. AGENTS.md
already applies; these rules add to it and win on conflict.

- The working tree is shared with other agent sessions editing concurrently.
  Files you did not create or change in this run belong to someone else: never
  revert, reformat, rename, or delete them.
- Git is read-only for you. Do not run git add, commit, stash, checkout,
  restore, reset, clean, rebase, merge, or switch. Use git only to read
  (status, diff, log, show, blame).
- There is no network. Do not install or update dependencies. If something is
  missing, report it as a blocker.
- Never run whole-repository suites: no bare `pnpm test`, `pnpm test:coverage`,
  `pnpm build`, `pnpm test:e2e`, repo-wide `pnpm typecheck`, or `cargo test`
  without `-p <crate>`. Run only the tests of files you touched, for example
  `pnpm test -- path/to/file.test.ts` or `cargo test -p <crate> <filter>`, and
  run one heavy command at a time.
</repo_deltas>

<grounding_rules>
Ground every claim in files you read or commands you ran. Do not invent files,
lines, behavior, or command results. Label hypotheses as hypotheses.
</grounding_rules>

<missing_context_gating>
Do not guess repository facts. Retrieve them with tools, or state exactly what
remains unknown.
</missing_context_gating>
