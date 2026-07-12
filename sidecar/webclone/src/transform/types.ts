import type { StateVariable, MethodSpec, EventBinding, MigrationTodo } from "../types.js"

export interface Element {
  tagName: string
  className: string
  id: string
  outerHTML: string
  childNodes?: Element[]
  getAttribute?(name: string): string | null
}

export interface HtmlAnalysisResult {
  componentRoots: ComponentRoot[]
  dynamicPoints: DynamicPoints
}

export interface ComponentRoot {
  name: string
  element: Element
  depth: number
  type: "explicit" | "semantic" | "implicit"
  confidence: number
}

export interface DynamicPoints {
  bindings: DataBinding[]
  events: EventPoint[]
  conditions: ConditionalPoint[]
}

export interface DataBinding {
  selector: string
  attribute: string
  path: string
}

export interface EventPoint {
  selector: string
  event: string
  handler: string
}

export interface ConditionalPoint {
  selector: string
  condition: string
}

export interface CssAnalysisResult {
  variables: Record<string, string>
  rules: CssRule[]
  componentStyles: Record<string, string[]>
  globalStyles?: string[]
  dynamicStyles?: Array<{ selector: string; properties: string[] }>
}

export interface CssRule {
  selector: string
  source: string
}

export interface JsAnalysisResult {
  state: StateVariable[]
  methods: MethodSpec[]
  events: EventBinding[]
  refs: DomRef[]
  lifecycles: Record<string, MethodSpec>
  todos: MigrationTodo[]
}

export interface DomRef {
  selector: string
  method: string
}

export interface CorrelatedComponent {
  name: string
  type: "stateful" | "presentational" | "unknown"
  template: string
  styles: string
  logic?: {
    state: StateVariable[]
    methods: MethodSpec[]
    events: EventBinding[]
  }
  manifest?: {
    name: string
    type: "stateful" | "presentational" | "unknown"
    path: string
    children: string[]
    state: Record<string, StateVariable>
    events: Record<string, EventBinding>
    migration: {
      effort: string
      effortBreakdown: {
        extraction: string
        conversion: string
      }
      suggestions: string[]
      todos: MigrationTodo[]
    }
  }
  matchConfidence: number
}
