"use client"

import { useTranslations } from "next-intl"
import { SearchIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

export interface DiscoverSearchProps {
  value: string
  onChange: (next: string) => void
  className?: string
}

export function DiscoverSearch({ value, onChange, className }: DiscoverSearchProps) {
  const t = useTranslations("mobile.discover")
  const tShell = useTranslations("mobile.shell")
  return (
    <div className={cn("relative", className)} data-testid="discover-search">
      <SearchIcon
        aria-hidden="true"
        className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("search")}
        aria-label={t("searchAria")}
        data-testid="discover-search-input"
        className="h-9 pl-9 pr-9"
      />
      {value.length > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={tShell("clearSearch")}
          data-testid="discover-search-clear"
          onClick={() => onChange("")}
          className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
        >
          <XIcon />
        </Button>
      ) : null}
    </div>
  )
}
