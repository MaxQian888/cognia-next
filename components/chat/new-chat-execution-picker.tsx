"use client"

import { useEffect, useState } from "react"
import { GitBranchIcon, LaptopIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { GitRefSelect } from "@/components/source-control/git-ref-select"
import { gitRefs } from "@/lib/git/commands"
import { cn } from "@/lib/utils"
import type { GitRef } from "@/types/git"
import type { SessionExecutionLocation, SessionWorkspaceBaseSpec } from "@/types/execution-context"

export interface NewChatExecutionSelection {
  location: SessionExecutionLocation
  base: SessionWorkspaceBaseSpec
}

interface NewChatExecutionPickerProps {
  value: NewChatExecutionSelection
  onChange: (value: NewChatExecutionSelection) => void
  rootDir?: string
  className?: string
}

type BaseKind = SessionWorkspaceBaseSpec["kind"]

/** Product entry for choosing whether a new interactive chat edits Local or an isolated bundle. */
export function NewChatExecutionPicker({
  value,
  onChange,
  rootDir,
  className,
}: NewChatExecutionPickerProps) {
  const t = useTranslations("chat.empty.execution")
  const [refs, setRefs] = useState<GitRef[]>([])

  useEffect(() => {
    if (!rootDir) return
    let alive = true
    void gitRefs(rootDir).then(
      (nextRefs) => {
        if (alive) setRefs(nextRefs)
      },
      () => {
        if (alive) setRefs([])
      }
    )
    return () => {
      alive = false
    }
  }, [rootDir])

  const availableRefs = rootDir ? refs : []
  const pullRequestBase = value.base.kind === "pullRequest" ? value.base : null

  const changeBaseKind = (kind: BaseKind) => {
    switch (kind) {
      case "workingState":
      case "localHead":
      case "remoteDefault":
        onChange({ ...value, base: { kind } })
        break
      case "gitRef":
        onChange({
          ...value,
          base: {
            kind,
            gitRef: availableRefs[0]?.name ?? "HEAD",
          },
        })
        break
      case "pullRequest":
        onChange({
          ...value,
          base: { kind, provider: "github", repo: "", number: 1 },
        })
        break
    }
  }

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
        <Select value={value.base.kind} onValueChange={(kind: BaseKind) => changeBaseKind(kind)}>
          <SelectTrigger size="sm" className="h-8 w-[10.5rem] text-xs" aria-label={t("baseLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="workingState">{t("bases.workingState")}</SelectItem>
            <SelectItem value="localHead">{t("bases.localHead")}</SelectItem>
            <SelectItem value="remoteDefault">{t("bases.remoteDefault")}</SelectItem>
            <SelectItem value="gitRef">{t("bases.gitRef")}</SelectItem>
            <SelectItem value="pullRequest">{t("bases.pullRequest")}</SelectItem>
          </SelectContent>
        </Select>
      ) : null}

      {value.location === "managedWorktree" && value.base.kind === "gitRef" ? (
        <GitRefSelect
          refs={availableRefs}
          value={value.base.gitRef}
          onValueChange={(gitRef) => onChange({ ...value, base: { kind: "gitRef", gitRef } })}
          placeholder={t("gitRefPlaceholder")}
          ariaLabel={t("gitRefLabel")}
          testId="new-chat-git-ref"
          className="h-8 w-[12rem] text-xs"
        />
      ) : null}

      {value.location === "managedWorktree" && pullRequestBase ? (
        <div className="flex items-center gap-2">
          <Input
            value={pullRequestBase.provider}
            onChange={(event) =>
              onChange({ ...value, base: { ...pullRequestBase, provider: event.target.value } })
            }
            aria-label={t("providerLabel")}
            placeholder={t("providerPlaceholder")}
            className="h-8 w-24 text-xs"
          />
          <Input
            value={pullRequestBase.repo}
            onChange={(event) =>
              onChange({ ...value, base: { ...pullRequestBase, repo: event.target.value } })
            }
            aria-label={t("repositoryLabel")}
            placeholder={t("repositoryPlaceholder")}
            className="h-8 w-36 text-xs"
          />
          <Input
            type="number"
            min={1}
            value={pullRequestBase.number}
            onChange={(event) => {
              const number = event.currentTarget.valueAsNumber
              if (Number.isInteger(number) && number > 0) {
                onChange({ ...value, base: { ...pullRequestBase, number } })
              }
            }}
            aria-label={t("pullRequestNumberLabel")}
            className="h-8 w-20 text-xs"
          />
        </div>
      ) : null}
    </div>
  )
}
