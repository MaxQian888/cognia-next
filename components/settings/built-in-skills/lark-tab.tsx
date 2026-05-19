"use client"

/**
 * Lark built-in skill family tab (ADR-0026).
 *
 * Renders one collapsible per family with mutation-tier badges per skill.
 * v1 read-only — the assistant gates are still enforced by per-conversation
 * `allowedBuiltInSkillIds` in the inbox panel (next file). This tab is the
 * discoverability surface; the per-channel allowlist surface ships
 * alongside the inbox conversation-settings panel.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ShieldCheckIcon, ShieldAlertIcon, AlertTriangleIcon } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import {
  getSharedBuiltInSkillRegistry,
  type BuiltInSkill,
  type BuiltInSkillMutation,
} from "@/lib/skills/built-in"

type Locale = "en" | "zh-CN"

export function LarkTab() {
  const t = useTranslations("settings.builtInSkills.lark")
  const tMutation = useTranslations("settings.builtInSkills.mutation")
  const [skills, setSkills] = useState<BuiltInSkill[]>([])

  useEffect(() => {
    // Trigger the family barrel side-effects on mount so the registry
    // is populated even if no upstream module pulled it in first.
    import("@/lib/skills/built-in").then(() => {
      const reg = getSharedBuiltInSkillRegistry()
      setSkills(reg.listByPlatform("lark"))
    })
  }, [])

  const groupedByFamily = useMemo(() => {
    const map = new Map<string, BuiltInSkill[]>()
    for (const skill of skills) {
      let bucket = map.get(skill.family)
      if (!bucket) {
        bucket = []
        map.set(skill.family, bucket)
      }
      bucket.push(skill)
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [skills])

  const locale = (
    typeof window !== "undefined" && window.navigator.language.startsWith("zh") ? "zh-CN" : "en"
  ) as Locale

  if (skills.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">{t("emptyHint")}</CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("intro.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>{t("intro.body")}</p>
          <p>{t("intro.gates")}</p>
        </CardContent>
      </Card>

      <Accordion type="multiple" className="w-full">
        {groupedByFamily.map(([family, familySkills]) => (
          <AccordionItem key={family} value={family}>
            <AccordionTrigger>
              <div className="flex items-center gap-2">
                <span className="font-medium">{family}</span>
                <Badge variant="secondary">{familySkills.length}</Badge>
              </div>
            </AccordionTrigger>
            <AccordionContent>
              <ul className="space-y-2">
                {familySkills.map((skill) => (
                  <li
                    key={skill.id}
                    className="flex items-start justify-between gap-3 rounded border bg-card p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{skill.mcpToolName}</span>
                        <MutationBadge mutation={skill.mutation} t={tMutation} />
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {skill.description[locale] ?? skill.description.en}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  )
}

function MutationBadge({
  mutation,
  t,
}: {
  mutation: BuiltInSkillMutation
  t: (key: string) => string
}) {
  if (mutation === "read") {
    return (
      <Badge variant="outline" className="gap-1">
        <ShieldCheckIcon className="size-3" />
        {t("read")}
      </Badge>
    )
  }
  if (mutation === "write") {
    return (
      <Badge variant="outline" className="gap-1 border-amber-500 text-amber-700">
        <ShieldAlertIcon className="size-3" />
        {t("write")}
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="gap-1 border-destructive text-destructive">
      <AlertTriangleIcon className="size-3" />
      {t("destructive")}
    </Badge>
  )
}
