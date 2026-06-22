/**
 * Refactoring skills (inline markdown playbooks) contributed by the plugin.
 *
 * Each skill is stored in the skill-registry under its verbatim id (see
 * `lib/plugin/registries/skill-registry.ts`), so the id is self-namespaced as
 * `cognia-backend-refactor:<name>` via `packSkillId`. Role characters attach
 * them through `pluginSkillIds`; `resolveSkillsForCharacter` inlines the
 * markdown into the system prompt at send time.
 */

import { defineSkill } from "@cognia/plugin-sdk"
import type { PluginSkillDef } from "@/types/plugin/plugin-skill"
import { packSkillId } from "../ids"

const GO_CLEAN_ARCHITECTURE = defineSkill({
  id: packSkillId("go-clean-architecture"),
  name: "Go Clean Architecture",
  description: "Layering, dependency injection, and repository patterns for Go backends.",
  scope: "character",
  source: {
    kind: "inline",
    markdown: [
      "# Go Clean Architecture",
      "",
      "Target a thin-transport, dependency-injected layering:",
      "",
      "- **Transport (handler)**: parse/validate input, call a service, map the result to a response. No business logic, no direct DB access.",
      "- **Service (usecase)**: business rules. Depends on repository *interfaces*, never concrete drivers. Accept `context.Context` as the first arg.",
      "- **Repository**: data access behind an interface declared in the service package (consumer-defined interface). Concrete implementation lives in an `infra`/`store` package.",
      "- **Domain types**: plain structs; no framework tags leaking transport concerns into the core.",
      "",
      "## Rules",
      "- Inject dependencies via constructors (`NewXService(repo Repo) *XService`); wire them in `main.go`/`cmd`. No global singletons.",
      "- Define interfaces at the consumer, keep them small (1–3 methods). Don't pre-create interfaces with one implementation and one caller unless it breaks a cycle or enables a test seam.",
      '- Wrap errors with `fmt.Errorf("...: %w", err)`; never discard them. Return typed sentinel/domain errors the transport maps to status codes in one place.',
      "- Propagate `context.Context`; honour cancellation and deadlines on every I/O call.",
      "- Group packages by domain (`user/`, `auth/`), not by technical layer across the whole tree.",
      "",
      "## Migration order",
      "Introduce interfaces + constructors, move logic out of handlers into services, push data access behind repositories, then delete the old paths. Keep the build green at every step (expand/contract).",
    ].join("\n"),
  },
})

const REFACTOR_PLAYBOOK = defineSkill({
  id: packSkillId("refactor-playbook"),
  name: "Refactor Playbook",
  description: "Safe, incremental refactoring discipline that keeps the build green.",
  scope: "character",
  source: {
    kind: "inline",
    markdown: [
      "# Refactor Playbook",
      "",
      "Refactoring preserves behaviour. Change structure OR behaviour, never both in one step.",
      "",
      "## Loop",
      "1. Confirm the build/tests are green before you start.",
      "2. Make ONE small, behaviour-preserving change.",
      "3. Run `go build ./...` and the affected package tests.",
      "4. If green, continue; if red, revert the last step and try smaller.",
      "",
      "## Patterns",
      "- **Expand/contract (parallel-change)**: add the new shape, migrate call sites incrementally, remove the old shape last. Prefer this over big-bang rewrites.",
      "- **Characterization tests**: when behaviour is unclear, write a test that pins current behaviour *before* changing structure.",
      "- Keep diffs small and reviewable; one module/concern per commit.",
      "",
      "## Never",
      "- Never weaken, skip, or delete a test to make it pass.",
      "- Never mix a rename/move with a logic change in the same commit.",
      "- Never leave the tree un-buildable between steps.",
    ].join("\n"),
  },
})

const GO_TESTING = defineSkill({
  id: packSkillId("go-testing"),
  name: "Go Testing",
  description: "Table-driven tests, coverage, and where to mock in Go.",
  scope: "character",
  source: {
    kind: "inline",
    markdown: [
      "# Go Testing",
      "",
      "- Prefer **table-driven** tests with `t.Run(name, ...)` subtests; name cases by behaviour.",
      "- Exercise error paths and edge cases, not just the happy path. Assert wrapped-error identity with `errors.Is`/`errors.As`.",
      "- Mock only at **owned boundaries** — repository interfaces, external HTTP/clients. Prefer real implementations (in-memory repo, httptest server) for service-layer tests.",
      "- Use `testing.T` helpers (`t.Helper()`, `t.Cleanup()`), `t.Parallel()` where safe, and `testify` only if the repo already uses it.",
      "- Measure with `go test ./... -cover`; report before/after for touched packages. Don't chase coverage with assertions on incidental internals — that makes the suite brittle.",
      "- Keep tests deterministic: no real sleeps, no network unless via a local test server, seed randomness.",
    ].join("\n"),
  },
})

const BACKEND_INFRA = defineSkill({
  id: packSkillId("backend-infra"),
  name: "Backend Engineering Infra",
  description:
    "CI, linting, config/secrets, structured logging, and observability for Go services.",
  scope: "character",
  source: {
    kind: "inline",
    markdown: [
      "# Backend Engineering Infra",
      "",
      "- **Config & secrets**: load from environment (12-factor); validate required values at startup and fail fast. Never commit secrets; document required env vars.",
      "- **Linting/format**: `gofmt`/`goimports` clean; `go vet` and `golangci-lint run` pass. Don't disable linters to pass — fix the cause.",
      "- **CI**: a workflow that runs build, vet, lint, and tests on every push/PR. Cache modules; fail the job on any red gate.",
      "- **Logging**: structured (`slog`/zap), levelled, with request-scoped fields; no secrets/PII in logs. One logging approach across the service.",
      "- **Observability**: surface health/readiness endpoints; add request metrics/traces at the transport boundary where the framework supports it.",
      "- **Errors → responses**: map domain errors to HTTP status codes in one place; return consistent error payloads.",
    ].join("\n"),
  },
})

const DEPENDENCY_UPGRADE = defineSkill({
  id: packSkillId("dependency-upgrade"),
  name: "Dependency Upgrade",
  description: "Safely upgrading the Go version and module dependencies.",
  scope: "character",
  source: {
    kind: "inline",
    markdown: [
      "# Dependency Upgrade",
      "",
      "- Upgrade in **small, isolated steps** — one dependency (or one related cluster) at a time, each with its own green build + tests.",
      "- Read the changelog/release notes for breaking changes before bumping a major version; plan the code migration first.",
      "- Use `go get <mod>@<version>` then `go mod tidy`; review `go.mod`/`go.sum` diffs. Run `go build ./...`, `go vet`, and tests after each bump.",
      "- For the Go toolchain version: bump `go` in `go.mod`, fix any new vet/lint findings, and confirm CI uses the matching version.",
      "- Prefer removing unmaintained/vulnerable libraries over pinning them; check `govulncheck` if available.",
      "- Don't bundle a dependency upgrade with a behavioural refactor — keep them in separate, revertable commits.",
    ].join("\n"),
  },
})

/** All skills, in a stable order. Declared on `manifest.skills`. */
export const REFACTOR_SKILLS: PluginSkillDef[] = [
  GO_CLEAN_ARCHITECTURE,
  REFACTOR_PLAYBOOK,
  GO_TESTING,
  BACKEND_INFRA,
  DEPENDENCY_UPGRADE,
]
