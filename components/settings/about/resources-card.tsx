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

import {
  COMMUNITY_URL,
  DOCS_URL,
  GITHUB_URL,
  ISSUES_URL,
  RELEASES_URL,
} from "@/lib/constants/external-urls"
import { openExternal } from "@/lib/tauri/opener"

import { AboutCard } from "./about-card"

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
    <AboutCard
      icon={ExternalLinkIcon}
      title={t("resources.title")}
      testid="about-resources-card"
      contentClassName="grid grid-cols-1 gap-2 sm:grid-cols-2"
    >
      {LINKS.map(({ key, url, icon: Icon }) => (
        <button
          key={key}
          type="button"
          onClick={() => void openExternal(url)}
          data-testid={`resource-${key}`}
          className="group flex items-start gap-3 rounded-lg border bg-background/40 p-3 text-left transition-all duration-200 hover:-translate-y-px hover:border-foreground/20 hover:bg-accent/50 hover:shadow-sm focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground transition-colors group-hover:text-foreground"
          >
            <Icon className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1">
              <span className="min-w-0 truncate text-sm font-medium">
                {t(`resources.${key}.label`)}
              </span>
              <ExternalLinkIcon
                aria-hidden
                className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
              />
            </span>
            <span className="mt-0.5 block text-xs text-pretty text-muted-foreground">
              {t(`resources.${key}.description`)}
            </span>
          </span>
        </button>
      ))}
    </AboutCard>
  )
}
