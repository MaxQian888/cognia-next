import type { CorrelatedComponent } from "./types.js"
import type {
  ComponentSpec,
  ComponentManifest,
  StateVariable,
  EventBinding,
  MigrationTodo,
} from "../types.js"

interface EventMapEntry {
  event: string
  handler: string
  selector: string
  nativeEvent?: boolean
}

export function generateComponentStructure(
  correlated: Map<string, CorrelatedComponent>,
  componentHierarchy?: Map<string, string[]>
): Map<string, ComponentSpec> {
  const components = new Map<string, ComponentSpec>()

  correlated.forEach((comp, name) => {
    const manifest = buildManifest(comp)
    const children = componentHierarchy?.get(name) || []

    const spec: ComponentSpec = {
      name: comp.name,
      type: comp.type,
      children,
      template: comp.template,
      styles: comp.styles,
      logic: comp.logic,
      matchConfidence: comp.matchConfidence,
      manifest,
    }

    components.set(name, spec)
  })

  return components
}

function buildManifest(comp: CorrelatedComponent): ComponentManifest {
  const { effort, breakdown } = estimateEffort(comp)

  return {
    name: comp.name,
    type: comp.type,
    path: `components/${comp.name}`,
    children: [],
    state: buildStateMap(comp.logic?.state || []),
    events: buildEventMap(comp.logic?.events || []),
    migration: {
      effort,
      effortBreakdown: breakdown,
      suggestions: generateSuggestions(comp),
      todos: enrichTodos(comp),
    },
  }
}

function estimateEffort(comp: CorrelatedComponent): {
  effort: string
  breakdown: { extraction: string; conversion: string }
} {
  const stateCount = comp.logic?.state?.length || 0
  const methodCount = comp.logic?.methods?.length || 0
  const eventCount = comp.logic?.events?.length || 0

  // Conversion complexity: based on logic
  const logicComplexity = stateCount * 0.5 + methodCount * 0.3 + eventCount * 0.2

  // Extraction verification time: based on confidence
  // Low confidence components need manual review and correction
  const confidenceMultiplier = Math.max(1, 1 / (comp.matchConfidence || 0.5))

  const totalComplexity = logicComplexity * confidenceMultiplier

  // Time bands: based on combined complexity
  let effort: string
  let conversion: string
  let extraction = "10m"

  if (totalComplexity <= 0.5) {
    effort = "0.5h"
    conversion = "15m"
  } else if (totalComplexity <= 1.5) {
    effort = "1h"
    conversion = "30m"
  } else if (totalComplexity <= 3) {
    effort = "2h"
    conversion = "1h"
  } else if (totalComplexity <= 6) {
    effort = "4h"
    conversion = "2h"
  } else {
    effort = "8h+"
    conversion = "4h+"
  }

  // Add extraction review time based on confidence
  if (comp.matchConfidence < 0.6) {
    extraction = "30m+" // Needs careful review
    effort =
      effort === "0.5h"
        ? "1h"
        : effort === "1h"
          ? "2h"
          : effort === "2h"
            ? "4h"
            : effort === "4h"
              ? "8h+"
              : "8h+"
  } else if (comp.matchConfidence < 0.8) {
    extraction = "15m"
  }

  return {
    effort,
    breakdown: {
      extraction,
      conversion,
    },
  }
}

function buildStateMap(stateVars: StateVariable[]): Record<string, StateVariable> {
  const map: Record<string, StateVariable> = {}
  stateVars.forEach((sv) => {
    map[sv.name] = {
      name: sv.name,
      type: sv.type,
      initial: sv.initial,
      bindings: sv.bindings || [],
      mutators: sv.mutators || [],
      confidence: Math.round(sv.confidence * 100) / 100,
    }
  })
  return map
}

function buildEventMap(events: EventBinding[]): Record<string, EventMapEntry> {
  const map: Record<string, EventMapEntry> = {}
  let index = 0
  events.forEach((event) => {
    const key = event.handler || `event_${index++}`
    map[key] = {
      event: event.event,
      handler: event.handler,
      selector: event.selector,
      nativeEvent: event.preventDefault || false,
    }
  })
  return map
}

function enrichTodos(comp: CorrelatedComponent): (MigrationTodo & { context: string })[] {
  const enriched: (MigrationTodo & { context: string })[] = []

  // Add confidence-based TODOs
  if (comp.matchConfidence < 0.6) {
    enriched.push({
      type: "dom_ref" as const,
      description: `Low match confidence (${Math.round(comp.matchConfidence * 100)}%) - manual review recommended`,
      severity: "warning",
      context: `Component '${comp.name}' matching`,
    })
  }

  return enriched
}

function generateSuggestions(comp: CorrelatedComponent): string[] {
  const suggestions: string[] = []

  if (comp.type === "stateful") {
    const stateCount = comp.logic?.state?.length || 0
    if (stateCount > 0) {
      suggestions.push(`Extract ${stateCount} state variable(s) to reactive references`)
    }
    suggestions.push("Map event handlers to component methods")
    suggestions.push("Consider using computed properties for derived state")
  }

  if (comp.type === "presentational") {
    suggestions.push("Convert to pure functional component (no side effects)")
    suggestions.push("Use prop-drilling or context API for data flow")
  }

  const eventCount = comp.logic?.events?.length || 0
  if (eventCount > 3) {
    suggestions.push(`Consolidate ${eventCount} event handlers into fewer methods`)
  }

  return suggestions
}
