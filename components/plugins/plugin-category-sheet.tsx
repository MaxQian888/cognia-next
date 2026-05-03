"use client"

// Mobile / tablet sidebar drawer for /plugins. Wraps the existing
// PluginCategorySidebar in a Sheet so users below the `lg:` breakpoint
// (no longer have access to the desktop left rail) can still filter by
// capability. The trigger button is intended to be shown only on
// `<lg` viewports — pass the appropriate visibility class through `className`.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { LayoutListIcon } from "lucide-react"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { PluginCategorySidebar } from "./plugin-category-sidebar"

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
        >
          <LayoutListIcon className="size-3.5 mr-1.5" />
          {t("categoriesButton")}
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="w-72 p-4 overflow-y-auto"
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
