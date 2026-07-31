export type {
  SnapshotMode,
  SnapshotOptions,
  FrameworkCodeGenOptions,
  CodegenFramework,
  FrameworkHint,
  MemoryBudget,
  HtmlStrategy,
  CssStrategy,
  JsStrategy,
} from "./config/schema.js"

export type AssetType = "css" | "js" | "img" | "font" | "media" | "other"
export type AssetStatus = "pending" | "fetched" | "failed" | "skipped"

export interface StateVariable {
  name: string
  type: string
  initial?: unknown
  bindings: string[]
  mutators: string[]
  confidence: number
}

export interface MethodSpec {
  name: string
  kind: "handler" | "lifecycle" | "utility"
  code: string
  parameters: string[]
  sideEffects: string[]
}

export interface EventBinding {
  selector: string
  event: string
  handler: string
  preventDefault?: boolean
}

export interface MigrationTodo {
  type: "dom_ref" | "state_mapping" | "event_binding" | "unknown_pattern"
  description: string
  severity: "critical" | "warning" | "info"
}

export interface ComponentManifest {
  name: string
  type: "stateful" | "presentational" | "unknown"
  path: string
  children: string[]
  state: Record<string, StateVariable>
  events: Record<string, EventBinding>
  migration: {
    effort: string
    effortBreakdown: { extraction: string; conversion: string }
    suggestions: string[]
    todos: MigrationTodo[]
  }
}

export interface ComponentSpec {
  name: string
  type: "stateful" | "presentational" | "unknown"
  parent?: string
  children: string[]
  template: string
  styles: string
  matchConfidence?: number
  logic?: {
    state: StateVariable[]
    methods: MethodSpec[]
    events: EventBinding[]
  }
  manifest: ComponentManifest
}

export interface ConvertResult extends SnapshotResult {
  components: Map<string, ComponentSpec>
  componentTree?: Record<string, unknown>
  index?: Record<string, unknown>
}

export interface AssetRef {
  url: string
  type: AssetType
  origin: string
  attribute?: string
}

export interface Asset {
  originUrl: string
  localPath?: string
  dataUri?: string
  textContent?: string
  type: AssetType
  status: AssetStatus
  size: number
  mime: string
  error?: string
}

export interface SnapshotResult {
  sourceUrl: string
  timestamp: string
  html: string
  assets: Asset[]
  stats: {
    total: number
    fetched: number
    failed: number
    skipped: number
    validationWarnings: number
    totalBytes: number
    stateful?: number
    presentational?: number
  }
}

export const MAX_INLINE_SIZE = 10 * 1024 * 1024

export interface GeneratedComponent {
  name: string
  code: string
  language: "vue" | "jsx" | "tsx" | "svelte" | "ts" | "js"
  imports: string[]
  dependencies: string[]
  metadata: {
    hasState: boolean
    eventCount: number
    styleSize: number
  }
}

export interface GeneratedFramework {
  components: GeneratedComponent[]
  appTemplate?: string
  mainEntry?: string
  packageJson?: Record<string, unknown>
  shared?: {
    api?: string
    utils?: string
  }
}
