/**
 * A2UI Template Types and Utilities
 */

import type { A2UIComponent, A2UIServerMessage } from "@/types/a2ui/schema"

/**
 * App template definition
 */
export interface A2UIAppTemplate {
  id: string
  name: string
  description: string
  icon: string
  category: "productivity" | "data" | "form" | "utility" | "social"
  components: A2UIComponent[]
  dataModel: Record<string, unknown>
  tags: string[]
}

/**
 * Generate unique IDs for template instances
 */
export function generateTemplateId(prefix: string = "app"): string {
  return `${prefix}-${crypto.randomUUID()}`
}

/**
 * Create A2UI messages from a template
 */
export function createAppFromTemplate(
  template: A2UIAppTemplate,
  surfaceId?: string
): { surfaceId: string; messages: A2UIServerMessage[] } {
  const id = surfaceId || generateTemplateId(template.id)

  const messages: A2UIServerMessage[] = [
    {
      type: "createSurface",
      surfaceId: id,
      surfaceType: "inline",
      title: template.name,
    },
    {
      type: "updateComponents",
      surfaceId: id,
      components: template.components,
    },
    {
      type: "dataModelUpdate",
      surfaceId: id,
      data: template.dataModel,
    },
    {
      type: "surfaceReady",
      surfaceId: id,
    },
  ]

  return { surfaceId: id, messages }
}

/**
 * Template categories with metadata
 */
export const templateCategories = [
  {
    id: "productivity",
    name: "Productivity",
    icon: "Briefcase",
    description: "Task management and organization",
  },
  {
    id: "data",
    name: "Data & Analytics",
    icon: "BarChart3",
    description: "Charts, dashboards, and visualization",
  },
  { id: "form", name: "Forms", icon: "ClipboardList", description: "Input forms and surveys" },
  { id: "utility", name: "Utilities", icon: "Wrench", description: "Handy tools and widgets" },
  { id: "social", name: "Social", icon: "Users", description: "Social and communication features" },
] as const
