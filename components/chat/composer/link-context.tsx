"use client"

import { FormEvent, useState } from "react"
import { Link2Icon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ExternalLink } from "@/components/shared/external-link"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { extractHttpUrls, normalizeHttpUrl } from "@/lib/chat/link-context"
import { cn } from "@/lib/utils"

export interface ComposerLinkChipsProps {
  text: string
  onRemove: (url: string) => void
}

export function ComposerLinkChips({ text, onRemove }: ComposerLinkChipsProps) {
  const t = useTranslations("chat.composer.links")
  const urls = extractHttpUrls(text)
  if (urls.length === 0) return null

  return urls.map((url) => {
    const host = new URL(url).hostname
    return (
      <div
        key={url}
        className="group inline-flex h-7 max-w-56 items-center gap-1 rounded-md border bg-muted/40 px-1.5 text-xs"
      >
        <Link2Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <ExternalLink
          href={url}
          aria-label={t("openAria", { host })}
          className="truncate hover:text-primary hover:underline"
        >
          {host}
        </ExternalLink>
        <TooltipIconButton
          type="button"
          size="icon-xs"
          className="shrink-0 opacity-60 hover:opacity-100"
          onClick={() => onRemove(url)}
          aria-label={t("removeAria", { host })}
          tooltip={t("removeAria", { host })}
        >
          <XIcon />
        </TooltipIconButton>
      </div>
    )
  })
}

export interface ComposerLinkButtonProps {
  disabled?: boolean
  onAdd: (url: string) => void
  className?: string
}

export function ComposerLinkButton({ disabled, onAdd, className }: ComposerLinkButtonProps) {
  const t = useTranslations("chat.composer.links")
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState("")
  const [invalid, setInvalid] = useState(false)

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalized = normalizeHttpUrl(value)
    if (!normalized) {
      setInvalid(true)
      return
    }
    onAdd(normalized)
    setValue("")
    setInvalid(false)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          aria-label={t("add")}
          className={cn("size-9 text-muted-foreground hover:text-foreground", className)}
        >
          <Link2Icon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3">
        <form onSubmit={submit} className="flex flex-col gap-2">
          <Input
            autoFocus
            type="url"
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              if (invalid) setInvalid(false)
            }}
            aria-label={t("inputAria")}
            aria-invalid={invalid}
            placeholder={t("inputPlaceholder")}
          />
          {invalid ? <p className="text-xs text-destructive">{t("invalid")}</p> : null}
          <Button type="submit" size="sm" disabled={!value.trim()}>
            <Link2Icon data-icon="inline-start" />
            {t("addAction")}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}
