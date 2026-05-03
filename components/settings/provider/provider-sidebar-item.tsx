"use client"

import React, { useCallback } from "react"
import { cn } from "@/lib/utils"

export type ProviderConnectionStatus = "connected" | "warning" | "not-configured" | "error"

interface ProviderSidebarItemProps {
  providerId: string
  name: string
  icon?: string | React.ReactNode
  subtitle: string
  status: ProviderConnectionStatus
  isSelected: boolean
  onClick: (providerId: string) => void
}

const STATUS_COLORS: Record<ProviderConnectionStatus, string> = {
  connected: "bg-green-500",
  warning: "bg-yellow-500",
  "not-configured": "bg-red-400",
  error: "bg-red-500",
}

export const ProviderSidebarItem = React.memo(function ProviderSidebarItem({
  providerId,
  name,
  icon,
  subtitle,
  status,
  isSelected,
  onClick,
}: ProviderSidebarItemProps) {
  const handleClick = useCallback(() => onClick(providerId), [onClick, providerId])

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
        isSelected ? "bg-primary text-primary-foreground" : "hover:bg-muted/50"
      )}
    >
      <div
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sm",
          isSelected ? "bg-primary-foreground/20" : "bg-muted"
        )}
      >
        {icon ?? name.charAt(0)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{name}</div>
        <div
          className={cn(
            "truncate text-xs",
            isSelected ? "text-primary-foreground/70" : "text-muted-foreground"
          )}
        >
          {subtitle}
        </div>
      </div>
      <span
        data-status={status}
        className={cn("h-2 w-2 shrink-0 rounded-full", STATUS_COLORS[status])}
      />
    </button>
  )
})
