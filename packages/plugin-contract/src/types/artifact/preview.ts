/**
 * Artifact preview type definitions
 */

import type { ReactNode } from "react"

export interface PreviewErrorBoundaryProps {
  children: ReactNode
  fallback?: ReactNode
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void
  errorMessage?: string
}

export interface PreviewErrorBoundaryState {
  hasError: boolean
  error: Error | null
}
