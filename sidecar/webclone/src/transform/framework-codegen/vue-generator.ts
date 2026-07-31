import type { ComponentSpec } from "../../types.js"
import type { FrameworkCodeGenOptions, GeneratedComponent } from "../../types.js"
import type { StateVariable, EventBinding } from "../../types.js"
import { BaseFrameworkGenerator } from "./base-generator.js"
import { frameworkRules, templateRules } from "./framework-rules.js"

export class VueGenerator extends BaseFrameworkGenerator {
  constructor() {
    super("vue")
  }

  generate(spec: ComponentSpec, options: FrameworkCodeGenOptions): GeneratedComponent {
    const componentName = this.pascalCase(spec.name)
    const imports = this.collectImports(spec, options)
    const useTs = options.typescript !== false

    const scriptContent = this.generateScriptSetup(spec, options, imports)

    const template = this.mapTemplate(spec.template, spec.logic, options)

    const styles = this.mapStyles(spec.styles || "", options)

    const langAttr = useTs ? ' lang="ts"' : ""
    const code = `<template>
  ${template}
</template>

<script setup${langAttr}>
${scriptContent}
</script>

${styles}`

    return {
      name: componentName,
      code,
      language: "vue",
      imports,
      dependencies: this.resolveDependencies(spec, options),
      metadata: this.buildMetadata(spec),
    }
  }

  private generateScriptSetup(
    spec: ComponentSpec,
    options: FrameworkCodeGenOptions,
    imports: string[]
  ): string {
    let script = ""

    if (imports.length > 0) {
      script += `import { ${imports.join(", ")} } from 'vue'\n`
    }

    script += "\n"

    if (spec.logic?.state && spec.logic.state.length > 0) {
      script += this.mapState(spec.logic.state, options)
      script += "\n\n"
    }

    if (spec.logic?.methods && spec.logic.methods.length > 0) {
      script += this.extractMethods(spec.logic)
      script += "\n"
    }

    if (!spec.logic?.state && !spec.logic?.methods) {
      script += "// TODO: Add component logic\n"
    }

    return script.trim()
  }

  protected mapState(state: StateVariable[], options: FrameworkCodeGenOptions): string {
    return state
      .map((s) => {
        const typeHint = options.typescript !== false && s.type !== "unknown" ? `: ${s.type}` : ""
        return `const ${s.name}${typeHint} = ref(${JSON.stringify(s.initial)})`
      })
      .join("\n")
  }

  protected mapEvents(events: EventBinding[]): string {
    return this.generateEventHandlerStubs(events)
  }

  protected mapTemplate(html: string, _logic: unknown, _options: FrameworkCodeGenOptions): string {
    let template = html

    template = template.replace(/data-binding="([^"]+)"/g, (_match, variable) =>
      frameworkRules.vue.templateBinding(variable)
    )

    template = template.replace(/data-event="([^:]+):([^"]+)"/g, (_match, event, handler) =>
      frameworkRules.vue.eventBinding(event, handler)
    )

    template = template.replace(/data-condition="([^"]+)"/g, (_match, condition) =>
      frameworkRules.vue.conditionalBinding(condition)
    )

    template = templateRules.cleanAttributes(template)

    if (!template.trim().startsWith("<")) {
      template = `<div>${template}</div>`
    }

    return template.trim()
  }

  protected mapStyles(css: string, options: FrameworkCodeGenOptions): string {
    return super.mapStyles(css, options)
  }

  protected collectImports(spec: ComponentSpec, _options: FrameworkCodeGenOptions): string[] {
    const imports = new Set<string>()

    if (spec.logic?.state && spec.logic.state.length > 0) {
      imports.add("ref")
    }

    const lifecycleMethods = new Set([
      "mounted",
      "unmounted",
      "created",
      "destroyed",
      "init",
      "destroy",
    ])
    if (spec.logic?.methods?.some((m: { name: string }) => lifecycleMethods.has(m.name))) {
      imports.add("onMounted")
      imports.add("onUnmounted")
    }

    return Array.from(imports)
  }
}
