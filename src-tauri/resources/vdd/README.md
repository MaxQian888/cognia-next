# Bundled virtual-display driver (screen-off Computer Use)

This directory holds the **Microsoft-signed, MIT-licensed** [`parsec-vdd`](https://github.com/nomi-san/parsec-vdd)
driver payload that powers screen-off Computer Use (ADR-0020 follow-up). The
files are **vendored at packaging time** — they are intentionally not committed
to the repo so the signed binaries are pulled from the upstream release rather
than mirrored here.

## Required files

Place the signed driver package here (filenames must match what
`src/bin/cognia-vdd-setup.rs` and `automation::virtual_display::parsec_vdd`
expect):

```
resources/vdd/
  parsec-vdd.inf      # driver INF (pnputil /add-driver target)
  parsec-vdd.sys      # the signed kernel/user-mode driver binary
  parsec-vdd.cat      # the security catalog (Microsoft signature)
```

## Packaging wiring (manual, not yet committed)

`tauri.conf.json` must copy this directory next to the app + helper binaries so
`cognia-vdd-setup.exe` finds `vdd\parsec-vdd.inf` relative to its own path. Add
to `bundle.resources` (Windows target):

```jsonc
"resources": {
  // …existing entries…
  "resources/vdd/*": "vdd/"
}
```

Leave this out until the signed payload is present — Tauri validates resource
globs at build time and an empty glob fails the build.

## Verification

After bundling, confirm the driver stays Microsoft-signed (no SmartScreen /
signature warning on install) and run the on-hardware acceptance steps in the
implementation plan (`~/.claude/plans/codex-computeruse-shimmying-gadget.md`),
especially the **DisplayPort-monitor-off** case.
