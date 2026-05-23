"use client"

/**
 * Inbox subsystem error boundary.
 *
 * Clones the class-based pattern used by the eight sibling subsystem
 * boundaries (canvas / scheduler / a2ui / chat-renderer / math / artifact
 * / plugin extension slot). Each subsystem owns its own boundary so a
 * Dexie failure inside `ConversationList` does not blank out the entire
 * Inbox page, and so the fallback can speak the subsystem's vocabulary
 * (retry semantics, link targets) without a shared abstraction.
 *
 * Default fallback uses `StateCard.Error` which exposes both a Retry
 * affordance (calls `onReset`) and a Copy-stack affordance for paste-
 * into-incident-ticket workflows.
 */

import React, { Component, type ReactNode } from "react"
import { StateCard } from "./state/state-card"
import { loggers } from "@/lib/logging"

export interface InboxErrorBoundaryProps {
  children: ReactNode
  /** Customise the fallback (default: `StateCard.Error`). */
  fallback?: ReactNode
  /** Fires once on each catch; useful for telemetry from above. */
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void
  /** Fires when the user clicks Retry in the default fallback. */
  onReset?: () => void
}

interface State {
  hasError: boolean
  error: Error | null
  errorInfo: React.ErrorInfo | null
}

export class InboxErrorBoundary extends Component<InboxErrorBoundaryProps, State> {
  state: State = { hasError: false, error: null, errorInfo: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    this.setState({ errorInfo })
    loggers.ui.error("Inbox error:", error, { errorInfo })
    this.props.onError?.(error, errorInfo)
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null })
    this.props.onReset?.()
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      const stack =
        this.state.error?.stack ??
        (this.state.errorInfo ? String(this.state.errorInfo.componentStack ?? "") : undefined)
      return (
        <div className="p-3" data-testid="inbox-error-boundary">
          <StateCard.Error
            description={this.state.error?.message}
            onRetry={this.handleReset}
            stackTrace={stack}
          />
        </div>
      )
    }
    return this.props.children
  }
}
