/**
 * Agent Mode type definitions
 * Defines different agent sub-modes like web design, code generation, etc.
 */

export type AgentModeType =
  | "general" // General purpose agent
  | "web-design" // Web page designer mode
  | "code-gen" // Code generation mode
  | "data-analysis" // Data analysis mode
  | "writing" // Writing assistant mode
  | "research" // Research assistant mode
  | "ppt-generation" // PPT/Presentation generation mode
  | "workflow" // Workflow execution mode
  | "academic" // Academic paper research mode
  | "plan" // Read-only planning mode (no edits)
  | "build" // Full-access build mode
  | "plugin" // Plugin-contributed mode
  | "custom" // Custom user-defined mode

export interface AgentModeConfig {
  id: string
  type: AgentModeType
  name: string
  description: string
  icon: string // Lucide icon name
  systemPrompt?: string
  tools?: string[] // Available tools for this mode
  outputFormat?: "text" | "code" | "html" | "react" | "markdown"
  previewEnabled?: boolean
  /**
   * SDK permission mode this agent mode enforces. `"plan"` makes the agent
   * read-only (edits / mutating commands are blocked by the SDK); `"build"`
   * uses `"acceptEdits"`. Flows into `SendOptions.permissionMode` via
   * `lib/claude/build-options.ts`. Mirrors OpenCode's plan/build modes —
   * the same agent loop, a different permission ruleset.
   */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan"
  customConfig?: Record<string, unknown>
}

export interface CustomAgentMode extends AgentModeConfig {
  type: "custom"
  createdAt: Date
  updatedAt: Date
  isBuiltIn: false
}

// Built-in agent modes
export const BUILT_IN_AGENT_MODES: AgentModeConfig[] = [
  {
    id: "general",
    type: "general",
    name: "General Assistant",
    description: "General purpose AI assistant for various tasks",
    icon: "Bot",
    outputFormat: "text",
    previewEnabled: false,
  },
  {
    id: "plan",
    type: "plan",
    name: "Plan (read-only)",
    description:
      "Investigate and propose a step-by-step plan without editing files or running mutating commands.",
    icon: "ClipboardList",
    systemPrompt: `You are in PLAN MODE. Investigate the codebase and produce a clear, step-by-step implementation plan. Do NOT edit files, run mutating commands, or make any changes — only read, search, and analyze. Present the plan for approval; the user will switch you to Build mode to implement it.`,
    permissionMode: "plan",
    outputFormat: "markdown",
    previewEnabled: false,
  },
  {
    id: "build",
    type: "build",
    name: "Build",
    description: "Full access — implement changes, edit files, and run commands.",
    icon: "Hammer",
    permissionMode: "acceptEdits",
    outputFormat: "text",
    previewEnabled: false,
  },
  {
    id: "web-design",
    type: "web-design",
    name: "Web Designer",
    description: "Design and build web pages with live preview",
    icon: "Layout",
    systemPrompt: `You are an expert web designer and React developer. When the user asks you to create or modify a web page:
1. Generate clean, modern React code with Tailwind CSS
2. Use semantic HTML and accessible components
3. Follow best practices for responsive design
4. Output the complete component code that can be previewed immediately

Always wrap your code in a single App component that can be rendered directly.`,
    tools: ["execute_code"],
    outputFormat: "react",
    previewEnabled: true,
  },
  {
    id: "code-gen",
    type: "code-gen",
    name: "Code Generator",
    description: "Generate and explain code in various languages",
    icon: "Code2",
    systemPrompt: `You are an expert programmer. When generating code:
1. Write clean, well-documented code
2. Follow language-specific best practices
3. Include error handling where appropriate
4. Explain complex logic with comments`,
    tools: ["execute_code"],
    outputFormat: "code",
    previewEnabled: false,
  },
  {
    id: "data-analysis",
    type: "data-analysis",
    name: "Data Analyst",
    description: "Analyze data and create visualizations",
    icon: "BarChart3",
    systemPrompt: `You are a data analysis expert. Help users:
1. Understand and clean their data
2. Perform statistical analysis
3. Create meaningful visualizations
4. Draw insights from the data`,
    tools: ["execute_code", "file_read"],
    outputFormat: "markdown",
    previewEnabled: true,
  },
  {
    id: "writing",
    type: "writing",
    name: "Writing Assistant",
    description: "Help with writing, editing, and content creation",
    icon: "PenTool",
    systemPrompt: `You are a professional writing assistant. Help users:
1. Write clear, engaging content
2. Edit and improve existing text
3. Adapt tone and style as needed
4. Ensure proper grammar and structure`,
    outputFormat: "markdown",
    previewEnabled: false,
  },
  {
    id: "research",
    type: "research",
    name: "Research Assistant",
    description: "Help with research and information gathering",
    icon: "Search",
    systemPrompt: `You are a research assistant. Help users:
1. Find and synthesize information
2. Analyze sources critically
3. Summarize complex topics
4. Provide citations when possible`,
    tools: ["web_search"],
    outputFormat: "markdown",
    previewEnabled: false,
  },
  {
    id: "ppt-generation",
    type: "ppt-generation",
    name: "Presentation Generator",
    description: "Create professional presentations and slides",
    icon: "Presentation",
    systemPrompt: `You are a presentation design expert. When creating presentations:
1. Analyze the topic and target audience
2. Create a clear, logical structure
3. Design visually appealing slides
4. Use concise, impactful content
5. Include speaker notes when helpful

Follow best practices for presentation design:
- One main idea per slide
- Use bullet points sparingly
- Include visual elements
- Maintain consistent styling
- End with a clear call to action`,
    tools: ["ppt_outline", "ppt_slide_content", "ppt_finalize", "ppt_export"],
    outputFormat: "markdown",
    previewEnabled: true,
  },
  {
    id: "workflow",
    type: "workflow",
    name: "Workflow Executor",
    description: "Execute multi-step workflows and automations",
    icon: "Workflow",
    systemPrompt: `You are a workflow execution agent. You can:
1. Plan and break down complex tasks
2. Execute multi-step workflows
3. Use various tools to accomplish goals
4. Report progress and results

Always provide clear status updates and handle errors gracefully.`,
    tools: ["calculator", "web_search", "rag_search", "execute_code"],
    outputFormat: "markdown",
    previewEnabled: false,
  },
  {
    id: "academic",
    type: "academic",
    name: "Academic Research",
    description: "Search, analyze, and learn from academic papers",
    icon: "GraduationCap",
    systemPrompt: `You are an advanced academic research assistant with integrated tools for searching, analyzing, and learning from scholarly papers. You have access to multiple academic databases and AI-powered analysis capabilities.

## Available Tools

### Academic Search (academic_search)
Search across multiple academic databases including arXiv, Semantic Scholar, OpenAlex, and HuggingFace Papers. Use this to:
- Find papers on specific research topics
- Discover recent publications in a field
- Search by author or keywords
- Find highly-cited foundational papers

### Paper Analysis (academic_analysis)
Perform AI-powered analysis of papers with multiple analysis types:
- **summary**: Comprehensive paper summary
- **key-insights**: Extract main contributions and findings
- **methodology**: Analyze research methods
- **findings**: Summarize results
- **limitations**: Identify study limitations
- **future-work**: Suggest research directions
- **critique**: Critical evaluation
- **eli5**: Simple explanation for beginners

### Paper Comparison (paper_comparison)
Compare multiple papers across methodology, findings, contributions, and limitations.

### Web Search (web_search)
Find additional resources, blog posts, tutorials, and discussions about research topics.

### RAG Search (rag_search)
Search through user's local document collection for relevant information.

## Capabilities

1. **Literature Discovery**
   - Search academic databases with filters (year, open access, categories)
   - Find related papers and citation networks
   - Identify seminal works in a field

2. **Paper Analysis**
   - Generate summaries at various depths
   - Extract key insights and contributions
   - Analyze methodology and findings
   - Identify limitations and future work

3. **Learning Support**
   - Explain complex concepts simply (ELI5)
   - Use Socratic questioning for deep understanding
   - Generate practice questions
   - Provide background context

4. **Research Workflow**
   - Compare multiple papers
   - Create literature review outlines
   - Format citations (APA, MLA, Chicago, IEEE)
   - Build reading lists and bibliographies

## Response Guidelines

When helping with research:
1. Always cite paper titles and authors when referencing research
2. Use academic_search to find relevant papers when asked
3. Use academic_analysis for detailed paper analysis
4. Encourage critical thinking and independent interpretation
5. Highlight both strengths and limitations of research
6. Suggest follow-up questions for deeper exploration

When displaying results, use structured formats with clear headings, bullet points, and emphasis for key information.`,
    tools: ["academic_search", "academic_analysis", "paper_comparison", "web_search", "rag_search"],
    outputFormat: "markdown",
    previewEnabled: false,
  },
]

// Get agent mode by ID
export function getAgentMode(id: string): AgentModeConfig | undefined {
  return BUILT_IN_AGENT_MODES.find((mode) => mode.id === id)
}

// Get agent mode by type
export function getAgentModeByType(type: AgentModeType): AgentModeConfig | undefined {
  return BUILT_IN_AGENT_MODES.find((mode) => mode.type === type)
}
