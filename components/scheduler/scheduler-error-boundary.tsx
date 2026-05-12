"use client"

import { Component, type ReactNode } from "react"
import { PanelErrorState } from "./empty-states"

interface SchedulerErrorBoundaryProps {
  children: ReactNode
  fallback?: ReactNode
  /**
   * Optional retry callback. When provided, the fallback shows a Retry button
   * that calls this and resets the boundary's internal error state.
   */
  onReset?: () => void
  /** Identifies which panel crashed in logs. */
  panelName?: string
}

interface SchedulerErrorBoundaryState {
  error: Error | null
}

/**
 * Per-panel error boundary. Crashing one panel (sidebar / dashboard / detail)
 * leaves the rest of the scheduler operable instead of blanking the route.
 */
export class SchedulerErrorBoundary extends Component<
  SchedulerErrorBoundaryProps,
  SchedulerErrorBoundaryState
> {
  state: SchedulerErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): SchedulerErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error): void {
    const label = this.props.panelName ? `[${this.props.panelName}] ` : ""
    console.error(`${label}Scheduler panel crashed:`, error)
  }

  handleRetry = (): void => {
    this.setState({ error: null })
    this.props.onReset?.()
  }

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback !== undefined) {
        return this.props.fallback
      }
      return <PanelErrorState description={this.state.error.message} onRetry={this.handleRetry} />
    }
    return this.props.children
  }
}
