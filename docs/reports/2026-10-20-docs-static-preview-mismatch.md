# Docs static-preview entry point mismatch

Date: 2026-10-20
Status: Open; recorded separately from the project-instruction cleanup
Scope: Investigation only; no application code, scripts, or configuration changed

## Observed configuration

- The root `docs:start` script delegates to `pnpm --filter docs run start` in [package.json](../../package.json).
- The docs `start` script invokes `next start -p 3001` in [docs/package.json](../package.json).
- [docs/next.config.ts](../next.config.ts) sets `output: "export"`. The production artifact is `docs/out/`.
- The installed Next.js 16.4.0 runtime checks this combination in `node_modules/next/dist/server/next.js` and throws:

> "next start" does not work with "output: export" configuration.

The mismatch is supported by the current configuration and installed runtime source. The command was not launched during this audit; there is no runtime reproduction or completed preview fix to report.

## Impact and proposed follow-up

The documented docs production-start command selects a server entry point incompatible with the configured static output. Provide a preview entry point that serves the docs export rather than changing the deployment model to hide the mismatch. Keep the docs development command and port convention intact.

No matching issue note was found under `docs/reports/`, `docs/research/`, or `docs/plans/` during the cleanup, so this standalone record captures the deferred work.

## Acceptance criteria for a future fix

1. Build the docs workspace and confirm the expected export is produced.
2. Run the chosen preview command from the repository root and confirm it serves `docs/out/` on the documented port.
3. Verify locale navigation, deep links, assets, and the documented search behavior in the preview; report any hosting-specific limitations.
4. Preserve the production static-export configuration and docs deployment contract.
5. Update the script and its documentation together, and record actual verification results.

This issue remains open. The instruction cleanup only removes the misleading startup guidance and links to this record.
