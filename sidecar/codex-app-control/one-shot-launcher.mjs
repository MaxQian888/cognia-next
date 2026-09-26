#!/usr/bin/env node
// @ts-check
// launchd one-shot wrapper (ADR-0197 launcher: cdp-relaunch.ts submits this
// path). The implementation is one-shot.ts.
import { runOneShot } from "./one-shot.ts"

process.exitCode = await runOneShot(process.argv.slice(2))
