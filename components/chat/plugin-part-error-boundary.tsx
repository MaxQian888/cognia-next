"use client"

/**
 * Crash isolation for plugin-supplied chat renderers.
 *
 * Shared by both plugin rendering seams:
 *   - `message-renderer.tsx` — custom `part.type` renderers
 *   - `message-parts/mcp-tool-card.tsx` — tool-result cards
 *
 * It lives in its own module rather than inside `message-renderer.tsx` because
 * that file already imports `mcp-tool-card.tsx`; keeping the boundary there
 * would make the second call site a cycle.
 *
 * A third-party component throwing must degrade to an inline diagnostic, never
 * unmount the surrounding message — a broken plugin should cost the user one
 * card, not the transcript.
 */

import React from "react"

import { loggers } from "@cognia/logging"

export interface PluginPartErrorBoundaryProps {
  /** Part type or tool name the plugin claimed — shown in the diagnostic. */
  type: string
  pluginId: string
  /** What the plugin contributed, for the log line. Defaults to a part renderer. */
  kind?: "message-part" | "tool-result"
  children: React.ReactNode
}

export class PluginPartErrorBoundary extends React.Component<
  PluginPartErrorBoundaryProps,
  { error: Error | null }
> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error): void {
    loggers.chat.warn(
      this.props.kind === "tool-result"
        ? "plugin tool-result renderer threw"
        : "plugin message-part renderer threw",
      {
        pluginId: this.props.pluginId,
        partType: this.props.type,
        err: error.message,
      }
    )
  }
  render() {
    if (this.state.error) {
      return (
        <div
          data-testid="plugin-part-error"
          data-plugin-id={this.props.pluginId}
          data-part-type={this.props.type}
          className="my-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {/* i18n-exempt: plugin-crash diagnostic; class ErrorBoundary cannot use i18n hooks */}
          Plugin renderer for &quot;{this.props.type}&quot; crashed: {this.state.error.message}
        </div>
      )
    }
    return this.props.children
  }
}

export default PluginPartErrorBoundary
