"use client"

import { GitBranchIcon, LaptopIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import type { SessionExecutionLocation, SessionWorkspaceBaseSpec } from "@/types/execution-context"

export interface NewChatExecutionSelection {
  location: SessionExecutionLocation
  base: SessionWorkspaceBaseSpec
}

interface NewChatExecutionPickerProps {
  value: NewChatExecutionSelection
  onChange: (value: NewChatExecutionSelection) => void
  className?: string
}

type CommonBaseKind = "workingState" | "localHead" | "remoteDefault"

/** Product entry for choosing whether a new interactive chat edits Local or an isolated bundle. */
export function NewChatExecutionPicker({
  value,
  onChange,
  className,
}: NewChatExecutionPickerProps) {
  const t = useTranslations("chat.empty.execution")
  const baseKind: CommonBaseKind =
    value.base.kind === "localHead" || value.base.kind === "remoteDefault"
      ? value.base.kind
      : "workingState"

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <div
        role="group"
        aria-label={t("locationLabel")}
        className="inline-flex rounded-lg border bg-muted/35 p-0.5"
      >
        <Button
          type="button"
          size="sm"
          variant={value.location === "local" ? "secondary" : "ghost"}
          className="h-7 gap-1.5 px-2.5 text-xs"
          aria-pressed={value.location === "local"}
          onClick={() => onChange({ ...value, location: "local" })}
        >
          <LaptopIcon className="size-3.5" aria-hidden />
          {t("local")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={value.location === "managedWorktree" ? "secondary" : "ghost"}
          className="h-7 gap-1.5 px-2.5 text-xs"
          aria-pressed={value.location === "managedWorktree"}
          onClick={() => onChange({ ...value, location: "managedWorktree" })}
        >
          <GitBranchIcon className="size-3.5" aria-hidden />
          {t("worktree")}
        </Button>
      </div>

      {value.location === "managedWorktree" ? (
        <Select
          value={baseKind}
          onValueChange={(kind: CommonBaseKind) => onChange({ ...value, base: { kind } })}
        >
          <SelectTrigger size="sm" className="h-8 w-[10.5rem] text-xs" aria-label={t("baseLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="workingState">{t("bases.workingState")}</SelectItem>
            <SelectItem value="localHead">{t("bases.localHead")}</SelectItem>
            <SelectItem value="remoteDefault">{t("bases.remoteDefault")}</SelectItem>
          </SelectContent>
        </Select>
      ) : null}
    </div>
  )
}
