export const DEFAULTS = {
  output: "./snapshot",
  mode: "bundle" as const,
  maxAssets: 100,
  concurrency: 6,
  timeout: 15000,
  retryCount: 1,
  retryInitialDelay: 200,
  retryMaxDelay: 2000,
  inline: true,
  pretty: false,
  extractComponents: false,
  extractLogic: true,
  memoryLimit: 1536,
  codegenTypescript: true,
  codegenCssModules: false,
  codegenGenerateDrafts: false,
  codegenExtractShared: false,

  /** Valid framework identifiers for codegen */
  codegenFrameworks: ["vue", "react", "angular", "svelte", "jquery"] as const,

  /** Valid framework hints for component extraction */
  frameworkHints: ["vue", "react", "svelte"] as const,
} as const
