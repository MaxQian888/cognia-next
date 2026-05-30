"use client"

import { useTranslations } from "next-intl"
import {
  BookOpenIcon,
  BugIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  MessagesSquareIcon,
  TagsIcon,
  type LucideIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  COMMUNITY_URL,
  DOCS_URL,
  GITHUB_URL,
  ISSUES_URL,
  RELEASES_URL,
} from "@/lib/constants/external-urls"
import { openExternal } from "@/lib/tauri/opener"

interface ResourceLink {
  key: string
  url: string
  icon: LucideIcon
}

const LINKS: ResourceLink[] = [
  { key: "docs", url: DOCS_URL, icon: BookOpenIcon },
  { key: "repo", url: GITHUB_URL, icon: GitBranchIcon },
  { key: "issues", url: ISSUES_URL, icon: BugIcon },
  { key: "releases", url: RELEASES_URL, icon: TagsIcon },
  { key: "community", url: COMMUNITY_URL, icon: MessagesSquareIcon },
]

/** Outbound resource links (docs, repo, issues, releases, community). */
export function ResourcesCard() {
  const t = useTranslations("settings.about")

  return (
    <Card data-testid="about-resources-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ExternalLinkIcon className="size-4" />
          {t("resources.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {LINKS.map(({ key, url, icon: Icon }) => (
          <Button
            key={key}
            variant="ghost"
            className="h-auto w-full justify-start py-2"
            onClick={() => void openExternal(url)}
            data-testid={`resource-${key}`}
          >
            <Icon className="mr-2 size-4 shrink-0" />
            <span className="flex min-w-0 flex-col items-start">
              <span className="text-sm">{t(`resources.${key}.label`)}</span>
              <span className="truncate text-xs font-normal text-muted-foreground">
                {t(`resources.${key}.description`)}
              </span>
            </span>
            <ExternalLinkIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        ))}
      </CardContent>
    </Card>
  )
}
