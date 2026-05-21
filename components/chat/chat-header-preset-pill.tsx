"use client"

// Active-preset pill rendered in the chat header bar (next to the model
// badge). Surfaces the system-prompt preset that the session is currently
// configured from — invisible without this UI, since the existing preset
// switcher is buried inside the chat-header settings Popover (5-section
// form behind the gear icon). Clicking the pill opens a focused Popover
// listing favorited + recent + grouped presets; the parent owns
// conflict-resolution and the actual apply.

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { SparklesIcon } from "lucide-react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { ChatSession, SystemPromptPreset } from "@/lib/claude/types"
import { groupPresets } from "@/lib/presets/group-presets"
import { cn } from "@/lib/utils"

export interface ChatHeaderPresetPillProps {
  session: Pick<ChatSession, "activePresetId" | "systemPrompt">
  presets: SystemPromptPreset[]
  onSelectPreset: (preset: SystemPromptPreset) => void
  /** Where the "Manage all presets…" footer link points. */
  manageHref?: string
}

/**
 * Resolve the active preset for a session. Source of truth is
 * `session.activePresetId`; falls back to a content-equality match for
 * legacy sessions written before that field existed.
 */
export function resolveActivePreset(
  session: Pick<ChatSession, "activePresetId" | "systemPrompt">,
  presets: SystemPromptPreset[]
): SystemPromptPreset | null {
  if (session.activePresetId) {
    const byId = presets.find((p) => p.id === session.activePresetId)
    if (byId) return byId
  }
  if (session.systemPrompt && session.systemPrompt.trim().length > 0) {
    return presets.find((p) => p.content === session.systemPrompt) ?? null
  }
  return null
}

export function ChatHeaderPresetPill({
  session,
  presets,
  onSelectPreset,
  manageHref = "/settings?section=presets",
}: ChatHeaderPresetPillProps) {
  const t = useTranslations("chat.header.presetPill")
  const tGroups = useTranslations("chat.header.groups")
  const tCategory = useTranslations("presets.category")
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")

  const activePreset = useMemo(() => resolveActivePreset(session, presets), [session, presets])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return presets
    return presets.filter((p) => {
      return (
        p.name.toLowerCase().includes(q) ||
        (p.description?.toLowerCase().includes(q) ?? false) ||
        (p.category?.toLowerCase().includes(q) ?? false)
      )
    })
  }, [presets, query])

  const groups = useMemo(() => groupPresets(filtered), [filtered])

  const safeTGroups = (k: string, fallback: string) => {
    const out = tGroups(k as never)
    return out === `chat.header.groups.${k}` || out === k ? fallback : out
  }
  const safeTCategory = (k: string, fallback: string) => {
    const out = tCategory(k as never)
    return out === `presets.category.${k}` || out === k ? fallback : out
  }

  const handlePick = (preset: SystemPromptPreset) => {
    onSelectPreset(preset)
    setOpen(false)
    setQuery("")
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          aria-label={t("ariaLabel")}
          data-testid="chat-header-preset-pill"
        >
          <SparklesIcon className="size-3" />
          <span className="max-w-[14ch] truncate">{activePreset?.name ?? t("none")}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-1rem))] p-0">
        <div className="border-b p-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="h-8 text-xs"
            aria-label={t("searchAriaLabel")}
          />
        </div>
        <ScrollArea className="max-h-72">
          <div className="space-y-3 p-2" data-testid="chat-header-preset-pill-list">
            {groups.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">{t("empty")}</p>
            ) : (
              groups.map((group) => (
                <div key={group.label} className="space-y-1">
                  <p className="px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {group.translateLabel
                      ? safeTGroups(group.label, group.label)
                      : safeTCategory(group.label, group.label)}
                  </p>
                  <div className="space-y-1">
                    {group.presets.map((p) => {
                      const isActive = activePreset?.id === p.id
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => handlePick(p)}
                          aria-pressed={isActive}
                          className={cn(
                            "flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors",
                            isActive
                              ? "border-primary bg-primary/10"
                              : "border-transparent hover:bg-muted"
                          )}
                          data-testid={`chat-header-preset-pill-row-${p.id}`}
                        >
                          <span
                            className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[10px]"
                            style={{
                              backgroundColor: p.color ?? "oklch(0.7 0.14 250)",
                              color: "white",
                            }}
                            aria-hidden
                          >
                            {p.icon?.trim() || p.name.charAt(0).toUpperCase() || "?"}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{p.name}</span>
                            {p.description && (
                              <span className="block truncate text-[11px] text-muted-foreground">
                                {p.description}
                              </span>
                            )}
                          </span>
                          {p.isDefault && (
                            <Badge variant="secondary" className="text-[10px]">
                              {t("defaultBadge")}
                            </Badge>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
        <div className="border-t p-2 text-right">
          <Button asChild variant="ghost" size="sm" className="text-xs">
            <Link href={manageHref} onClick={() => setOpen(false)}>
              {t("manageAll")}
            </Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
