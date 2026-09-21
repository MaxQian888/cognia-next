---
name: plugin-conversion
description: Inspect and deterministically convert complete plugin bundles between supported ecosystems.
allowed-tools:
  - plugin_conversion_inspect
  - plugin_conversion_apply
metadata:
  delivery: explicit
  triggers:
    surfaces: []
    intents: [inspect-plugin-conversion, apply-plugin-conversion, migrate-plugin-ecosystem]
  capability-requirements:
    - capability: workspace-backend
      reason: source and output paths must resolve inside the active workspace
    - capability: plugin-conversion-tools
      reason: conversion is performed only by the host inspect and apply tools
  host-policies: [workspace-confined, host-consent, permission-ceiling, user-language]
---

Use Cognia's typed conversion tools; do not recreate converted manifests or runtime files yourself.

This skill is explicit-only. Loading its instructions does not authorize an apply: the host owns workspace confinement, plan freshness, output-directory checks, and the desktop confirmation before writes.

## Inspect before writing

1. Resolve the source plugin directory relative to the active workspace and the requested target: `cognia`, `claude-code`, `codex`, `gemini-cli`, `agent-plugins`, `cursor`, `copilot`, `kimi`, `devin`, `opencode`, or `pi`.
2. Call `plugin_conversion_inspect` with the intended `surface` (`cli`, `desktop`, or `cloud`).
3. Report the detected source format, fidelity, per-capability delivery outcomes, warnings, and blocking issues. Distinguish a native package from Cognia-hosted tools and identify capabilities retained in Cognia.
4. If `applicable` is false or `blocking` is non-empty, stop. Explain the unsupported behavior; do not approximate or drop it.

Foreign → foreign conversion passes through Cognia's canonical representation. Support depends on each contribution and target, not just the manifest format. Unsupported invocation controls, hooks, agents, runtime code, and configuration semantics block conversion. A generated package is not evidence of an installed or authenticated host; cloud delivery remains unverified. A Cognia-hosted tool alternative requires an enabled plugin in a supported Cognia external-agent session and is not a standalone export.

## Apply the inspected plan

Only call `plugin_conversion_apply` with the exact `planId` returned by the latest inspection. Use a new or empty output directory relative to the active workspace. If the report contains warnings, explain them and pass `acknowledgeWarnings: true` only after the user accepts them. The user will receive a desktop confirmation before files are written.

Treat these errors as safety signals:

- Source changed or plan expired: inspect again and review the new report.
- Output is non-empty: choose another empty directory; do not delete or overwrite existing work.
- Source and output overlap: choose a separate sibling directory.

After a successful apply, report the plugin id, target format, output directory, written files, and remaining warnings. Never hand-edit the deterministic conversion output as part of the conversion step.
