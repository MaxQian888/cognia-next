"use client"

/**
 * `<RunStatusBar>` is now the collapsed face of `<RunPanel>` — re-exported here
 * so the mount contract in `chat-view.tsx` (and existing imports) stays put
 * while the implementation lives in `./run-panel`.
 */
export { RunStatusBar, RunPanel, type RunStatusBarProps } from "./run-panel"
