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
 * Tool categories for the custom-mode `allowedTools` selector.
 *
 * These are the names actually surfaced to a Claude Agent SDK session via the
 * sidecar — the SDK's built-ins (Bash, Read, Write, Edit, Glob, Grep, …) and
 * the `cognia-tools` MCP server's namespaced tools (`mcp__cognia-tools__*`).
 * See `lib/settings/builtin-tools-data.json` for the source of truth that
 * the sidecar registers; the names listed here MUST match.
 *
 * The previous version of this constant referenced tool names (web_scraper,
 * document_summarize, image_generate, …) that had no implementation behind
 * them in cognia-next — they were inherited from the Cognia template. Those
 * are removed; if/when the equivalents are ported they can be added under a
 * new category.
 */
export const TOOL_CATEGORIES = {
  sdk_builtin: {
    name: "Built-in (SDK)",
    icon: "Sparkles",
    tools: [
      "Bash",
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "Glob",
      "Grep",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "TodoWrite",
    ],
  },
  cognia_file_extras: {
    name: "File extras",
    icon: "FolderOpen",
    tools: [
      "mcp__cognia-tools__file_hash",
      "mcp__cognia-tools__file_diff",
      "mcp__cognia-tools__file_info",
      "mcp__cognia-tools__file_search",
      "mcp__cognia-tools__content_search",
      "mcp__cognia-tools__file_exists",
      "mcp__cognia-tools__file_append",
      "mcp__cognia-tools__file_binary_write",
      "mcp__cognia-tools__file_copy",
      "mcp__cognia-tools__file_rename",
      "mcp__cognia-tools__file_move",
      "mcp__cognia-tools__directory_create",
      "mcp__cognia-tools__directory_delete",
    ],
  },
  cognia_git: {
    name: "Git",
    icon: "GitBranch",
    tools: [
      "mcp__cognia-tools__git_status",
      "mcp__cognia-tools__git_diff",
      "mcp__cognia-tools__git_log",
      "mcp__cognia-tools__git_branch",
      "mcp__cognia-tools__git_remote",
      "mcp__cognia-tools__git_tag",
      "mcp__cognia-tools__git_repo_inspect",
      "mcp__cognia-tools__git_changes",
      "mcp__cognia-tools__git_history",
    ],
  },
  cognia_process: {
    name: "Processes",
    icon: "Cpu",
    tools: [
      "mcp__cognia-tools__list_processes",
      "mcp__cognia-tools__get_process",
      "mcp__cognia-tools__search_processes",
      "mcp__cognia-tools__top_memory_processes",
      "mcp__cognia-tools__check_program_allowed",
      "mcp__cognia-tools__get_process_manager_status",
      "mcp__cognia-tools__get_tracked_processes",
      "mcp__cognia-tools__start_process",
      "mcp__cognia-tools__terminate_process",
    ],
  },
  cognia_environment: {
    name: "Environment",
    icon: "Box",
    tools: [
      "mcp__cognia-tools__list_env",
      "mcp__cognia-tools__get_env",
      "mcp__cognia-tools__system_info",
    ],
  },
  cognia_shell_advanced: {
    name: "Guarded shell",
    icon: "Terminal",
    tools: ["mcp__cognia-tools__shell_execute_advanced"],
  },
} as const

/**
 * All available tools flattened
 */
export const ALL_AVAILABLE_TOOLS = Object.values(TOOL_CATEGORIES).flatMap((cat) => cat.tools)

/**
 * Tool requirements - which tools need specific API keys or configurations.
 * `desktopOnly: true` means the tool is only functional in the Tauri desktop build.
 *
 * The names are the same ones used in `Character.allowedTools` /
 * `MODE_TEMPLATES.tools` — SDK built-ins (Bash, Read, Write, …) plus the
 * `mcp__cognia-tools__*` namespaced tools registered by the sidecar.
 */
export const TOOL_REQUIREMENTS: Record<
  string,
  {
    requiresApiKey?: string
    description: string
    desktopOnly?: boolean
  }
> = {
  // SDK built-in web tools — work in both desktop and web modes via the sidecar's
  // SDK call; no API key from us required (the SDK has its own gating).
  WebSearch: {
    description: "Built-in web search via the Claude Agent SDK.",
  },
  WebFetch: {
    description: "Built-in web fetch via the Claude Agent SDK.",
  },
  // SDK built-ins that hit the local filesystem — they only work when the
  // sidecar is running, which only happens in the desktop build.
  Bash: { desktopOnly: true, description: "Built-in shell. Requires the desktop sidecar." },
  Read: { desktopOnly: true, description: "Built-in file read. Requires the desktop sidecar." },
  Write: { desktopOnly: true, description: "Built-in file write. Requires the desktop sidecar." },
  Edit: { desktopOnly: true, description: "Built-in file edit. Requires the desktop sidecar." },
  MultiEdit: {
    desktopOnly: true,
    description: "Built-in multi-file edit. Requires the desktop sidecar.",
  },
  Glob: { desktopOnly: true, description: "Built-in glob. Requires the desktop sidecar." },
  Grep: {
    desktopOnly: true,
    description: "Built-in content search. Requires the desktop sidecar.",
  },
  // Cognia-tools MCP server — every tool requires the sidecar.
  "mcp__cognia-tools__file_hash": {
    desktopOnly: true,
    description: "File hash. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__file_diff": {
    desktopOnly: true,
    description: "Unified file diff. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__file_info": {
    desktopOnly: true,
    description: "File metadata. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__file_search": {
    desktopOnly: true,
    description: "Glob-based file search. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__content_search": {
    desktopOnly: true,
    description: "Regex content search. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__file_exists": {
    desktopOnly: true,
    description: "Existence check. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__file_append": {
    desktopOnly: true,
    description: "Append to a file. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__file_binary_write": {
    desktopOnly: true,
    description: "Binary write. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__file_copy": {
    desktopOnly: true,
    description: "Copy a file. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__file_rename": {
    desktopOnly: true,
    description: "Rename a file. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__file_move": {
    desktopOnly: true,
    description: "Move a file. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__directory_create": {
    desktopOnly: true,
    description: "Create a directory. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__directory_delete": {
    desktopOnly: true,
    description: "Delete a directory. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__git_status": {
    desktopOnly: true,
    description: "git status. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__git_diff": {
    desktopOnly: true,
    description: "git diff. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__git_log": {
    desktopOnly: true,
    description: "git log. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__git_branch": {
    desktopOnly: true,
    description: "git branch. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__git_remote": {
    desktopOnly: true,
    description: "git remote. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__git_tag": {
    desktopOnly: true,
    description: "git tag. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__git_repo_inspect": {
    desktopOnly: true,
    description: "Inspect repo HEAD/upstream. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__git_changes": {
    desktopOnly: true,
    description: "Working-tree changes. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__git_history": {
    desktopOnly: true,
    description: "Path history. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__list_processes": {
    desktopOnly: true,
    description: "List processes. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__get_process": {
    desktopOnly: true,
    description: "Get a process. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__search_processes": {
    desktopOnly: true,
    description: "Search processes. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__top_memory_processes": {
    desktopOnly: true,
    description: "Top-memory processes. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__check_program_allowed": {
    desktopOnly: true,
    description: "Check program allowlist. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__get_process_manager_status": {
    desktopOnly: true,
    description: "Process manager status. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__get_tracked_processes": {
    desktopOnly: true,
    description: "Tracked PIDs. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__start_process": {
    desktopOnly: true,
    description: "Start a process. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__terminate_process": {
    desktopOnly: true,
    description: "Terminate a process. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__list_env": {
    desktopOnly: true,
    description: "List env vars. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__get_env": {
    desktopOnly: true,
    description: "Read an env var. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__system_info": {
    desktopOnly: true,
    description: "Platform info. Requires the desktop sidecar.",
  },
  "mcp__cognia-tools__shell_execute_advanced": {
    desktopOnly: true,
    description: "Guarded shell. Requires the desktop sidecar.",
  },
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
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "Glob",
      "Grep",
      "Bash",
      "WebSearch",
      "mcp__cognia-tools__git_repo_inspect",
      "mcp__cognia-tools__git_changes",
      "mcp__cognia-tools__git_branch",
      "mcp__cognia-tools__git_history",
      "mcp__cognia-tools__git_diff",
      "mcp__cognia-tools__file_diff",
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
    tools: ["WebSearch", "WebFetch", "Read", "Write", "mcp__cognia-tools__content_search"],
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
    tools: ["WebSearch", "WebFetch", "Read", "Write"],
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
    tools: [
      "Read",
      "Write",
      "Glob",
      "Grep",
      "Bash",
      "mcp__cognia-tools__content_search",
      "mcp__cognia-tools__file_info",
    ],
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
    tools: ["Read", "Write", "Edit", "WebSearch", "WebFetch"],
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
    tools: ["Read", "Write", "Edit", "WebSearch", "WebFetch"],
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
    tools: ["WebSearch", "WebFetch", "Read", "Write"],
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
    tools: ["WebSearch", "WebFetch"],
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
