import type { ComponentSpec } from "../../types.js"
import type {
  FrameworkCodeGenOptions,
  GeneratedComponent,
  GeneratedFramework,
} from "../../types.js"
import { VueGenerator } from "./vue-generator.js"
import { ReactGenerator } from "./react-generator.js"
import { AngularGenerator } from "./angular-generator.js"
import { SvelteGenerator } from "./svelte-generator.js"
import { JQueryGenerator } from "./jquery-generator.js"
import { SharedLogicExtractor } from "./shared-logic-extractor.js"

type FrameworkGenerator =
  VueGenerator | ReactGenerator | AngularGenerator | SvelteGenerator | JQueryGenerator

interface PackageJson {
  name: string
  version: string
  type: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  [key: string]: unknown
}

/**
 * Main entry point for framework code generation
 * Routes to appropriate generator based on framework selection
 */
export class FrameworkCodeGenerator {
  private vueGenerator: VueGenerator
  private reactGenerator: ReactGenerator
  private angularGenerator: AngularGenerator
  private svelteGenerator: SvelteGenerator
  private jqueryGenerator: JQueryGenerator

  constructor() {
    this.vueGenerator = new VueGenerator()
    this.reactGenerator = new ReactGenerator()
    this.angularGenerator = new AngularGenerator()
    this.svelteGenerator = new SvelteGenerator()
    this.jqueryGenerator = new JQueryGenerator()
  }

  /**
   * Generate code for a single component
   */
  generateComponent(
    spec: ComponentSpec,
    options: FrameworkCodeGenOptions
  ): GeneratedComponent | null {
    if (!options.framework) {
      return null
    }

    try {
      let generator: FrameworkGenerator | null = null
      switch (options.framework) {
        case "vue":
          generator = this.vueGenerator
          break
        case "react":
          generator = this.reactGenerator
          break
        case "angular":
          generator = this.angularGenerator
          break
        case "svelte":
          generator = this.svelteGenerator
          break
        case "jquery":
          generator = this.jqueryGenerator
          break
        default:
          generator = null
      }
      if (!generator) return null
      return generator.generate(spec, options)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`Failed to generate ${options.framework} code for ${spec.name}: ${message}`)
      return null
    }
  }

  /**
   * Generate code for multiple components
   */
  generateComponents(specs: ComponentSpec[], options: FrameworkCodeGenOptions): GeneratedFramework {
    const components = specs
      .map((spec) => this.generateComponent(spec, options))
      .filter((comp): comp is GeneratedComponent => comp !== null)

    return {
      components,
      shared: this.extractSharedLogic(specs, options),
    }
  }

  /**
   * Extract shared logic (API calls, utilities, etc.)
   */
  private extractSharedLogic(
    specs: ComponentSpec[],
    options: FrameworkCodeGenOptions
  ): { api?: string; utils?: string; constants?: string } | undefined {
    if (!options.extractSharedLogic) {
      return undefined
    }

    const result: { api?: string; utils?: string; constants?: string } = {}

    // Extract API logic
    result.api = SharedLogicExtractor.extractApiLogic(specs)

    // Extract utilities
    result.utils = SharedLogicExtractor.extractUtilities(specs)

    // Extract constants
    result.constants = SharedLogicExtractor.extractConstants(specs)

    return Object.keys(result).length > 0 ? result : undefined
  }

  /**
   * Generate application template (App.vue or App.jsx)
   */
  generateAppTemplate(
    componentSpecs: GeneratedComponent[],
    options: FrameworkCodeGenOptions
  ): string {
    if (!options.framework) {
      return ""
    }

    switch (options.framework) {
      case "vue":
        return this.generateVueApp(componentSpecs)
      case "react":
        return this.generateReactApp(componentSpecs)
      case "angular":
        return this.generateAngularApp(componentSpecs)
      case "svelte":
        return this.generateSvelteApp(componentSpecs)
      case "jquery":
        return this.generateJQueryApp(componentSpecs)
      default:
        return ""
    }
  }

  private generateVueApp(components: GeneratedComponent[]): string {
    const imports = components
      .map((c) => `import ${c.name} from './components/${c.name}/${c.name}.vue'`)
      .join("\n")

    const templateLines = components.map((c) => `    <${c.name} />`).join("\n")

    return `<template>
  <div id="app">
    <main>
${templateLines}
    </main>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
${imports}

onMounted(() => {
  console.log('App mounted')
})
</script>

<style scoped>
#app {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  padding: 1rem;
}

main {
  flex: 1;
}
</style>
`
  }

  private generateReactApp(components: GeneratedComponent[]): string {
    const imports = components
      .map((c) => `import ${c.name} from './components/${c.name}/${c.name}'`)
      .join("\n")

    const templateLines = components.map((c) => `      <${c.name} />`).join("\n")

    return `import React from 'react'
${imports}
import './App.css'

export default function App() {
  React.useEffect(() => {
    console.log('App mounted')
  }, [])

  return (
    <div id="app">
      <main>
${templateLines}
      </main>
    </div>
  )
}
`
  }

  private generateAngularApp(components: GeneratedComponent[]): string {
    const imports = components
      .map(
        (c) => `import { ${c.name}Component } from './components/${c.name}/${c.name}.component';`
      )
      .join("\n")

    const declarations = components.map((c) => `    ${c.name}Component`).join(",\n")

    const templateLines = components
      .map(
        (c) =>
          `    <app-${c.name
            .replace(/([A-Z])/g, "-$1")
            .toLowerCase()
            .slice(1)} />`
      )
      .join("\n")

    return `import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
${imports}

@Component({
  selector: 'app-root',
  template: \`
    <div id="app">
      <main>
${templateLines}
      </main>
    </div>
  \`,
  styles: [\`
    #app {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
      padding: 1rem;
    }
    main {
      flex: 1;
    }
  \`],
  standalone: true,
  imports: [CommonModule, ${declarations}],
})
export class AppComponent {
  ngOnInit() {
    console.log('App initialized');
  }
}
`
  }

  private generateSvelteApp(components: GeneratedComponent[]): string {
    const imports = components
      .map((c) => `import ${c.name} from './components/${c.name}/${c.name}.svelte';`)
      .join("\n")

    const templateLines = components.map((c) => `  <${c.name} />`).join("\n")

    return `<script lang="ts">
import { onMount } from 'svelte';
${imports}

onMount(() => {
  console.log('App mounted');
});
</script>

<div id="app">
  <main>
${templateLines}
  </main>
</div>

<style>
  #app {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    padding: 1rem;
  }
  main {
    flex: 1;
  }
</style>
`
  }

  private generateJQueryApp(components: GeneratedComponent[]): string {
    const imports = components
      .map((c) => `import { ${c.name} } from './components/${c.name}/${c.name}';`)
      .join("\n")

    const initLines = components
      .map((c) => `  new ${c.name}('#${c.name.toLowerCase()}');`)
      .join("\n")

    const htmlLines = components.map((c) => `  <div id="${c.name.toLowerCase()}"></div>`).join("\n")

    return `${imports}
import $ from 'jquery';

$(document).ready(() => {
  console.log('App initialized');
${initLines}
});

// HTML structure:
// <div id="app">
//   <main>
${htmlLines}
//   </main>
// </div>
`
  }

  /**
   * Generate main entry point
   */
  generateMainEntry(options: FrameworkCodeGenOptions): { filename: string; code: string } {
    if (!options.framework) {
      return { filename: "", code: "" }
    }

    switch (options.framework) {
      case "vue":
        return {
          filename: "main.ts",
          code: `import { createApp } from 'vue'
import App from './App.vue'

const app = createApp(App)
app.mount('#app')
`,
        }
      case "react":
        return {
          filename: options.typescript ? "main.tsx" : "main.jsx",
          code: `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
`,
        }
      case "angular":
        return {
          filename: "main.ts",
          code: `import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app.component';
import { appConfig } from './app.config';

bootstrapApplication(AppComponent, appConfig).catch(err =>
  console.error(err),
);
`,
        }
      case "svelte":
        return {
          filename: "main.ts",
          code: `import App from './App.svelte'

const app = new App({
  target: document.getElementById('app')!,
})

export default app
`,
        }
      case "jquery":
        return {
          filename: options.typescript ? "main.ts" : "main.js",
          code: `import $ from 'jquery'
import('./App').then(module => {
  $(document).ready(() => {
    console.log('jQuery app ready');
    // Initialize components here
  });
});
`,
        }
      default:
        return { filename: "", code: "" }
    }
  }

  /**
   * Generate package.json
   */
  generatePackageJson(
    appName: string,
    options: FrameworkCodeGenOptions,
    dependencies: string[]
  ): PackageJson {
    const basePackage = {
      name: appName.toLowerCase().replace(/\s+/g, "-"),
      version: "0.1.0",
      type: "module",
    }

    switch (options.framework) {
      case "vue":
        return {
          ...basePackage,
          scripts: {
            dev: "vite",
            build: "vue-tsc && vite build",
            preview: "vite preview",
          },
          dependencies: {
            vue: "^3.3.0",
            ...this.resolveDeps(dependencies, "vue"),
          },
          devDependencies: {
            typescript: "^5.0.0",
            vite: "^4.0.0",
            "@vitejs/plugin-vue": "^4.0.0",
            "vue-tsc": "^1.0.0",
          },
        }
      case "react":
        return {
          ...basePackage,
          scripts: {
            dev: "vite",
            build: "tsc && vite build",
            preview: "vite preview",
          },
          dependencies: {
            react: "^18.2.0",
            "react-dom": "^18.2.0",
            ...this.resolveDeps(dependencies, "react"),
          },
          devDependencies: {
            typescript: "^5.0.0",
            vite: "^4.0.0",
            "@vitejs/plugin-react": "^4.0.0",
            "@types/react": "^18.0.0",
            "@types/react-dom": "^18.0.0",
          },
        }
      case "angular":
        return {
          ...basePackage,
          scripts: {
            dev: "ng serve",
            build: "ng build",
            preview: "ng serve --open",
          },
          dependencies: {
            "@angular/animations": "^17.0.0",
            "@angular/common": "^17.0.0",
            "@angular/compiler": "^17.0.0",
            "@angular/core": "^17.0.0",
            "@angular/forms": "^17.0.0",
            "@angular/platform-browser": "^17.0.0",
            "@angular/platform-browser-dynamic": "^17.0.0",
            rxjs: "^7.8.0",
            tslib: "^2.6.0",
            "zone.js": "^0.14.0",
            ...this.resolveDeps(dependencies, "angular"),
          },
          devDependencies: {
            "@angular-devkit/build-angular": "^17.0.0",
            "@angular/cli": "^17.0.0",
            "@angular/compiler-cli": "^17.0.0",
            typescript: "^5.2.0",
          },
        }
      case "svelte":
        return {
          ...basePackage,
          scripts: {
            dev: "vite",
            build: "vite build",
            preview: "vite preview",
          },
          dependencies: {
            svelte: "^4.0.0",
            ...this.resolveDeps(dependencies, "svelte"),
          },
          devDependencies: {
            typescript: "^5.0.0",
            vite: "^4.0.0",
            svelte: "^4.0.0",
            "svelte-check": "^3.0.0",
          },
        }
      case "jquery":
        return {
          ...basePackage,
          scripts: {
            dev: "vite",
            build: "tsc && vite build",
            preview: "vite preview",
          },
          dependencies: {
            jquery: "^3.7.0",
            ...this.resolveDeps(dependencies, "jquery"),
          },
          devDependencies: {
            typescript: "^5.0.0",
            vite: "^4.0.0",
            "@types/jquery": "^3.5.0",
          },
        }
      default:
        return basePackage
    }
  }

  private resolveDeps(
    dependencies: string[],
    _framework: "vue" | "react" | "angular" | "svelte" | "jquery"
  ): Record<string, string> {
    const versions: Record<string, string> = {
      axios: "^1.6.0",
      dayjs: "^1.11.0",
      "date-fns": "^2.30.0",
      lodash: "^4.17.0",
      "lodash-es": "^4.17.0",
      pinia: "^2.1.0",
      zustand: "^4.4.0",
      "@angular/common/http": "^17.0.0",
    }

    const resolved: Record<string, string> = {}
    dependencies.forEach((dep) => {
      if (versions[dep]) {
        resolved[dep] = versions[dep]
      }
    })

    return resolved
  }
}

// Export singleton
export const codeGenerator = new FrameworkCodeGenerator()
