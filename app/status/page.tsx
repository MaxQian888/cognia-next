import type { Metadata } from "next"
import { getTranslations } from "next-intl/server"

import { PublicStatusPage } from "@/components/status/public-status-page"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("publicStatus.metadata")
  return {
    title: t("title"),
    description: t("description"),
  }
}

export default function StatusPage() {
  return <PublicStatusPage />
}
