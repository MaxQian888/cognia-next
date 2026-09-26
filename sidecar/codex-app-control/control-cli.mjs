#!/usr/bin/env node
// @ts-check
// Process entry for Codex App control (ADR-0197 launcher: this path is what
// src-tauri/src/codex_app_dispatch.rs spawns). The implementation is cli.ts.
import { runControlCli } from "./cli.ts"

process.exitCode = await runControlCli(process.argv.slice(2))
