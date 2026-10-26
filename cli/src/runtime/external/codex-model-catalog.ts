import vendoredCatalog from "./codex-catalog/codex-catalog.json"

interface CodexCatalogRequestModel {
  slug: string
  contextWindow?: number
  autoCompactTokenLimit?: number
  inputModalities: ("text" | "image")[]
  reasoningEfforts?: string[]
}

interface VendoredCatalog {
  fallbackInstructions: string
  models: {
    slug: string
    supported_reasoning_levels: { effort: string; description: string }[]
    [key: string]: unknown
  }[]
}

/** Only small, bounded metadata crosses the task payload boundary. */
function validateRequest(
  request: unknown
): asserts request is { models: CodexCatalogRequestModel[] } {
  const invalid = () => {
    throw new Error("Invalid gateway task configuration")
  }
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
  if (
    !object(request) ||
    Object.keys(request).some((key) => key !== "models") ||
    !Array.isArray(request.models) ||
    request.models.length < 1 ||
    request.models.length > 32
  )
    invalid()
  const slugs = new Set<string>()
  for (const model of (request as { models: unknown[] }).models) {
    if (
      !object(model) ||
      Object.keys(model).some(
        (key) =>
          ![
            "slug",
            "contextWindow",
            "autoCompactTokenLimit",
            "inputModalities",
            "reasoningEfforts",
          ].includes(key)
      )
    )
      invalid()
    const entry = model as Record<string, unknown>
    if (
      typeof entry.slug !== "string" ||
      [...entry.slug].length < 1 ||
      [...entry.slug].length > 256 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(entry.slug) ||
      slugs.has(entry.slug)
    )
      invalid()
    slugs.add(entry.slug as string)
    for (const key of ["contextWindow", "autoCompactTokenLimit"]) {
      if (
        key in entry &&
        (typeof entry[key] !== "number" ||
          !Number.isInteger(entry[key]) ||
          (entry[key] as number) <= 0 ||
          (entry[key] as number) > 10000000)
      )
        invalid()
    }
    if (
      !Array.isArray(entry.inputModalities) ||
      !entry.inputModalities.length ||
      entry.inputModalities.some((value) => value !== "text" && value !== "image")
    )
      invalid()
    if (
      "reasoningEfforts" in entry &&
      (!Array.isArray(entry.reasoningEfforts) ||
        entry.reasoningEfforts.length > 16 ||
        entry.reasoningEfforts.some(
          (value) => typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(value)
        ))
    )
      invalid()
  }
}

/** Reproduce Codex's own metadata for an unlisted slug, including its prompt. */
function fallbackModel(slug: string, instructions: string): Record<string, unknown> {
  return {
    slug,
    display_name: slug,
    description: null,
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    shell_type: "unified_exec",
    visibility: "none",
    supported_in_api: true,
    priority: 99,
    additional_speed_tiers: [],
    service_tiers: [],
    model_messages: { instructions_template: instructions },
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    supports_reasoning_summary_parameter: true,
    default_reasoning_summary: "auto",
    support_verbosity: false,
    apply_patch_tool_type: null,
    web_search_tool_type: "text",
    truncation_policy: { mode: "bytes", limit: 10000 },
    supports_image_detail_original: false,
    context_window: 272000,
    max_context_window: 272000,
    auto_compact_token_limit: null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: false,
    supports_experimental_context: false,
    use_responses_lite: false,
    supports_reasoning_effort_updates: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    multi_agent_version: null,
    multi_agent_reasoning_effort: null,
  }
}

/** Assemble locally: bundled prompts must never travel in an environment variable. */
export function buildCodexModelCatalog(
  request: unknown,
  vendored: VendoredCatalog = vendoredCatalog
): string {
  validateRequest(request)
  const descriptions = new Map<string, string>()
  for (const model of vendored.models)
    for (const { effort, description } of model.supported_reasoning_levels)
      if (!descriptions.has(effort)) descriptions.set(effort, description)
  const models = request.models.map((entry) => {
    const bundled = vendored.models.find((model) => model.slug === entry.slug)
    const model: Record<string, unknown> = bundled
      ? JSON.parse(JSON.stringify(bundled))
      : fallbackModel(entry.slug, vendored.fallbackInstructions)
    if (entry.contextWindow !== undefined) {
      model.context_window = entry.contextWindow
      if (
        !bundled ||
        (typeof model.max_context_window === "number" &&
          model.max_context_window < entry.contextWindow)
      )
        model.max_context_window = entry.contextWindow
    }
    if (entry.autoCompactTokenLimit !== undefined)
      model.auto_compact_token_limit = entry.autoCompactTokenLimit
    const level = (effort: string) => ({ effort, description: descriptions.get(effort) ?? effort })
    if (!bundled) {
      model.input_modalities = [...entry.inputModalities]
      model.supported_reasoning_levels = (entry.reasoningEfforts ?? []).map(level)
    } else if (entry.reasoningEfforts?.length) {
      // Codex validates a child's effort against these levels; keep the
      // bundled ones and add what the routed provider accepts.
      const own = model.supported_reasoning_levels as { effort: string; description: string }[]
      const known = new Set(own.map(({ effort }) => effort))
      model.supported_reasoning_levels = [
        ...own,
        ...entry.reasoningEfforts.filter((effort) => !known.has(effort)).map(level),
      ]
    }
    return model
  })
  return JSON.stringify({ models }, null, 2) + "\n"
}
