"use client"

/**
 * A dock tab.
 *
 * dockview's default tab is a title and a close button; everything that makes a
 * tab strip usable in an IDE — the italic preview slot, the dirty marker that
 * replaces the close affordance so you cannot lose work by aiming badly, the
 * unread badge a suppressed reveal leaves behind — has to be rendered here.
 *
 * The close button is also the interception point for the dirty guard: dockview
 * removes a panel synchronously and offers no cancellable pre-close hook, so
 * the confirmation has to happen *before* the removal is requested. That covers
 * every close the user can reach with a pointer or keyboard.
 */

import { useTranslations } from "next-intl"
import { XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { DockPanelInstance } from "@/types/dock/instance"

export interface DockTabProps {
  instance: DockPanelInstance
  title: string
  active: boolean
  /** Promote the preview slot to permanent. */
  onPin: (instanceId: string) => void
  onSelect: (instanceId: string) => void
  /** Returns false when the user cancelled a dirty-close confirmation. */
  onRequestClose: (instanceId: string) => void
}

export function DockTab({
  instance,
  title,
  active,
  onPin,
  onSelect,
  onRequestClose,
}: DockTabProps) {
  const t = useTranslations("dock.tabs")
  const preview = instance.mode === "preview"
  const unread = instance.unread ?? 0

  return (
    <div
      className={cn(
        "group flex h-full items-center gap-1 px-2 text-sm",
        active ? "bg-background" : "bg-muted/40 hover:bg-muted"
      )}
      data-testid={`dock-tab-${instance.instanceId}`}
      data-preview={preview ? "true" : undefined}
      data-dirty={instance.dirty ? "true" : undefined}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        className={cn("min-w-0 cursor-pointer truncate py-1", preview && "italic")}
        title={preview ? t("preview", { name: title }) : title}
        onClick={() => onSelect(instance.instanceId)}
        onDoubleClick={() => onPin(instance.instanceId)}
      >
        {title}
      </button>

      {unread > 0 ? (
        <span
          className="rounded-full bg-primary px-1.5 text-[10px] leading-4 text-primary-foreground"
          aria-label={t("unread", { count: unread })}
          data-testid={`dock-tab-unread-${instance.instanceId}`}
        >
          {unread > 9 ? "9+" : unread}
        </span>
      ) : null}

      <button
        type="button"
        aria-label={instance.dirty ? t("dirty", { name: title }) : t("close", { name: title })}
        data-testid={`dock-tab-close-${instance.instanceId}`}
        className={cn(
          "rounded p-0.5 hover:bg-accent",
          instance.dirty ? "text-amber-500" : "opacity-60 group-hover:opacity-100"
        )}
        onClick={(event) => {
          event.stopPropagation()
          onRequestClose(instance.instanceId)
        }}
      >
        {instance.dirty ? <span className="text-xs">●</span> : <XIcon className="size-3" />}
      </button>
    </div>
  )
}
