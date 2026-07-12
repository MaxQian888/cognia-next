import type { ComponentSpec } from "../../types.js"
import type { FrameworkCodeGenOptions, GeneratedComponent } from "../../types.js"
import type { StateVariable, EventBinding, MethodSpec } from "../../types.js"
import { cssStrategies, dependencyMaps } from "./framework-rules.js"

/**
 * Base class for framework-specific code generators
 */
export abstract class BaseFrameworkGenerator {
  protected framework: "vue" | "react" | "angular" | "svelte" | "jquery"

  constructor(framework: "vue" | "react" | "angular" | "svelte" | "jquery") {
    this.framework = framework
  }

  abstract generate(spec: ComponentSpec, options: FrameworkCodeGenOptions): GeneratedComponent

  protected abstract mapState(state: StateVariable[], options: FrameworkCodeGenOptions): string

  protected abstract mapEvents(events: EventBinding[], options: FrameworkCodeGenOptions): string

  protected abstract mapTemplate(
    html: string,
    _logic: unknown,
    _options: FrameworkCodeGenOptions
  ): string

  protected abstract collectImports(spec: ComponentSpec, options: FrameworkCodeGenOptions): string[]

  /**
   * Framework-specific CSS handling: routes to the correct strategy
   * based on the framework type, avoiding `as any` type bypass.
   */
  protected mapStyles(css: string, options: FrameworkCodeGenOptions): string {
    if (!css || css.trim() === "") {
      return ""
    }
    // Framework-specific CSS handling
    if (this.framework === "react") {
      return cssStrategies.react.wrapStyles(css, options.cssModules)
    }
    if (this.framework === "vue") {
      return cssStrategies.vue.wrapStyles(css)
    }
    if (this.framework === "angular") {
      return cssStrategies.angular.wrapStyles(css)
    }
    if (this.framework === "svelte") {
      return cssStrategies.svelte.wrapStyles(css)
    }
    return cssStrategies.jquery.wrapStyles(css)
  }

  /**
   * Lift to base: all 5 generators construct identical metadata objects
   */
  protected buildMetadata(spec: ComponentSpec) {
    return {
      hasState: (spec.logic?.state?.length ?? 0) > 0,
      eventCount: spec.logic?.events?.length ?? 0,
      styleSize: spec.styles?.length ?? 0,
    }
  }

  /**
   * Default event handler stub generation (used by Vue, React)
   * Override for framework-specific event syntax
   */
  protected generateEventHandlerStubs(events: EventBinding[]): string {
    if (events.length === 0) {
      return ""
    }
    return events
      .map((e) => {
        const handlerName = e.handler || `handle${this.pascalCase(e.event)}`
        return `const ${handlerName} = () => {
  // TODO: Handle ${e.event} event on ${e.selector}
}`
      })
      .join("\n\n")
  }

  /**
   * Deduplicate events by handler name (used by Angular, Svelte)
   */
  protected deduplicateEvents(events: EventBinding[]): string {
    if (events.length === 0) {
      return ""
    }
    const methodMap = new Map<string, EventBinding[]>()
    events.forEach((e) => {
      if (!methodMap.has(e.handler)) {
        methodMap.set(e.handler, [])
      }
      const handlerEvents = methodMap.get(e.handler)
      if (handlerEvents) {
        handlerEvents.push(e)
      }
    })
    return Array.from(methodMap.entries())
      .map(([handler]) => {
        return `${handler}() {
    // TODO: Implement ${handler}
  }`
      })
      .join("\n\n  ")
  }

  /**
   * Resolve external dependencies using dependencyMaps from framework-rules
   */
  protected resolveDependencies(spec: ComponentSpec, _options: FrameworkCodeGenOptions): string[] {
    const deps = new Set<string>()

    // Always add the framework itself as a dependency
    if (this.framework === "vue") {
      deps.add("vue")
    } else if (this.framework === "react") {
      deps.add("react")
      deps.add("react-dom")
    } else if (this.framework === "angular") {
      deps.add("@angular/core")
      deps.add("@angular/common")
    } else if (this.framework === "svelte") {
      deps.add("svelte")
    } else if (this.framework === "jquery") {
      deps.add("jquery")
    }

    // Use dependencyMaps for pattern-based detection
    if (spec.logic?.methods) {
      const frameworkMap = dependencyMaps[this.framework] || {}
      const patternToDep: [RegExp, string][] = Object.entries(frameworkMap).map(
        ([pattern, dep]) => [new RegExp(pattern), dep]
      )

      spec.logic.methods.forEach((method: { code?: string }) => {
        if (method.code) {
          for (const [regex, dep] of patternToDep) {
            if (regex.test(method.code)) {
              deps.add(dep)
            }
          }
        }
      })
    }

    // Check for state complexity
    if ((spec.logic?.state?.length ?? 0) > 5) {
      if (this.framework === "vue") {
        deps.add("pinia")
      } else if (this.framework === "react") {
        deps.add("zustand")
      }
    }

    return Array.from(deps)
  }

  /**
   * Extract methods from component logic
   */
  protected extractMethods(logic: { methods?: MethodSpec[] } | undefined): string {
    if (!logic?.methods || logic.methods.length === 0) {
      return ""
    }

    return logic.methods
      .map(
        (method: MethodSpec) =>
          `
// ${method.kind.toUpperCase()}: ${method.name}
const ${method.name} = () => {
  // TODO: Implement ${method.name}
  // Original: ${method.code?.substring(0, 50)}...
}
`
      )
      .join("\n")
  }

  /**
   * Helper: Pascalcase a string
   */
  protected pascalCase(str: string): string {
    return str
      .split(/[-_]/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("")
  }

  /**
   * Helper: camelCase a string
   */
  protected camelCase(str: string): string {
    const pascal = this.pascalCase(str)
    return pascal.charAt(0).toLowerCase() + pascal.slice(1)
  }
}
