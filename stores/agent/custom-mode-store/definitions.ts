import type { AgentModeConfig } from "@/types/agent/agent-mode"
import type { A2UIComponent } from "@/types/artifact/a2ui"

export interface CustomModeConfig extends AgentModeConfig {
  type: "custom"
  isBuiltIn: false
  createdAt: Date
  updatedAt: Date
  // A2UI Integration
  a2uiEnabled?: boolean
  a2uiTemplate?: CustomModeA2UITemplate
  // Advanced options
  modelOverride?: string
  temperatureOverride?: number
  maxTokensOverride?: number
  // MCP Tools integration
  mcpTools?: McpToolReference[]
  // Categorization
  category?: CustomModeCategory
  tags?: string[]
  // Usage tracking
  usageCount?: number
  lastUsedAt?: Date
  // Sharing
  isShared?: boolean
  sharedBy?: string
}

/**
 * Reference to an MCP tool for custom modes
 */
export interface McpToolReference {
  serverId: string
  toolName: string
  displayName?: string
}

/**
 * A2UI template for custom modes
 */
export interface CustomModeA2UITemplate {
  id: string
  name: string
  description?: string
  components: A2UIComponent[]
  dataModel: Record<string, unknown>
  actions?: CustomModeA2UIAction[]
}

/**
 * A2UI action handler for custom modes
 */
export interface CustomModeA2UIAction {
  id: string
  name: string
  description?: string
  handler: "ai_process" | "data_update" | "custom"
  prompt?: string // For ai_process handler
  dataPath?: string // For data_update handler
}

/**
 * Custom mode categories
 */
export type CustomModeCategory =
  | "productivity"
  | "creative"
  | "technical"
  | "research"
  | "education"
  | "business"
  | "personal"
  | "other"

/**
 * Mode generation request from natural language
 */
export interface ModeGenerationRequest {
  description: string
  language?: "en" | "zh"
  includeA2UI?: boolean
  suggestedTools?: string[]
}

/**
 * Generated mode result
 */
export interface GeneratedModeResult {
  mode: Partial<CustomModeConfig>
  suggestedTools: string[]
  suggestedA2UITemplate?: CustomModeA2UITemplate
  confidence: number
}

// =============================================================================
// Available Tools Definition
// =============================================================================

/**
 * Tool categories for selection
 */
export const TOOL_CATEGORIES = {
  search: {
    name: "Search & Web",
    icon: "Search",
    tools: ["web_search", "rag_search", "web_scraper", "bulk_web_scraper", "search_and_scrape"],
  },
  file: {
    name: "File Operations",
    icon: "FileText",
    tools: [
      "file_read",
      "file_write",
      "file_list",
      "file_exists",
      "file_delete",
      "file_copy",
      "file_rename",
      "file_info",
      "file_search",
      "file_append",
      "directory_create",
    ],
  },
  git: {
    name: "Git",
    icon: "GitBranch",
    tools: [
      "git_repo_inspect",
      "git_changes",
      "git_branch",
      "git_history",
      "git_remote",
      "git_tag",
    ],
  },
  document: {
    name: "Document Processing",
    icon: "FileSearch",
    tools: ["document_summarize", "document_chunk", "document_analyze"],
  },
  academic: {
    name: "Academic Research",
    icon: "GraduationCap",
    tools: ["academic_search", "academic_analysis", "paper_comparison"],
  },
  media: {
    name: "Media Generation",
    icon: "Image",
    tools: [
      "image_generate",
      "image_edit",
      "image_variation",
      "video_generate",
      "video_status",
      "video_subtitles",
      "video_analyze",
    ],
  },
  ppt: {
    name: "Presentations",
    icon: "Presentation",
    tools: ["ppt_outline", "ppt_slide_content", "ppt_finalize", "ppt_export"],
  },
  learning: {
    name: "Learning Tools",
    icon: "BookOpen",
    tools: [
      "display_flashcard",
      "display_flashcard_deck",
      "display_quiz",
      "display_quiz_question",
      "display_review_session",
      "display_progress_summary",
      "display_concept_explanation",
      "display_step_guide",
      "display_concept_map",
      "display_animation",
    ],
  },
  system: {
    name: "System",
    icon: "Calculator",
    tools: ["calculator"],
  },
} as const

/**
 * All available tools flattened
 */
export const ALL_AVAILABLE_TOOLS = Object.values(TOOL_CATEGORIES).flatMap((cat) => cat.tools)

/**
 * Tool requirements - which tools need specific API keys or configurations.
 * `desktopOnly: true` means the tool is only functional in the Tauri desktop build.
 */
export const TOOL_REQUIREMENTS: Record<
  string,
  {
    requiresApiKey?: string
    description: string
    desktopOnly?: boolean
  }
> = {
  web_search: {
    requiresApiKey: "search",
    description: "Requires at least one configured web search provider",
  },
  search_and_scrape: {
    requiresApiKey: "search",
    description: "Requires at least one configured web search provider",
  },
  image_generate: { requiresApiKey: "openai", description: "Requires OpenAI API key for DALL-E" },
  image_edit: { requiresApiKey: "openai", description: "Requires OpenAI API key for DALL-E" },
  image_variation: { requiresApiKey: "openai", description: "Requires OpenAI API key for DALL-E" },
  video_generate: { requiresApiKey: "openai", description: "Requires OpenAI API key for Sora" },
  video_status: { requiresApiKey: "openai", description: "Requires OpenAI API key" },
  video_subtitles: { requiresApiKey: "openai", description: "Requires OpenAI API key for Whisper" },
  video_analyze: { requiresApiKey: "openai", description: "Requires OpenAI API key" },
  // Desktop-only tools — require the Tauri runtime and are unavailable in the web build
  execute_code: {
    desktopOnly: true,
    description:
      "Full multi-language execution requires the desktop app; web mode supports JavaScript only",
  },
  shell_execute: {
    desktopOnly: true,
    description: "Shell command execution requires the desktop app",
  },
  file_write: { desktopOnly: true, description: "Writing files requires the desktop app" },
  file_delete: { desktopOnly: true, description: "Deleting files requires the desktop app" },
  directory_create: {
    desktopOnly: true,
    description: "Creating directories requires the desktop app",
  },
  directory_delete: {
    desktopOnly: true,
    description: "Deleting directories requires the desktop app",
  },
  git_repo_inspect: { desktopOnly: true, description: "Git operations require the desktop app" },
  git_changes: { desktopOnly: true, description: "Git operations require the desktop app" },
  git_branch: { desktopOnly: true, description: "Git operations require the desktop app" },
  git_history: { desktopOnly: true, description: "Git operations require the desktop app" },
  git_remote: { desktopOnly: true, description: "Git operations require the desktop app" },
  git_tag: { desktopOnly: true, description: "Git operations require the desktop app" },
}

/**
 * Check tool availability based on provided API keys and current environment.
 * Tools that are desktop-only are reported as unavailable when running in the web build.
 */
export function checkToolAvailability(
  tools: string[],
  availableApiKeys: { tavily?: boolean; openai?: boolean; [key: string]: boolean | undefined },
  options: { isDesktop?: boolean } = {}
): { available: string[]; unavailable: Array<{ tool: string; reason: string }> } {
  const available: string[] = []
  const unavailable: Array<{ tool: string; reason: string }> = []

  for (const tool of tools) {
    const requirement = TOOL_REQUIREMENTS[tool]
    if (requirement?.desktopOnly && !options.isDesktop) {
      unavailable.push({ tool, reason: requirement.description })
    } else if (requirement?.requiresApiKey) {
      if (availableApiKeys[requirement.requiresApiKey]) {
        available.push(tool)
      } else {
        unavailable.push({ tool, reason: requirement.description })
      }
    } else {
      available.push(tool)
    }
  }

  return { available, unavailable }
}

/**
 * Predefined mode templates for quick creation
 */
export interface ModeTemplate {
  id: string
  name: string
  description: string
  icon: string
  category: CustomModeCategory
  tools: string[]
  systemPrompt: string
  outputFormat: "text" | "code" | "html" | "react" | "markdown"
  previewEnabled?: boolean
  tags: string[]
}

export const MODE_TEMPLATES: ModeTemplate[] = [
  {
    id: "coding-assistant",
    name: "Coding Assistant",
    description: "Expert programmer for code generation, debugging, and reviews",
    icon: "Code2",
    category: "technical",
    tools: [
      "calculator",
      "file_read",
      "file_write",
      "file_list",
      "web_search",
      "git_repo_inspect",
      "git_changes",
      "git_branch",
      "git_history",
    ],
    systemPrompt: `You are an expert software developer. Help users with:
- Writing clean, efficient, and well-documented code
- Debugging and fixing issues
- Code reviews and best practices
- Explaining complex programming concepts
- Suggesting optimal solutions and design patterns

Always explain your reasoning and provide working code examples.`,
    outputFormat: "code",
    tags: ["coding", "programming", "development"],
  },
  {
    id: "research-analyst",
    name: "Research Analyst",
    description: "Academic and web research with citation support",
    icon: "GraduationCap",
    category: "research",
    tools: [
      "web_search",
      "rag_search",
      "academic_search",
      "academic_analysis",
      "paper_comparison",
      "web_scraper",
    ],
    systemPrompt: `You are a thorough research analyst. Help users with:
- Finding and synthesizing information from multiple sources
- Academic paper analysis and comparison
- Fact-checking and source verification
- Creating well-cited summaries and reports
- Identifying key insights and trends

Always cite your sources and indicate confidence levels in your findings.`,
    outputFormat: "markdown",
    tags: ["research", "academic", "analysis"],
  },
  {
    id: "content-writer",
    name: "Content Writer",
    description: "Professional writing for blogs, articles, and marketing",
    icon: "PenTool",
    category: "creative",
    tools: ["web_search", "rag_search"],
    systemPrompt: `You are a professional content writer. Help users with:
- Blog posts and articles with engaging hooks and clear structure
- Marketing copy and persuasive content
- Technical documentation and guides
- SEO-optimized content with relevant keywords
- Editing and improving existing content

Focus on clarity, engagement, and the target audience's needs.`,
    outputFormat: "markdown",
    tags: ["writing", "content", "marketing"],
  },
  {
    id: "data-analyst",
    name: "Data Analyst",
    description: "Data analysis, visualization, and insights generation",
    icon: "BarChart3",
    category: "technical",
    tools: ["calculator", "rag_search", "file_read"],
    systemPrompt: `You are a data analyst expert. Help users with:
- Analyzing datasets and finding patterns
- Creating clear data visualizations
- Statistical analysis and interpretation
- Building dashboards and reports
- Data-driven decision making recommendations

Present findings clearly with supporting evidence and visualizations.`,
    outputFormat: "markdown",
    tags: ["data", "analytics", "visualization"],
  },
  {
    id: "ui-designer",
    name: "UI Designer",
    description: "Web and app UI design with live preview",
    icon: "Layout",
    category: "creative",
    tools: ["image_generate", "web_search"],
    systemPrompt: `You are a UI/UX designer and React developer. Help users with:
- Creating modern, responsive web interfaces
- Implementing best UX practices and accessibility
- Building reusable React components with Tailwind CSS
- Following design systems and consistency
- Creating interactive prototypes

Generate clean React code that can be previewed immediately.`,
    outputFormat: "react",
    previewEnabled: true,
    tags: ["design", "ui", "web"],
  },
  {
    id: "presentation-creator",
    name: "Presentation Creator",
    description: "PPT slides and presentation content generation",
    icon: "Presentation",
    category: "productivity",
    tools: [
      "ppt_outline",
      "ppt_slide_content",
      "ppt_finalize",
      "ppt_export",
      "web_search",
      "image_generate",
    ],
    systemPrompt: `You are a presentation expert. Help users with:
- Creating compelling presentation outlines
- Writing concise, impactful slide content
- Structuring presentations for maximum engagement
- Visual storytelling and data presentation
- Speaker notes and delivery tips

Focus on clear messaging and visual appeal.`,
    outputFormat: "markdown",
    tags: ["presentation", "slides", "ppt"],
  },
  {
    id: "learning-tutor",
    name: "Learning Tutor",
    description: "Educational assistant with flashcards and quizzes",
    icon: "BookOpen",
    category: "education",
    tools: [
      "display_flashcard",
      "display_flashcard_deck",
      "display_quiz",
      "display_quiz_question",
      "display_review_session",
      "display_progress_summary",
      "display_concept_explanation",
      "display_step_guide",
      "display_concept_map",
      "display_animation",
      "web_search",
      "rag_search",
    ],
    systemPrompt: `You are an expert tutor using proven learning techniques. Help users with:
- Explaining concepts clearly with examples
- Creating interactive flashcards for memorization
- Designing quizzes to test understanding
- Using spaced repetition for retention
- Adapting to the learner's pace and style

Make learning engaging and effective through active recall and practice.`,
    outputFormat: "markdown",
    tags: ["learning", "education", "tutor"],
  },
  {
    id: "translation-assistant",
    name: "Translation Assistant",
    description: "Multi-language translation and localization",
    icon: "Globe",
    category: "productivity",
    tools: ["web_search"],
    systemPrompt: `You are a professional translator. Help users with:
- Accurate translation between languages
- Cultural adaptation and localization
- Technical and specialized terminology
- Maintaining tone and style across languages
- Explaining nuances and idioms

Preserve meaning while ensuring natural expression in the target language.`,
    outputFormat: "text",
    tags: ["translation", "language", "localization"],
  },
]

/**
 * Get a mode template by ID
 */
export function getModeTemplate(templateId: string): ModeTemplate | undefined {
  return MODE_TEMPLATES.find((t) => t.id === templateId)
}

/**
 * Available icons for custom modes
 */
export const AVAILABLE_MODE_ICONS = [
  "Bot",
  "Brain",
  "Lightbulb",
  "Rocket",
  "Star",
  "Heart",
  "Zap",
  "Layout",
  "Code2",
  "BarChart3",
  "PenTool",
  "Search",
  "Settings",
  "FileText",
  "Image",
  "Video",
  "Music",
  "Globe",
  "Database",
  "Shield",
  "Lock",
  "Key",
  "Briefcase",
  "GraduationCap",
  "BookOpen",
  "Palette",
  "Wand2",
  "Sparkles",
  "Target",
  "Flag",
  "Award",
  "MessageSquare",
  "Mail",
  "Phone",
  "Calendar",
  "Clock",
  "Timer",
  "Calculator",
  "Clipboard",
  "List",
  "CheckSquare",
  "Grid",
  "Layers",
  "Box",
  "Package",
  "Truck",
  "Home",
  "Building",
  "Users",
  "User",
  "UserPlus",
  "UserCheck",
  "Smile",
  "Frown",
  "Sun",
  "Moon",
  "Cloud",
  "Umbrella",
  "Thermometer",
  "Cpu",
  "HardDrive",
  "Monitor",
  "Smartphone",
  "Tablet",
  "Camera",
  "Mic",
  "Speaker",
  "Headphones",
  "Radio",
  "Coffee",
  "Pizza",
  "Apple",
  "Leaf",
  "Flower2",
  "Tree",
  "Car",
  "Plane",
  "Ship",
  "Train",
  "Bike",
  "Gamepad2",
  "Dice5",
  "Puzzle",
  "Trophy",
  "Medal",
] as const

// =============================================================================
// Store State
// =============================================================================
