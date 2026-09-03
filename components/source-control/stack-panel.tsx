"use client"

/**
 * The stacks list in a Sheet, opened from the sync toolbar's overflow menu.
 *
 * A wrapper and nothing more. The list itself is `stack-list.tsx`, because the
 * repository navigator shows the same thing inline and two copies of the
 * validation, restack and publish wiring would have drifted apart.
 */

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useTranslations } from "next-intl"

import { StackList, type StackListProps } from "./stack-list"

export interface StackPanelProps extends Omit<StackListProps, "active" | "className"> {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function StackPanel({ open, onOpenChange, ...rest }: StackPanelProps) {
  const t = useTranslations("sourceControl.stacks")
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>
        <StackList active={open} className="h-[calc(100vh-9rem)]" {...rest} />
      </SheetContent>
    </Sheet>
  )
}
