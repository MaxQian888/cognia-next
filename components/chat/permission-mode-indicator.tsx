"use client"

// Status pill rendered at the bottom of the composer showing the active
// permission mode. Clicking it cycles through the modes (default →
// acceptEdits → plan → bypassPermissions → default), the same cycle as
// Shift+Tab on the textarea. Tooltip explains what each mode does.

import { useChatStore, type PermissionMode } from "@/stores/chat-store"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const ORDER: (PermissionMode | null)[] = [null, "acceptEdits", "plan", "bypassPermissions"]

const META: Record<string, { label: string; tooltip: string; toneClass: string }> = {
  null: {
    label: "Default",
    tooltip: "Tools prompt for permission as usual.",
    toneClass: "text-muted-foreground",
  },
  acceptEdits: {
    label: "Accept edits",
    tooltip: "Auto-approve file edits; other tools still prompt.",
    toneClass: "text-blue-500",
  },
  plan: {
    label: "Plan",
    tooltip: "Read-only planning mode — Claude proposes changes without applying them.",
    toneClass: "text-amber-500",
  },
  bypassPermissions: {
    label: "Bypass",
    tooltip: "All tools auto-approved. Use with care — Claude can run any command.",
    toneClass: "text-rose-500",
  },
}

export function nextPermissionMode(cur: PermissionMode | null): PermissionMode | null {
  const idx = ORDER.indexOf(cur)
  return ORDER[(idx + 1) % ORDER.length]
}

export interface PermissionModeIndicatorProps {
  /**
   * Called when the user clicks the chip. The composer keeps the per-session
   * persistence — this component just emits the desired next mode.
   */
  onCycle: (next: PermissionMode | null) => void
}

export function PermissionModeIndicator({ onCycle }: PermissionModeIndicatorProps) {
  const mode = useChatStore((s) => s.permissionMode)
  const meta = META[String(mode)] ?? META.null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => onCycle(nextPermissionMode(mode))}
          className={cn(
            "rounded border px-2 py-0.5 font-mono text-[11px] transition-colors hover:bg-accent",
            meta.toneClass
          )}
          aria-label={`Permission mode: ${meta.label}. Click to cycle.`}
        >
          ⇧⇥ {meta.label}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <p className="text-xs">{meta.tooltip}</p>
        <p className="mt-1 text-[10px] text-muted-foreground">Shift+Tab to cycle.</p>
      </TooltipContent>
    </Tooltip>
  )
}
