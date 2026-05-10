"use client"

import { useTranslations } from "next-intl"
import { SearchIcon, XIcon } from "lucide-react"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

export interface DiscoverSearchProps {
  value: string
  onChange: (next: string) => void
  className?: string
}

export function DiscoverSearch({ value, onChange, className }: DiscoverSearchProps) {
  const t = useTranslations("mobile.discover")
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
        <button
          type="button"
          aria-label="Clear search"
          data-testid="discover-search-clear"
          onClick={() => onChange("")}
          className="absolute right-2 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted"
        >
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}
