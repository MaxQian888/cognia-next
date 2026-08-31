"use client"

// Narrow-pane drawer for /plugins. Wraps the existing PluginCategorySidebar
// in a Sheet so the capability axis stays reachable when the center pane is
// too narrow to lay the rail out inline.
//
// The trigger is rendered by `library/plugin-library-pane.tsx` under the SAME
// `@container/plugin-pane` query that hides the rail, so exactly one of the
// two is present at any width. It used to be mounted in the page header
// behind a `lg:` *viewport* rule, which could not agree with the *container*
// rule the rail uses: on a >=1024px viewport with a <768px center pane both
// vanished. Callers may still pass `className`, but a visibility class that
// is not the pane's own container query re-opens that gap.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { LayoutListIcon } from "lucide-react"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { PluginCategorySidebar } from "../plugin-category-sidebar"

interface Props {
  className?: string
}

export function PluginCategorySheet({ className }: Props) {
  const t = useTranslations("plugins.panel")
  const [open, setOpen] = useState(false)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className={cn(className)}
          aria-label={t("categoriesButton")}
          data-testid="plugin-category-sheet-trigger"
        >
          <LayoutListIcon className="size-3.5 mr-1.5" />
          {t("categoriesButton")}
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="w-full max-w-72 p-4 overflow-y-auto"
        onClick={(e) => {
          // Close the sheet when a sidebar button is clicked so the user
          // sees the filter applied to the panel underneath. Buttons are
          // the only interactive elements inside; bubbled clicks from
          // them all close.
          if ((e.target as HTMLElement).closest("button")) setOpen(false)
        }}
      >
        <SheetHeader>
          <SheetTitle>{t("categoriesButton")}</SheetTitle>
        </SheetHeader>
        <div className="mt-4">
          <PluginCategorySidebar />
        </div>
      </SheetContent>
    </Sheet>
  )
}
