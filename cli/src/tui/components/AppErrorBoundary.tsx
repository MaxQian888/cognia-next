/**
 * A React error boundary around the TUI render tree. Before this existed, a
 * render-time throw anywhere in the component tree bubbled straight out of Ink —
 * tearing the app down with no in-UI surface and, worse, potentially leaving the
 * terminal in the alternate-screen / raw-mouse state.
 *
 * The boundary catches the throw, logs a structured crash record (injected
 * `onCrash`), and renders a friendly, self-contained fallback (no theme context —
 * it sits ABOVE the ThemeProvider). Pressing `r` bumps a remount key so the whole
 * subtree re-mounts from a clean state (a fresh session — the transcript is lost,
 * but the app is usable again instead of dead). `q`/Esc exits cleanly so the
 * caller's terminal-restore `finally` runs.
 *
 * Note: an error boundary only catches errors thrown during render/lifecycle —
 * NOT async callbacks or promise rejections. Those are covered separately by the
 * `process.on('uncaughtException'|'unhandledRejection')` guards in `mount.tsx`.
 */
import React from "react"
import { Box, Text, useApp } from "ink"
import { useCriticalInput } from "../input/input-router"

export interface AppErrorBoundaryProps {
  children: React.ReactNode
  /** Called once per caught error with the error + the React component stack
   * (which React may report as null). */
  onCrash?: (error: Error, componentStack?: string | null) => void
  /** Test seam: overrides the built-in reset/exit key handling. */
  onReset?: () => void
}

interface AppErrorBoundaryState {
  error: Error | null
  /** Bumped on reset so `children` fully remount from scratch. */
  resetKey: number
}

export class AppErrorBoundary extends React.Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null, resetKey: 0 }

  static getDerivedStateFromError(error: Error): Partial<AppErrorBoundaryState> {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.props.onCrash?.(error, info.componentStack)
  }

  private reset = (): void => {
    if (this.props.onReset) {
      this.props.onReset()
      return
    }
    // Clear the error AND bump the remount key so the child subtree is rebuilt
    // from a clean slate (re-rendering the same tree would just re-throw).
    this.setState((s) => ({ error: null, resetKey: s.resetKey + 1 }))
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return <CrashFallback error={this.state.error} onReset={this.reset} />
    }
    // `key` forces a full remount when reset is pressed.
    return <React.Fragment key={this.state.resetKey}>{this.props.children}</React.Fragment>
  }
}

/** The fallback UI. A functional child so it can use Ink hooks (the boundary
 * itself must be a class component). */
function CrashFallback({
  error,
  onReset,
}: {
  error: Error
  onReset: () => void
}): React.ReactElement {
  const { exit } = useApp()
  useCriticalInput(
    (input, key) => {
      if (input === "r") onReset()
      else if (input === "q" || key.escape) exit()
    },
    {
      shouldHandle: (input, key) => input === "r" || input === "q" || key.escape,
    }
  )
  // First few stack frames — enough to locate the fault without flooding the pane.
  const stackTail = (error.stack ?? "")
    .split("\n")
    .slice(1, 4)
    .map((l) => l.trim())
    .filter(Boolean)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
      <Text color="red" bold>
        ✗ Something went wrong
      </Text>
      <Text>{error.message || "Unknown error"}</Text>
      {stackTail.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {stackTail.map((line, i) => (
            <Text key={i} color="gray" dimColor>
              {line}
            </Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          The error was logged. Press r to reset the session · q or Esc to quit.
        </Text>
      </Box>
    </Box>
  )
}
