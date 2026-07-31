---
name: plugin-conversion
description: Convert complete plugin bundles between Cognia and Claude Code, Codex, or Gemini CLI using Cognia's deterministic converter. Use when a user asks to import, export, migrate, port, or assess a plugin bundle across these ecosystems.
allowed-tools:
  - inspect_plugin_conversion
  - apply_plugin_conversion
metadata:
  surface: []
---

Use Cognia's typed conversion tools; do not recreate converted manifests or runtime files yourself.

## Inspect before writing

1. Resolve the source plugin directory relative to the active workspace and the requested target: `cognia`, `claude-code`, `codex`, or `gemini-cli`.
2. Call `inspect_plugin_conversion`.
3. Report the detected source format, fidelity, converted capabilities, warnings, and blocking issues.
4. If `applicable` is false or `blocking` is non-empty, stop. Explain the unsupported behavior; do not approximate or drop it.

The supported whole-bundle paths are foreign ecosystem → Cognia and Cognia → foreign ecosystem. Foreign → foreign conversion fails closed.

## Apply the inspected plan

Only call `apply_plugin_conversion` with the exact `planId` returned by the latest inspection. Use a new or empty output directory relative to the active workspace. The user will receive a desktop confirmation before files are written.

Treat these errors as safety signals:

- Source changed or plan expired: inspect again and review the new report.
- Output is non-empty: choose another empty directory; do not delete or overwrite existing work.
- Source and output overlap: choose a separate sibling directory.

After a successful apply, report the plugin id, target format, output directory, written files, and remaining warnings. Never hand-edit the deterministic conversion output as part of the conversion step.
