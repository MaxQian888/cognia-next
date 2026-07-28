"use client"

import { useCallback, useEffect, useState } from "react"
import { listen } from "@tauri-apps/api/event"
import { useLocale, useTranslations } from "next-intl"
import {
  CheckIcon,
  ChevronDownIcon,
  ClipboardIcon,
  LanguagesIcon,
  MessageCircleQuestionIcon,
  SparklesIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { getPref, setPref } from "@/lib/tauri/store"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import { isTauri } from "@/lib/tauri"
import {
  executeSelectionToolbarAction,
  getCurrentSelectionCandidate,
  revealSelectionToolbar,
  SELECTION_CANDIDATE_EVENT,
  SELECTION_DISMISS_EVENT,
  setSelectionToolbarInteractive,
  type ExternalSelectionCandidate,
  type SelectionToolbarAction,
} from "@/lib/tauri/selection-toolbar"

export const SELECTION_TRANSLATE_LOCALE_PREF = "selectionToolbar.translateLocale"

const TARGET_LOCALES = ["zh-CN", "en", "ja", "ko", "fr", "de", "es"] as const
type TargetLocale = (typeof TARGET_LOCALES)[number]

function initialTargetLocale(locale: string): TargetLocale {
  if (locale.toLowerCase().startsWith("zh")) return "zh-CN"
  const language = locale.split("-")[0]
  return TARGET_LOCALES.includes(language as TargetLocale) ? (language as TargetLocale) : "en"
}

export function SelectionToolbarView() {
  const t = useTranslations("selectionToolbar")
  const locale = useLocale()
  const [candidate, setCandidate] = useState<ExternalSelectionCandidate | null>(null)
  const [targetLocale, setTargetLocale] = useState<TargetLocale>(() => initialTargetLocale(locale))

  useEffect(() => {
    if (!isTauri()) return
    document.documentElement.setAttribute("data-selection-toolbar", "true")
    let alive = true
    const unlistens: Array<() => void | Promise<void>> = []
    void Promise.all([
      getCurrentSelectionCandidate().then((current) => {
        if (alive) setCandidate(current)
      }),
      getPref<string>(SELECTION_TRANSLATE_LOCALE_PREF).then((saved) => {
        if (alive && TARGET_LOCALES.includes(saved as TargetLocale)) {
          setTargetLocale(saved as TargetLocale)
        }
      }),
      listen<ExternalSelectionCandidate>(SELECTION_CANDIDATE_EVENT, (event) => {
        if (alive) setCandidate(event.payload)
      }).then((unlisten) => {
        if (alive) unlistens.push(unlisten)
        else safeUnlisten(unlisten)
      }),
      listen(SELECTION_DISMISS_EVENT, () => {
        if (alive) setCandidate(null)
      }).then((unlisten) => {
        if (alive) unlistens.push(unlisten)
        else safeUnlisten(unlisten)
      }),
    ])
    return () => {
      alive = false
      document.documentElement.removeAttribute("data-selection-toolbar")
      unlistens.forEach(safeUnlisten)
    }
  }, [])

  const candidateId = candidate?.id
  useEffect(() => {
    if (!candidateId) return
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => void revealSelectionToolbar())
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
    }
  }, [candidateId])

  const execute = useCallback(
    (action: SelectionToolbarAction) => {
      if (!candidate) return
      void executeSelectionToolbarAction(candidate.id, action)
    },
    [candidate]
  )

  const chooseTarget = useCallback(
    (next: TargetLocale) => {
      setTargetLocale(next)
      void setPref(SELECTION_TRANSLATE_LOCALE_PREF, next)
      execute({ kind: "translate", targetLocale: next })
    },
    [execute]
  )

  if (!candidate) return null

  const source = candidate.sourceTitle
    ? `${candidate.sourceApp} · ${candidate.sourceTitle}`
    : candidate.sourceApp

  return (
    <div
      className="flex h-11 w-full select-none items-center justify-center px-1"
      data-testid="selection-toolbar"
      title={source}
    >
      <div className="flex h-9 items-center gap-0.5 rounded-xl border bg-popover/95 p-1 text-popover-foreground shadow-xl backdrop-blur-xl">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label={t("copy")}
          onClick={() => execute({ kind: "copy" })}
        >
          <ClipboardIcon />
          {t("copy")}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label={t("explain")}
          onClick={() => execute({ kind: "explain" })}
        >
          <SparklesIcon />
          {t("explain")}
        </Button>
        <div className="flex items-center">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="rounded-r-none pr-1"
            aria-label={t("translate")}
            onClick={() => execute({ kind: "translate", targetLocale })}
          >
            <LanguagesIcon />
            {t("translate")}
          </Button>
          <DropdownMenu
            onOpenChange={(open) => {
              void setSelectionToolbarInteractive(open)
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="rounded-l-none"
                aria-label={t("chooseLanguage")}
              >
                <ChevronDownIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="bottom" className="min-w-36">
              {TARGET_LOCALES.map((target) => (
                <DropdownMenuItem key={target} onSelect={() => chooseTarget(target)}>
                  <span className="flex-1">{t(`languages.${target}`)}</span>
                  {target === targetLocale ? <CheckIcon /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label={t("ask")}
          onClick={() => execute({ kind: "ask" })}
        >
          <MessageCircleQuestionIcon />
          {t("ask")}
        </Button>
        {candidate.truncated ? (
          <span className="px-1 text-[10px] text-amber-600" title={t("truncatedHint")}>
            {t("truncated")}
          </span>
        ) : null}
      </div>
    </div>
  )
}

export default SelectionToolbarView
