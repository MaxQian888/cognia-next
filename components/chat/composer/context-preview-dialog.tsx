"use client"

import type { ComponentProps, ReactNode, Ref } from "react"
import { useTranslations } from "next-intl"
import { XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/** Shared composer preview frame: file and selection previews keep the same geometry. */
export function ContextPreviewDialogContent(
  props: Omit<ComponentProps<typeof DialogContent>, "className" | "showCloseButton">
) {
  return (
    <DialogContent
      {...props}
      showCloseButton={false}
      className="flex h-[min(85dvh,720px)] w-[min(94vw,1200px)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
    />
  )
}

export function ContextPreviewDialogHeader({
  title,
  titleRef,
  description,
  toolbarLabel,
  children,
}: {
  title: ReactNode
  titleRef?: Ref<HTMLHeadingElement>
  description: ReactNode
  toolbarLabel: string
  children?: ReactNode
}) {
  const t = useTranslations("common")
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <DialogHeader className="min-w-0 flex-1 gap-1 text-left">
        <DialogTitle ref={titleRef} tabIndex={-1} className="truncate text-sm outline-none">
          {title}
        </DialogTitle>
        <DialogDescription className="truncate text-xs">{description}</DialogDescription>
      </DialogHeader>
      <div
        role="toolbar"
        aria-label={toolbarLabel}
        className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1"
      >
        {children}
        <DialogClose asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t("close")}>
            <XIcon className="size-4" />
          </Button>
        </DialogClose>
      </div>
    </div>
  )
}
