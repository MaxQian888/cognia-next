/**
 * CSS parser - supports incremental parsing and full postcss parsing
 *
 * Size hierarchy:
 * - < 100KB: full postcss parsing (highest quality)
 * - 100KB - 1MB: streaming state machine parsing (selective parsing)
 * - > 1MB: Extract CSS variables only (minimum effort)
 */
import postcss from "postcss"
import type { Root, Declaration, Rule } from "postcss"
import type { CssAnalysisResult, CssRule } from "./types.js"

// ── Public API ─────────────────────────────────────────────────────

export function analyzeCss(css: string): CssAnalysisResult {
  if (!css.trim()) {
    return { variables: {}, rules: [], componentStyles: {}, globalStyles: [], dynamicStyles: [] }
  }

  const size = css.length

  try {
    // Size Graded Strategy
    if (size > 1024 * 1024) {
      // > 1MB: Extract CSS variables only
      return analyzeCssVariablesOnly(css)
    } else if (size > 100 * 1024) {
      // 100KB - 1MB: streaming parsing
      return analyzeCssStreaming(css)
    } else {
      // < 100KB: full postcss parse
      return analyzeCssFull(css)
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`CSS analysis error: ${message}`)
    return { variables: {}, rules: [], componentStyles: {}, globalStyles: [], dynamicStyles: [] }
  }
}

// ── Full postcss analysis ────────────────────────────────────────────

function analyzeCssFull(css: string): CssAnalysisResult {
  const root = postcss.parse(css)
  const variables = extractVariables(root)
  const rules = extractRules(root)
  const { globalStyles, componentStyles } = groupStylesByComponent(rules)
  const dynamicStyles = detectDynamicStyles(rules)

  return { variables, rules, componentStyles, globalStyles, dynamicStyles }
}

function extractVariables(root: Root): Record<string, string> {
  const vars: Record<string, string> = {}
  root.walkDecls((decl: Declaration) => {
    if (decl.prop.startsWith("--")) {
      vars[decl.prop] = decl.value
    }
  })
  return vars
}

function extractRules(root: Root): CssRule[] {
  const rules: CssRule[] = []
  root.walkRules((rule: Rule) => {
    rules.push({
      selector: rule.selector,
      source: rule.toString(),
    })
  })
  return rules
}

// ── Streaming parsing (100KB - 1MB) ──────────────────────────────────────

function analyzeCssStreaming(css: string): CssAnalysisResult {
  const variables: Record<string, string> = {}
  const rules: CssRule[] = []
  const componentStyles: Record<string, string[]> = {}

  // State Machine: SELECTOR / BODY
  let state: "SELECTOR" | "BODY" = "SELECTOR"
  let currentSelector = ""
  let currentBlock = ""
  let selectorAccumulator = "" // Accumulates multi-line selectors
  let braceDepth = 0

  for (const line of css.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue // Skip empty lines

    if (state === "SELECTOR") {
      if (trimmed.includes("{")) {
        const braceIdx = trimmed.indexOf("{")
        // Merge accumulated selector lines with the current line's selector part
        const selectorLines = (selectorAccumulator + trimmed.slice(0, braceIdx).trim())
          .replace(/\n/g, " ")
          .replace(/\s+/g, " ")
          .trim()
        currentSelector = selectorLines || trimmed.slice(0, braceIdx).trim()
        currentBlock = selectorAccumulator + trimmed + "\n"
        selectorAccumulator = ""

        state = "BODY"
        braceDepth = 1
        // There may be more than one `{` in a line (e.g. nested)
        const remaining = trimmed.slice(braceIdx + 1)
        if (remaining.includes("{")) {
          braceDepth += (remaining.match(/\{/g) || []).length
        }
        braceDepth -= (trimmed.match(/\}/g) || []).length
        if (braceDepth <= 0) {
          // one-way traffic rule
          processRule(currentSelector, currentBlock, variables, rules, componentStyles)
          state = "SELECTOR"
          currentSelector = ""
          currentBlock = ""
        }
      } else {
        // Accumulate multi-line selector (e.g. ".el-table--border:after,")
        selectorAccumulator += trimmed + " "
      }
    } else if (state === "BODY") {
      currentBlock += line + "\n"
      braceDepth += (trimmed.match(/\{/g) || []).length
      braceDepth -= (trimmed.match(/\}/g) || []).length

      if (braceDepth <= 0) {
        // Complete rule block
        processRule(currentSelector, currentBlock, variables, rules, componentStyles)
        state = "SELECTOR"
        currentSelector = ""
        currentBlock = ""
      }
    }
  }

  // Unclosed rules (fault tolerance)
  if (state === "BODY" && currentSelector) {
    processRule(currentSelector, currentBlock, variables, rules, componentStyles)
  }

  const { globalStyles, componentStyles: grouped } = groupStylesByComponent(rules)
  const dynamicStyles = detectDynamicStyles(rules)

  return { variables, rules, componentStyles: grouped, globalStyles, dynamicStyles }
}

function processRule(
  selector: string,
  block: string,
  variables: Record<string, string>,
  rules: CssRule[],
  componentStyles: Record<string, string[]>
): void {
  // Only scan the declaration body (after first '{') for CSS variables
  // This avoids falsely matching BEM modifier selectors like .el-table--border:not(...)
  const bodyStart = block.indexOf("{")
  const body = bodyStart >= 0 ? block.slice(bodyStart + 1) : block

  // Extracting CSS variables. Require a trailing ';' to distinguish real CSS variable
  // declarations (e.g. "--color-primary: #409eff;") from BEM modifier selectors
  // (e.g. ".el-button--default:after {") which also contain --name:pattern.
  const varMatches = body.match(/--[\w-]+\s*:\s*[^;{]+;/g)
  if (varMatches) {
    varMatches.forEach((v) => {
      // Strip the trailing ';'
      const decl = v.endsWith(";") ? v.slice(0, -1) : v
      const colonIdx = decl.indexOf(":")
      if (colonIdx > 0) {
        const key = decl.slice(0, colonIdx).trim()
        const value = decl.slice(colonIdx + 1).trim()
        variables[key] = value
      }
    })
  }

  rules.push({ selector, source: block })

  // BEM grouping: only match actual BEM separators (__ for element, -- for modifier)
  // Skip pseudo-classes, combinators, and other non-BEM class patterns
  const bemMatch = selector.match(/\.([a-z0-9][a-z0-9-]*?)(?:__|--)/i)
  if (bemMatch) {
    const name = bemMatch[1]
    if (!componentStyles[name]) componentStyles[name] = []
    if (!componentStyles[name].includes(block)) {
      componentStyles[name].push(block)
    }
  }
}

// ── Variable extraction only (> 1MB) ──────────────────────────────────────────

function analyzeCssVariablesOnly(css: string): CssAnalysisResult {
  const variables: Record<string, string> = {}

  // Extract all CSS variables using regex, but only inside { ... } blocks
  // This avoids falsely matching BEM modifier selectors (e.g. .el-table--border:not(...))
  const blockRegex = /\{([^}]*)\}/g
  let blockMatch: RegExpExecArray | null
  while ((blockMatch = blockRegex.exec(css)) !== null) {
    const body = blockMatch[1]
    // Require trailing ';' to distinguish real CSS variable declarations from
    // BEM modifier selectors that happen to contain --name:pattern
    const varRegex = /--[\w-]+\s*:\s*[^;]+;/g
    let match: RegExpExecArray | null
    while ((match = varRegex.exec(body)) !== null) {
      const decl = match[0].endsWith(";") ? match[0].slice(0, -1) : match[0]
      const colonIdx = decl.indexOf(":")
      if (colonIdx > 0) {
        const key = decl.slice(0, colonIdx).trim()
        const value = decl.slice(colonIdx + 1).trim()
        variables[key] = value
      }
    }
  }

  return {
    variables,
    rules: [],
    componentStyles: {},
    globalStyles: [],
    dynamicStyles: [],
  }
}

// ── Grouping and Dynamic Detection (Shared Logic) ───────────────────────────────────

/**
 * Group CSS rules by component name and extract global styles.
 * Supports BEM, ID-based, and tag-based patterns.
 */
function groupStylesByComponent(rules: CssRule[]): {
  globalStyles: string[]
  componentStyles: Record<string, string[]>
} {
  const globalRules: string[] = []
  const componentGroups: Record<string, string[]> = {}

  const globalSelectors = ["*", "body", "html", ":root", "::before", "::after"]

  rules.forEach((rule) => {
    const selector = rule.selector.trim()

    // Check if it's a global style
    if (
      globalSelectors.some(
        (gs) => selector === gs || selector.startsWith(gs + " ") || selector.startsWith(gs + ":")
      )
    ) {
      globalRules.push(rule.source)
      return
    }

    // Extract component name from BEM pattern (only __ and -- separators)
    const match = selector.match(/\.([a-z0-9][a-z0-9-]*?)(?:__|--)/i)
    if (match) {
      const componentName = match[1]
      if (!componentGroups[componentName]) {
        componentGroups[componentName] = []
      }
      componentGroups[componentName].push(rule.source)
    } else {
      // Try ID-based
      const idMatch = selector.match(/#([a-z0-9_-]+)/i)
      if (idMatch) {
        const idName = idMatch[1]
        if (!componentGroups[idName]) {
          componentGroups[idName] = []
        }
        componentGroups[idName].push(rule.source)
      } else {
        // Tag-based fallback
        const tagMatch = selector.match(/^([a-z]+)/i)
        if (tagMatch) {
          const tagName = tagMatch[1]
          if (!componentGroups[tagName]) {
            componentGroups[tagName] = []
          }
          componentGroups[tagName].push(rule.source)
        }
      }
    }
  })

  return { globalStyles: globalRules, componentStyles: componentGroups }
}

/**
 * Detect CSS properties that are typically modified by JavaScript.
 */
function detectDynamicStyles(rules: CssRule[]): Array<{ selector: string; properties: string[] }> {
  const dynamicProperties = new Set([
    "display",
    "visibility",
    "opacity",
    "background-color",
    "color",
    "transform",
    "left",
    "top",
    "width",
    "height",
    "padding",
    "margin",
    "border-color",
    "box-shadow",
    "z-index",
    "animation",
    "animation-play-state",
  ])

  const dynamic: Array<{ selector: string; properties: string[] }> = []

  rules.forEach((rule) => {
    // Only scan the declaration body (after '{'), not the selector
    // This avoids falsely matching pseudo-class selectors like :not(:first-child)
    const bodyStart = rule.source.indexOf("{")
    const body = bodyStart >= 0 ? rule.source.slice(bodyStart + 1) : ""

    // Match "property: value" pairs inside the declaration body
    // Stop at ';', '{', or '}' to avoid crossing block boundaries
    const declMatches = body.match(/[\w-]+\s*:\s*[^;{}]+/g)
    if (!declMatches) return

    const seen = new Set<string>()
    const matchingProps: string[] = []

    for (const decl of declMatches) {
      const colonIdx = decl.indexOf(":")
      if (colonIdx < 0) continue
      const propName = decl.slice(0, colonIdx).trim()
      if (!dynamicProperties.has(propName)) continue
      if (seen.has(propName)) continue // Deduplicate property names within a rule
      seen.add(propName)
      // Include value for meaningful output: "color: #333" not just "color"
      matchingProps.push(decl.trim())
    }

    if (matchingProps.length > 0) {
      dynamic.push({
        selector: rule.selector,
        properties: matchingProps,
      })
    }
  })

  return dynamic
}
