import type { A2UIComponent } from "@/types/artifact/a2ui"
import { nanoid } from "nanoid"
import { scoreTaskAwareToolCandidate } from "@/lib/ai/tools/task-aware-selection"
import {
  type CustomModeConfig,
  type CustomModeCategory,
  type CustomModeA2UITemplate,
  type ModeGenerationRequest,
  type GeneratedModeResult,
  type McpToolReference,
} from "./definitions"

export function analyzeModeDescription(request: ModeGenerationRequest): GeneratedModeResult {
  const { description, includeA2UI } = request
  const lowerDesc = description.toLowerCase()

  // Pattern matching for common use cases
  const patterns = {
    coding: {
      keywords: ["code", "programming", "developer", "coding", "代码", "编程", "开发"],
      tools: ["calculator", "file_read", "file_write", "git_repo_inspect", "git_changes"],
      icon: "Code2",
      category: "technical" as CustomModeCategory,
      outputFormat: "code" as const,
    },
    research: {
      keywords: ["research", "academic", "paper", "study", "研究", "学术", "论文"],
      tools: ["academic_search", "academic_analysis", "web_search", "rag_search"],
      icon: "GraduationCap",
      category: "research" as CustomModeCategory,
      outputFormat: "markdown" as const,
    },
    writing: {
      keywords: ["write", "writing", "content", "article", "blog", "写作", "文章", "博客"],
      tools: ["web_search", "rag_search"],
      icon: "PenTool",
      category: "creative" as CustomModeCategory,
      outputFormat: "markdown" as const,
    },
    data: {
      keywords: ["data", "analysis", "analytics", "chart", "report", "数据", "分析", "报表"],
      tools: ["calculator", "rag_search"],
      icon: "BarChart3",
      category: "technical" as CustomModeCategory,
      outputFormat: "markdown" as const,
    },
    design: {
      keywords: ["design", "ui", "web", "interface", "layout", "设计", "界面", "网页"],
      tools: ["image_generate"],
      icon: "Layout",
      category: "creative" as CustomModeCategory,
      outputFormat: "react" as const,
      previewEnabled: true,
    },
    presentation: {
      keywords: ["ppt", "presentation", "slide", "演示", "PPT", "幻灯片"],
      tools: ["ppt_outline", "ppt_slide_content", "ppt_finalize", "ppt_export"],
      icon: "Presentation",
      category: "productivity" as CustomModeCategory,
      outputFormat: "markdown" as const,
    },
    learning: {
      keywords: ["learn", "study", "education", "teach", "tutor", "学习", "教育", "辅导"],
      tools: ["display_flashcard", "display_quiz", "rag_search", "web_search"],
      icon: "BookOpen",
      category: "education" as CustomModeCategory,
      outputFormat: "markdown" as const,
    },
  }

  // Find matching pattern
  let matchedPattern = null
  let maxMatches = 0

  for (const [_key, pattern] of Object.entries(patterns)) {
    const matches = pattern.keywords.filter((kw) => lowerDesc.includes(kw)).length
    if (matches > maxMatches) {
      maxMatches = matches
      matchedPattern = pattern
    }
  }

  // Default if no pattern matched
  if (!matchedPattern) {
    matchedPattern = {
      tools: ["web_search", "rag_search", "calculator"],
      icon: "Bot",
      category: "other" as CustomModeCategory,
      outputFormat: "text" as const,
    }
  }

  // Extract name from description
  const name = extractModeName(description)

  // Build the mode configuration
  const mode: Partial<CustomModeConfig> = {
    name,
    description: description.slice(0, 200),
    icon: matchedPattern.icon,
    tools: matchedPattern.tools,
    outputFormat: matchedPattern.outputFormat,
    category: matchedPattern.category,
    previewEnabled: "previewEnabled" in matchedPattern ? matchedPattern.previewEnabled : false,
    systemPrompt: generateSystemPrompt(description, matchedPattern),
  }

  // Generate A2UI template if requested
  let suggestedA2UITemplate: CustomModeA2UITemplate | undefined
  if (includeA2UI) {
    suggestedA2UITemplate = generateA2UITemplate(description, matchedPattern.category)
  }

  return {
    mode,
    suggestedTools: matchedPattern.tools,
    suggestedA2UITemplate,
    confidence: maxMatches > 0 ? Math.min(0.9, 0.5 + maxMatches * 0.1) : 0.3,
  }
}

/**
 * Extract a name from the description
 */
function extractModeName(description: string): string {
  // Try to extract name patterns
  const patterns = [
    /(?:create|make|build|生成|创建)\s*(?:a|an|一个)?\s*[「"']?([^「」"'\s,，。.]+)[」"']?/i,
    /([^,，。.\s]+?)(?:助手|模式|agent|assistant|mode|helper)/i,
  ]

  for (const pattern of patterns) {
    const match = description.match(pattern)
    if (match && match[1]) {
      return match[1].trim()
    }
  }

  // Generate from first few words
  const words = description.split(/\s+/).slice(0, 3)
  return words.join(" ").slice(0, 30) || "Custom Mode"
}

/**
 * Generate system prompt based on description and pattern
 */
function generateSystemPrompt(
  description: string,
  pattern: { category?: CustomModeCategory; [key: string]: unknown }
): string {
  const categoryPrompts: Record<string, string> = {
    technical: `You are a technical expert assistant. Help users with coding, development, and technical problems.`,
    research: `You are a research assistant. Help users find, analyze, and synthesize information from academic sources.`,
    creative: `You are a creative assistant. Help users with writing, design, and creative projects.`,
    productivity: `You are a productivity assistant. Help users accomplish tasks efficiently and effectively.`,
    education: `You are an educational assistant. Help users learn new concepts and skills through explanation and practice.`,
    business: `You are a business assistant. Help users with business planning, analysis, and communication.`,
    personal: `You are a personal assistant. Help users with everyday tasks and personal organization.`,
    other: `You are a helpful assistant.`,
  }

  const basePrompt = categoryPrompts[pattern.category || "other"]
  return `${basePrompt}\n\nUser's requirements: ${description}`
}

/**
 * Generate basic A2UI template based on category
 */
function generateA2UITemplate(
  description: string,
  category: CustomModeCategory
): CustomModeA2UITemplate {
  const id = `template-${nanoid(8)}`

  // Basic template structure
  const components: A2UIComponent[] = [
    {
      id: "root",
      component: "Column",
      children: ["header", "content", "actions"],
      className: "gap-4 p-4",
    },
    {
      id: "header",
      component: "Text",
      text: extractModeName(description),
      variant: "heading2",
    },
    {
      id: "content",
      component: "Card",
      children: ["main-input"],
      className: "p-4",
    },
    {
      id: "main-input",
      component: "TextArea",
      value: { path: "/input" },
      placeholder: "Enter your request...",
      rows: 4,
    },
    {
      id: "actions",
      component: "Row",
      children: ["submit-btn", "clear-btn"],
      className: "gap-2",
    },
    {
      id: "submit-btn",
      component: "Button",
      text: "Submit",
      action: "submit",
      variant: "primary",
    },
    {
      id: "clear-btn",
      component: "Button",
      text: "Clear",
      action: "clear",
      variant: "outline",
    },
  ] as A2UIComponent[]

  return {
    id,
    name: `${extractModeName(description)} Template`,
    description: `Auto-generated template for ${category} mode`,
    components,
    dataModel: {
      input: "",
      output: "",
    },
    actions: [
      {
        id: "submit",
        name: "Submit",
        handler: "ai_process",
        prompt: "Process the user input according to the mode configuration",
      },
      {
        id: "clear",
        name: "Clear",
        handler: "data_update",
        dataPath: "/input",
      },
    ],
  }
}

// =============================================================================
// System Prompt Template Variables
// =============================================================================

/**
 * Available template variables for system prompts
 */
export const PROMPT_TEMPLATE_VARIABLES = {
  "{{date}}": "Current date (YYYY-MM-DD)",
  "{{time}}": "Current time (HH:MM)",
  "{{datetime}}": "Current date and time",
  "{{weekday}}": "Current day of the week",
  "{{timezone}}": "User timezone",
  "{{language}}": "User preferred language",
  "{{tools_list}}": "List of available tools for this mode",
  "{{mode_name}}": "Name of the current mode",
  "{{mode_description}}": "Description of the current mode",
} as const

export type PromptTemplateVariable = keyof typeof PROMPT_TEMPLATE_VARIABLES

/**
 * Context for template variable replacement
 */
export interface PromptTemplateContext {
  modeName?: string
  modeDescription?: string
  tools?: string[]
  language?: string
  timezone?: string
}

/**
 * Process template variables in a system prompt
 * Replaces {{variable}} placeholders with actual values
 */
export function processPromptTemplateVariables(
  prompt: string,
  context: PromptTemplateContext = {}
): string {
  if (!prompt) return prompt

  const now = new Date()

  const replacements: Record<string, string> = {
    "{{date}}": now.toISOString().split("T")[0],
    "{{time}}": now.toTimeString().slice(0, 5),
    "{{datetime}}": now.toLocaleString(),
    "{{weekday}}": now.toLocaleDateString("en-US", { weekday: "long" }),
    "{{timezone}}": context.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    "{{language}}": context.language || navigator?.language || "en",
    "{{tools_list}}": context.tools?.length
      ? context.tools.join(", ")
      : "No specific tools configured",
    "{{mode_name}}": context.modeName || "Custom Mode",
    "{{mode_description}}": context.modeDescription || "",
  }

  let processedPrompt = prompt
  for (const [variable, value] of Object.entries(replacements)) {
    processedPrompt = processedPrompt.replaceAll(variable, value)
  }

  return processedPrompt
}

/**
 * Get a preview of template variable replacements
 */
export function getTemplateVariablePreview(
  context: PromptTemplateContext = {}
): Record<string, string> {
  const now = new Date()

  return {
    "{{date}}": now.toISOString().split("T")[0],
    "{{time}}": now.toTimeString().slice(0, 5),
    "{{datetime}}": now.toLocaleString(),
    "{{weekday}}": now.toLocaleDateString("en-US", { weekday: "long" }),
    "{{timezone}}": context.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    "{{language}}": context.language || "en",
    "{{tools_list}}": context.tools?.length
      ? context.tools.join(", ")
      : "No specific tools configured",
    "{{mode_name}}": context.modeName || "Custom Mode",
    "{{mode_description}}": context.modeDescription || "",
  }
}

// =============================================================================
// Intelligent MCP Tool Recommendations
// =============================================================================

/**
 * Score MCP tool relevance for a custom mode
 */
function scoreMcpToolForMode(
  tool: McpToolReference,
  modeDescription: string,
  modeName: string,
  systemPrompt: string
): number {
  const scored = scoreTaskAwareToolCandidate(
    {
      name: tool.toolName,
      description: tool.displayName || tool.toolName,
      serverId: tool.serverId,
      serverName: tool.serverId,
    },
    {
      query: modeDescription,
      conversationContext: systemPrompt,
      activeMode: modeName,
    }
  )

  return scored.relevanceScore
}

/**
 * Get recommended MCP tools for a custom mode based on its configuration
 */
export function getRecommendedMcpToolsForMode(
  availableTools: McpToolReference[],
  modeConfig: {
    name: string
    description: string
    systemPrompt: string
    category?: CustomModeCategory
  },
  limit: number = 10
): Array<McpToolReference & { relevanceScore: number }> {
  const { name, description, systemPrompt, category } = modeConfig

  // Score each tool
  const scoredTools = availableTools.map((tool) => ({
    ...tool,
    relevanceScore: scoreMcpToolForMode(tool, description, name, systemPrompt),
  }))

  // Category-based boost
  const categoryToolPatterns: Record<string, string[]> = {
    technical: ["code", "execute", "debug", "compile", "git", "terminal"],
    research: ["search", "academic", "paper", "citation", "web"],
    creative: ["image", "generate", "design", "art", "media"],
    productivity: ["file", "document", "calendar", "email", "task"],
    education: ["quiz", "flashcard", "learn", "explain", "tutor"],
    business: ["spreadsheet", "chart", "report", "analyze", "database"],
  }

  if (category && categoryToolPatterns[category]) {
    const patterns = categoryToolPatterns[category]
    for (const tool of scoredTools) {
      const toolNameLower = tool.toolName.toLowerCase()
      if (patterns.some((p) => toolNameLower.includes(p))) {
        tool.relevanceScore = Math.min(1.0, tool.relevanceScore + 0.15)
      }
    }
  }

  // Sort by score and return top N
  return scoredTools
    .filter((t) => t.relevanceScore > 0.1)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, limit)
}

/**
 * Auto-select MCP tools for a mode based on its description
 */
export function autoSelectMcpToolsForMode(
  availableTools: McpToolReference[],
  modeDescription: string,
  maxTools: number = 10
): McpToolReference[] {
  const recommended = getRecommendedMcpToolsForMode(
    availableTools,
    {
      name: "",
      description: modeDescription,
      systemPrompt: modeDescription,
    },
    maxTools
  )

  return recommended.map(({ relevanceScore: _, ...tool }) => tool)
}

// =============================================================================
// Selectors
// =============================================================================
