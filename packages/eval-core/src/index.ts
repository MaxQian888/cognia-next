export * from "./types"
export * from "./statistics"
export * from "./preflight"
export * from "./recommendation"
export * from "./portable"
export * from "./judging"
export * from "./adaptive"
export * from "./json"

// The shared domain model — the types the app (`@/types/eval/*` shims), the
// CLI, and CI all compile against.
export * from "./domain/eval"
export * from "./domain/gate"
export * from "./domain/grading"
export * from "./domain/run-config"
export * from "./domain/comparison"
export * from "./domain/version"
export * from "./domain/import"
export * from "./domain/settings"

// Execution + aggregation + gating: one implementation for the app, the CLI,
// and CI.
export * from "./runner"
export * from "./report"
export * from "./gate"
export * from "./scorers/index"
export * from "./scorers/select"
export * from "./scorers/judge-client"

// Versioned contracts for the quality flywheel: what an evaluator IS, what one
// observation looks like whoever produced it, and when a policy scores a live
// trace.
export * from "./evaluator-spec"
export * from "./observation"
export * from "./online-policy"
