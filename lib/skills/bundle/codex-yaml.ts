// Parse `agents/openai.yaml` per the Codex CLI skills spec:
//   https://developers.openai.com/codex/skills
//
// The file is optional — Anthropic skill-creator bundles never have it.
// When present, it carries Codex-specific UI hints and MCP tool
// dependencies that the bundle loader folds into the cognia `Skill`
// metadata. We don't try to round-trip the file; the cognia `Skill`
// stays canonical, and the openai.yaml is read-only on import.
//
// Unknown top-level keys produce warnings (loud, not silent) so future
// Codex extensions don't slip past us, but the parse still succeeds.

import yaml from "js-yaml"

export interface CodexInterfaceMeta {
  displayName?: string
  shortDescription?: string
  iconSmall?: string
  iconLarge?: string
  brandColor?: string
  defaultPrompt?: string
}

export interface CodexPolicyMeta {
  allowImplicitInvocation?: boolean
}

export interface CodexToolDependency {
  type: string
  value?: string
  description?: string
  transport?: string
  url?: string
}

export interface CodexOpenaiMeta {
  interface?: CodexInterfaceMeta
  policy?: CodexPolicyMeta
  toolDependencies: CodexToolDependency[]
  warnings: string[]
}

const KNOWN_TOP_LEVEL = new Set(["interface", "policy", "dependencies"])
const KNOWN_INTERFACE = new Set([
  "display_name",
  "short_description",
  "icon_small",
  "icon_large",
  "brand_color",
  "default_prompt",
])
const KNOWN_POLICY = new Set(["allow_implicit_invocation"])
const KNOWN_DEPENDENCIES = new Set(["tools"])

function pickString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function pickBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const value = obj[key]
  return typeof value === "boolean" ? value : undefined
}

/**
 * Parse a Codex `agents/openai.yaml` payload. The function never throws on
 * unknown / unexpected shapes — it captures every deviation in
 * `result.warnings` and returns whatever fields it could recognise. The
 * caller decides whether warnings translate to a soft import warning or
 * cause a refuse.
 */
export function parseCodexOpenaiYaml(text: string): CodexOpenaiMeta {
  const warnings: string[] = []

  let parsed: unknown
  try {
    parsed = yaml.load(text)
  } catch (err) {
    return {
      toolDependencies: [],
      warnings: [
        `agents/openai.yaml failed to parse as YAML: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ],
    }
  }

  if (parsed === null || parsed === undefined) {
    return { toolDependencies: [], warnings: [] }
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      toolDependencies: [],
      warnings: [`agents/openai.yaml root must be a mapping, got ${typeof parsed}`],
    }
  }

  const root = parsed as Record<string, unknown>
  for (const key of Object.keys(root)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      warnings.push(`Unknown top-level key in agents/openai.yaml: ${key}`)
    }
  }

  const result: CodexOpenaiMeta = {
    toolDependencies: [],
    warnings,
  }

  const interfaceRaw = root.interface
  if (interfaceRaw !== undefined) {
    if (typeof interfaceRaw === "object" && interfaceRaw !== null && !Array.isArray(interfaceRaw)) {
      const obj = interfaceRaw as Record<string, unknown>
      for (const key of Object.keys(obj)) {
        if (!KNOWN_INTERFACE.has(key)) {
          warnings.push(`Unknown interface.${key}`)
        }
      }
      result.interface = {
        displayName: pickString(obj, "display_name"),
        shortDescription: pickString(obj, "short_description"),
        iconSmall: pickString(obj, "icon_small"),
        iconLarge: pickString(obj, "icon_large"),
        brandColor: pickString(obj, "brand_color"),
        defaultPrompt: pickString(obj, "default_prompt"),
      }
    } else {
      warnings.push("interface must be a mapping")
    }
  }

  const policyRaw = root.policy
  if (policyRaw !== undefined) {
    if (typeof policyRaw === "object" && policyRaw !== null && !Array.isArray(policyRaw)) {
      const obj = policyRaw as Record<string, unknown>
      for (const key of Object.keys(obj)) {
        if (!KNOWN_POLICY.has(key)) {
          warnings.push(`Unknown policy.${key}`)
        }
      }
      result.policy = {
        allowImplicitInvocation: pickBoolean(obj, "allow_implicit_invocation"),
      }
    } else {
      warnings.push("policy must be a mapping")
    }
  }

  const depRaw = root.dependencies
  if (depRaw !== undefined) {
    if (typeof depRaw === "object" && depRaw !== null && !Array.isArray(depRaw)) {
      const obj = depRaw as Record<string, unknown>
      for (const key of Object.keys(obj)) {
        if (!KNOWN_DEPENDENCIES.has(key)) {
          warnings.push(`Unknown dependencies.${key}`)
        }
      }
      const toolsRaw = obj.tools
      if (Array.isArray(toolsRaw)) {
        for (const [idx, item] of toolsRaw.entries()) {
          if (typeof item !== "object" || item === null) {
            warnings.push(`dependencies.tools[${idx}] is not an object`)
            continue
          }
          const tool = item as Record<string, unknown>
          const type = pickString(tool, "type")
          if (!type) {
            warnings.push(`dependencies.tools[${idx}] missing required 'type'`)
            continue
          }
          result.toolDependencies.push({
            type,
            value: pickString(tool, "value"),
            description: pickString(tool, "description"),
            transport: pickString(tool, "transport"),
            url: pickString(tool, "url"),
          })
        }
      } else if (toolsRaw !== undefined) {
        warnings.push("dependencies.tools must be an array")
      }
    } else {
      warnings.push("dependencies must be a mapping")
    }
  }

  return result
}
