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
  /** Override the placeholder. Defaults to the `discover.search` message. */
  placeholder?: string
  /** Override the input's aria-label. Defaults to `discover.searchAria`. */
  ariaLabel?: string
  /**
   * Base test id. The wrapper uses `{testid}`, the input `{testid}-input`,
   * the clear button `{testid}-clear`. Defaults to `discover-search` so
   * existing Discover callers and tests keep their ids.
   */
  testid?: string
}

export function DiscoverSearch({
  value,
  onChange,
  className,
  placeholder,
  ariaLabel,
  testid = "discover-search",
}: DiscoverSearchProps) {
  const t = useTranslations("discover")
  const tShell = useTranslations("mobile.shell")
  return (
    <div className={cn("relative", className)} data-testid={testid}>
      <SearchIcon
        aria-hidden="true"
        className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? t("search")}
        aria-label={ariaLabel ?? t("searchAria")}
        data-testid={`${testid}-input`}
        className="h-9 pl-9 pr-9"
      />
      {value.length > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={tShell("clearSearch")}
          data-testid={`${testid}-clear`}
          onClick={() => onChange("")}
          className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
        >
          <XIcon />
        </Button>
      ) : null}
    </div>
  )
}
