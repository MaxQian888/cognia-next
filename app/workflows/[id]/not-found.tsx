"use client"

import Link from "next/link"
import { useTranslations } from "next-intl"
import { ArrowLeft } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ErrorPage } from "@/components/error/error-page"

export default function WorkflowNotFound() {
  const t = useTranslations("workflows")
  return (
    <ErrorPage
      variant="not-found"
      title={t("notFoundTitle")}
      description={t("notFoundDescription")}
      disableHome
      additionalActions={
        <Button variant="outline" asChild className="gap-2" data-testid="workflows-back-to-library">
          <Link href="/workflows">
            <ArrowLeft className="size-4" aria-hidden="true" />
            {t("notFoundBackToLibrary")}
          </Link>
        </Button>
      }
    />
  )
}
