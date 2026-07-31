import type {
  HtmlAnalysisResult,
  CssAnalysisResult,
  JsAnalysisResult,
  CorrelatedComponent,
} from "./types.js"

// ── Type aliases for lightweight element proxies ──────────────────
type ComponentRoot = HtmlAnalysisResult["componentRoots"][number]
type Element = ComponentRoot["element"]

interface LogicAnalysis {
  state?: unknown[]
  events?: unknown[]
  methods?: unknown[]
  todos?: unknown[]
  lifecycles?: Record<string, unknown>
}

export function correlateComponents(
  html: HtmlAnalysisResult,
  css: CssAnalysisResult,
  js: JsAnalysisResult
): Map<string, CorrelatedComponent> {
  const components = new Map<string, CorrelatedComponent>()

  function processRoot(root: ComponentRoot) {
    const styles = matchStyles(root, css)
    const logic = matchLogic(root, js)
    const componentType = inferComponentType(logic ?? null)

    // Weighted confidence: HTML detection is most reliable (50%), CSS (30%), Logic (20%)
    // This prevents weak signals from diluting strong extraction markers
    const matchConfidence =
      root.confidence * 0.5 + Math.min(1, styles.confidence) * 0.3 + (logic ? 0.2 : 0.1) // Penalize missing logic slightly, but not heavily

    const comp: CorrelatedComponent = {
      name: root.name,
      type: componentType,
      template: getOuterHtml(root.element),
      styles: styles.css,
      logic,
      matchConfidence,
    }

    // Use the component name as key
    components.set(root.name, comp)
  }

  html.componentRoots.forEach((root) => processRoot(root))

  return components
}

function matchStyles(root: ComponentRoot, css: CssAnalysisResult) {
  const classes = getElementClasses(root.element)
  const id = root.element.id
  const tag = root.element.tagName?.toLowerCase() || ""
  const matched: string[] = []
  const matchSignals: number[] = [] // Track individual signal strengths

  // Match by class names (BEM support)
  classes.forEach((cls) => {
    if (css.componentStyles[cls]) {
      matched.push(...css.componentStyles[cls])
      matchSignals.push(0.35) // Strong signal: direct class match
    }
    // BEM block-related classes
    const blockName = cls.split("__")[0].split("--")[0]
    if (blockName !== cls && css.componentStyles[blockName]) {
      matched.push(...css.componentStyles[blockName])
      matchSignals.push(0.2) // Medium signal: BEM block match
    }
  })

  // Match by ID
  if (id && css.componentStyles[id]) {
    matched.push(...css.componentStyles[id])
    matchSignals.push(0.25) // Medium-strong signal: ID match
  }

  // Match by tag name (weakest signal)
  if (css.componentStyles[tag]) {
    matched.push(...css.componentStyles[tag])
    matchSignals.push(0.1) // Weak signal: tag-only match
  }

  // Match by CSS descendant/child combinators
  const selectors = Object.keys(css.componentStyles)
  selectors.forEach((sel) => {
    const styles = css.componentStyles[sel]
    // Only add if we haven't already added this selector's styles
    if (sel.includes(tag) || classes.some((c) => sel.includes(c))) {
      for (const style of styles) {
        if (!matched.includes(style)) {
          matched.push(style)
        }
      }
      matchSignals.push(0.15) // Weak-medium signal: combinator match
    }
  })

  // Check for dynamic style indicators
  const dynamicMatches =
    css.dynamicStyles?.filter((ds) => {
      const dsClasses = ds.selector.match(/\.([a-z0-9_-]+)/gi) || []
      return (
        classes.some((c) => dsClasses.some((dc) => dc.includes(c))) ||
        (id && ds.selector.includes(`#${id}`))
      )
    }) || []

  if (dynamicMatches.length > 0) {
    matchSignals.push(0.12) // Weak signal: dynamic style hint
  }

  // Combine multiple signals using probability model
  // Instead of sum (which can exceed 1), use: confidence = 1 - ∏(1 - signal)
  // This is more realistic: multiple weak signals reinforce, but don't guarantee
  let confidence = 0
  if (matchSignals.length > 0) {
    confidence = 1 - matchSignals.reduce((product, signal) => product * (1 - signal), 1)
  }

  return {
    css: Array.from(new Set(matched)).join("\n"),
    confidence: Math.min(1, confidence),
  }
}

function matchLogic(root: ComponentRoot, js: JsAnalysisResult) {
  const refs = getElementRefs(root.element)

  if (js.methods.length === 0 && js.state.length === 0 && js.events.length === 0) {
    return undefined
  }

  // Try to match state/methods/events by element references
  const matchedState = js.state.filter((s) => {
    return refs.some((ref) => {
      const refName = ref.replace(/[.#]/, "").toLowerCase()
      return s.name.toLowerCase().includes(refName) || refName.includes(s.name.toLowerCase())
    })
  })

  const matchedMethods = js.methods.filter((m) => {
    return refs.some((ref) => {
      const refName = ref.replace(/[.#]/, "").toLowerCase()
      return m.name.toLowerCase().includes(refName) || refName.includes(m.name.toLowerCase())
    })
  })

  const matchedEvents = js.events.filter((e) => {
    return refs.some((ref) => {
      const refName = ref.replace(/[.#]/, "").toLowerCase()
      return (
        e.selector.includes(refName) ||
        refName.includes(e.selector.replace(/[.#]/, "").toLowerCase())
      )
    })
  })

  return {
    state: matchedState.length > 0 ? matchedState : js.state,
    methods: matchedMethods.length > 0 ? matchedMethods : js.methods,
    events: matchedEvents.length > 0 ? matchedEvents : js.events,
  }
}

function inferComponentType(
  logic: LogicAnalysis | null
): "stateful" | "presentational" | "unknown" {
  if (!logic) return "unknown"

  const hasState = logic.state && logic.state.length > 0
  const hasEvents = logic.events && logic.events.length > 0
  const hasMethods = logic.methods && logic.methods.length > 0

  if (hasState && (hasEvents || hasMethods)) return "stateful"
  if (hasState || hasEvents || hasMethods) return "presentational"
  return "unknown"
}

function getElementClasses(el: Element): string[] {
  if (!el.className) return []
  return el.className.split(" ").filter((c: string) => c && c.length > 0)
}

function getElementRefs(el: Element): string[] {
  const refs: string[] = []
  if (el.id) refs.push(`#${el.id}`)
  const classes = getElementClasses(el)
  refs.push(...classes.map((c) => `.${c}`))
  if (el.tagName) refs.push(el.tagName.toLowerCase())
  return refs
}

function getOuterHtml(el: Element): string {
  try {
    return el.outerHTML || el.toString()
  } catch {
    return "<div><!-- Unable to serialize --></div>"
  }
}
