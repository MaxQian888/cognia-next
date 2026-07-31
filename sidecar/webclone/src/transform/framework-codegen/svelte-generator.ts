import { BaseFrameworkGenerator } from "./base-generator.js"
import type { ComponentSpec, FrameworkCodeGenOptions, GeneratedComponent } from "../../types.js"
import type { StateVariable, EventBinding } from "../../types.js"
import { frameworkRules, templateRules } from "./framework-rules.js"

/**
 * Svelte component code generator
 * Generates Svelte single-file components with reactive variables
 */
export class SvelteGenerator extends BaseFrameworkGenerator {
  constructor() {
    super("svelte")
  }

  generate(spec: ComponentSpec, options: FrameworkCodeGenOptions): GeneratedComponent {
    const stateDeclarations = this.mapState(spec.logic?.state || [], options)
    const eventMethods = this.mapEvents(spec.logic?.events || [], options)
    const template = this.mapTemplate(spec.template, spec.logic, options)
    const styles = this.mapStyles(spec.styles, options)
    const useTs = options.typescript !== false

    const langAttr = useTs ? ' lang="ts"' : ""
    const code = `<script${langAttr}>
${stateDeclarations}

${eventMethods}
</script>

<div>
${template}
</div>${styles}`

    const imports = this.collectImports(spec, options)

    return {
      name: spec.name,
      code,
      language: "svelte",
      imports,
      dependencies: this.resolveDependencies(spec, options),
      metadata: this.buildMetadata(spec),
    }
  }

  protected mapState(state: StateVariable[], options: FrameworkCodeGenOptions): string {
    if (state.length === 0) {
      return ""
    }

    return state
      .map((s) => {
        const typeHint = options.typescript !== false && s.type !== "unknown" ? `: ${s.type}` : ""
        const initialValue = JSON.stringify(s.initial)
        return `  let ${s.name}${typeHint} = ${initialValue};`
      })
      .join("\n")
  }

  protected mapEvents(events: EventBinding[], _options: FrameworkCodeGenOptions): string {
    if (events.length === 0) {
      return ""
    }
    return events
      .map((e) => {
        const handlerName = e.handler || `handle${this.pascalCase(e.event)}`
        return `const ${handlerName} = () => {
    // TODO: Handle ${e.event} event on ${e.selector}
  };`
      })
      .join("\n\n")
  }

  protected mapTemplate(html: string, _logic: unknown, _options: FrameworkCodeGenOptions): string {
    let template = html

    // Step 1: Handle self-closing elements with data-condition
    template = template.replace(
      /<([\w-]+)(\s[^>]*?)data-condition="([^"]*)"([^>]*?)\/>/g,
      (_, tag, pre, condition, post) => {
        return `{#if ${condition.trim()}}<${tag}${pre}${post} />{/if}`
      }
    )

    // Step 2: Wrap elements with data-condition in {#if}...{/if} blocks
    // Use negative lookahead to avoid matching nested elements of the same tag
    template = template.replace(
      /<([\w-]+)(\s[^>]*?)data-condition="([^"]*)"([^>]*?)>((?:(?:<\/\1>)[\s\S])*)<\/\1>/g,
      (_, tag, pre, condition, post, content) => {
        return `{#if ${condition.trim()}}<${tag}${pre}${post}>${content}</${tag}>{/if}`
      }
    )

    // Step 2: Replace data-binding with {variable}
    template = template.replace(/data-binding="([^"]*)"/g, (_, variable) =>
      frameworkRules.svelte.templateBinding(variable.trim())
    )

    // Step 3: Replace data-event with on:event={handler}
    template = template.replace(/data-event="([^:]*):([^"]*)"/g, (_, event, handler) =>
      frameworkRules.svelte.eventBinding(event.trim(), handler.trim())
    )

    // Step 4: Clean up remaining data-* attributes
    template = templateRules.cleanAttributes(template)

    // Step 5: Indent template
    template = template
      .split("\n")
      .map((line) => "  " + line)
      .join("\n")

    return template
  }

  protected mapStyles(css: string, _options: FrameworkCodeGenOptions): string {
    return super.mapStyles(css, _options)
  }

  protected collectImports(_spec: ComponentSpec, _options: FrameworkCodeGenOptions): string[] {
    // Svelte doesn't require explicit imports in most cases
    // Dependencies are listed in package.json
    return []
  }
}
