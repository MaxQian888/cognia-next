#!/usr/bin/env node
// @ts-check
// Detached relaunch worker (ADR-0197 launcher: cdp-relaunch.ts submits this
// path to launchd). The implementation is relaunch-worker.ts.
import { runCdpOnlyRelaunchWorker } from "./relaunch-worker.ts"

process.exitCode = await runCdpOnlyRelaunchWorker(process.argv.slice(2))
