/**
 * Agent module constants and shared configurations
 */

import {
  Clock,
  Loader2,
  Pause,
  CheckCircle,
  XCircle,
  AlertTriangle,
  type LucideIcon,
} from "lucide-react"
import type { SubAgentStatus } from "@/types/agent/sub-agent"
import type { BackgroundAgentStatus } from "@/types/agent/background-agent"

/**
 * Status configuration for visual display
 */
export interface StatusConfig {
  icon: LucideIcon
  color: string
  bgColor: string
  label: string
  animate?: boolean
}

/**
 * Sub-agent status configuration
 */
export const SUB_AGENT_STATUS_CONFIG: Record<SubAgentStatus, StatusConfig> = {
  pending: {
    icon: Clock,
    color: "text-muted-foreground",
    bgColor: "bg-muted",
    label: "Pending",
  },
  queued: {
    icon: Clock,
    color: "text-blue-500",
    bgColor: "bg-blue-50 dark:bg-blue-950",
    label: "Queued",
  },
  running: {
    icon: Loader2,
    color: "text-primary",
    bgColor: "bg-primary/10",
    label: "Running",
    animate: true,
  },
  waiting: {
    icon: Pause,
    color: "text-yellow-500",
    bgColor: "bg-yellow-50 dark:bg-yellow-950",
    label: "Waiting",
  },
  completed: {
    icon: CheckCircle,
    color: "text-green-500",
    bgColor: "bg-green-50 dark:bg-green-950",
    label: "Completed",
  },
  failed: {
    icon: XCircle,
    color: "text-destructive",
    bgColor: "bg-destructive/10",
    label: "Failed",
  },
  cancelled: {
    icon: XCircle,
    color: "text-orange-500",
    bgColor: "bg-orange-50 dark:bg-orange-950",
    label: "Cancelled",
  },
  timeout: {
    icon: AlertTriangle,
    color: "text-red-500",
    bgColor: "bg-red-50 dark:bg-red-950",
    label: "Timeout",
  },
}

/**
 * Background agent status configuration
 */
export const BACKGROUND_AGENT_STATUS_CONFIG: Record<BackgroundAgentStatus, StatusConfig> = {
  idle: {
    icon: Clock,
    color: "text-muted-foreground",
    bgColor: "bg-muted",
    label: "Idle",
  },
  queued: {
    icon: Clock,
    color: "text-blue-500",
    bgColor: "bg-blue-50 dark:bg-blue-950",
    label: "Queued",
  },
  initializing: {
    icon: Loader2,
    color: "text-blue-500",
    bgColor: "bg-blue-50 dark:bg-blue-950",
    label: "Initializing",
  },
  running: {
    icon: Loader2,
    color: "text-primary",
    bgColor: "bg-primary/10",
    label: "Running",
    animate: true,
  },
  paused: {
    icon: Pause,
    color: "text-yellow-500",
    bgColor: "bg-yellow-50 dark:bg-yellow-950",
    label: "Paused",
  },
  waiting: {
    icon: Clock,
    color: "text-orange-500",
    bgColor: "bg-orange-50 dark:bg-orange-950",
    label: "Waiting",
  },
  completed: {
    icon: CheckCircle,
    color: "text-green-500",
    bgColor: "bg-green-50 dark:bg-green-950",
    label: "Completed",
  },
  failed: {
    icon: XCircle,
    color: "text-destructive",
    bgColor: "bg-destructive/10",
    label: "Failed",
  },
  cancelled: {
    icon: XCircle,
    color: "text-orange-500",
    bgColor: "bg-orange-50 dark:bg-orange-950",
    label: "Cancelled",
  },
  timeout: {
    icon: XCircle,
    color: "text-red-500",
    bgColor: "bg-red-50 dark:bg-red-950",
    label: "Timeout",
  },
}

/**
 * Log level configuration for agent logs
 */
export const LOG_LEVEL_CONFIG: Record<string, { icon: LucideIcon; color: string }> = {
  info: { icon: AlertTriangle, color: "text-blue-500" },
  warn: { icon: AlertTriangle, color: "text-yellow-500" },
  error: { icon: XCircle, color: "text-destructive" },
  debug: { icon: Clock, color: "text-muted-foreground" },
  success: { icon: CheckCircle, color: "text-green-500" },
}

/**
 * Get status config with fallback
 */
export function getSubAgentStatusConfig(status: SubAgentStatus | string): StatusConfig {
  return SUB_AGENT_STATUS_CONFIG[status as SubAgentStatus] || SUB_AGENT_STATUS_CONFIG.pending
}

/**
 * Get background agent status config with fallback
 */
export function getBackgroundAgentStatusConfig(
  status: BackgroundAgentStatus | string
): StatusConfig {
  return (
    BACKGROUND_AGENT_STATUS_CONFIG[status as BackgroundAgentStatus] ||
    BACKGROUND_AGENT_STATUS_CONFIG.idle
  )
}
