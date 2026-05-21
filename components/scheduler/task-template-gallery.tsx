"use client"

/**
 * TaskTemplateGallery - Dialog to browse and select task templates
 */

import { useState, useMemo } from "react"
import { useTranslations } from "next-intl"
import { useLocale } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  TASK_TEMPLATES,
  TEMPLATE_CATEGORIES,
  type TaskTemplate,
  type TaskTemplateCategory,
} from "@/lib/scheduler/task-templates"
import type { CreateScheduledTaskInput } from "@/types/scheduler"

interface TaskTemplateGalleryProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (input: CreateScheduledTaskInput) => void
  trigger?: React.ReactNode
}

export function TaskTemplateGallery({
  open,
  onOpenChange,
  onSelect,
  trigger,
}: TaskTemplateGalleryProps) {
  const t = useTranslations("scheduler")
  const locale = useLocale()
  const isZh = locale === "zh-CN" || locale === "zh"
  const [category, setCategory] = useState<"all" | TaskTemplateCategory>("all")

  const filteredTemplates = useMemo(() => {
    if (category === "all") return TASK_TEMPLATES
    return TASK_TEMPLATES.filter((tmpl) => tmpl.category === category)
  }, [category])

  const handleSelect = (template: TaskTemplate) => {
    const input = template.getInput()
    onSelect(input)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>{t("templateGallery.title") || "Task Templates"}</DialogTitle>
          <DialogDescription>
            {t("templateGallery.description") || "Choose a template to quickly create a task"}
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={category}
          onValueChange={(v) => setCategory(v as "all" | TaskTemplateCategory)}
        >
          <TabsList className="w-full justify-start overflow-x-auto">
            <TabsTrigger value="all" className="text-xs">
              {t("templateGallery.allCategories") || "All"}
            </TabsTrigger>
            {TEMPLATE_CATEGORIES.map((cat) => (
              <TabsTrigger key={cat.id} value={cat.id} className="text-xs">
                {isZh ? cat.nameZh : cat.name}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value={category} className="mt-3">
            <ScrollArea className="h-[400px] pr-2">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {filteredTemplates.map((template) => (
                  <div
                    key={template.id}
                    className="group rounded-xl border border-border/50 bg-card/80 p-4 transition-all hover:border-primary/50 hover:shadow-lg"
                  >
                    <div className="flex items-start gap-3">
                      <span className="text-2xl">{template.icon}</span>
                      <div className="min-w-0 flex-1">
                        <h4 className="text-sm font-medium">
                          {isZh ? template.nameZh : template.name}
                        </h4>
                        <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                          {isZh ? template.descriptionZh : template.description}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className="h-5 px-1.5 text-[10px] capitalize">
                            {t(`taskTypes.${template.taskType}`) || template.taskType}
                          </Badge>
                          <Badge variant="secondary" className="h-5 px-1.5 text-[10px] capitalize">
                            {t(`triggerTypes.${template.triggerType}`) || template.triggerType}
                          </Badge>
                        </div>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3 h-8 w-full text-xs transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100"
                      onClick={() => handleSelect(template)}
                    >
                      {t("templateGallery.useTemplate") || "Use Template"}
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
