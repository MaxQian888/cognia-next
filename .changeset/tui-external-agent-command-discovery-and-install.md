---
"cognia-next": minor
---

CLI TUI external agents: the `--backend <codex|claude-code|…>` startup now finds an agent CLI wherever it was officially installed. The Node backend gained parity with the Rust command resolver — the readiness probe and the spawned process both search the well-known install roots a minimal (non-login-shell) environment omits, on top of `PATH`: Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`), `~/.local/bin`, `~/.cargo/bin`, `~/.bun/bin`, `~/.volta/bin`, `~/.npm-global/bin`, `~/.deno/bin`, `~/Library/pnpm`, `~/.nix-profile/bin`, and the `PNPM_HOME` / `BUN_INSTALL` / `VOLTA_HOME` / `NVM_BIN` / `CARGO_HOME` roots — so a Homebrew/npm/cargo/native-installer binary is no longer reported "not installed or isn't on PATH". When a binary genuinely is missing, the backend-startup failure page now offers to install it from an officially-supported method (npm/pnpm/brew, or the vendor's curl installer for cursor-agent/droid) whose prerequisites are present, streaming the installer output on a new "installing" screen and reconnecting automatically on success.
</content>
