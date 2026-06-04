import type { CliSpec } from "../types"

export const cargoSpec: CliSpec = {
  name: "cargo",
  description: "Rust package manager and build tool",
  options: [{ name: "--version", aliases: ["-V"], description: "Show version" }],
  subcommands: [
    {
      name: "build",
      aliases: ["b"],
      description: "Compile the package",
      options: [
        { name: "--release", aliases: ["-r"], description: "Optimized build" },
        { name: "--features", description: "Enable features", takesValue: true },
        { name: "--workspace", description: "Build every workspace member" },
        { name: "--target", description: "Target triple", takesValue: true },
      ],
    },
    {
      name: "test",
      aliases: ["t"],
      description: "Run tests",
      options: [
        { name: "--release", description: "Test the release profile" },
        { name: "--no-run", description: "Compile but don't run" },
        { name: "--workspace", description: "Test every workspace member" },
      ],
    },
    {
      name: "run",
      aliases: ["r"],
      description: "Build and run a binary",
      options: [
        { name: "--release", description: "Optimized build" },
        { name: "--bin", description: "Run the named binary", takesValue: true },
        { name: "--example", description: "Run the named example", takesValue: true },
      ],
    },
    { name: "check", aliases: ["c"], description: "Type-check without codegen" },
    {
      name: "clippy",
      description: "Run lints",
      options: [{ name: "--fix", description: "Apply machine-fixable lints" }],
    },
    {
      name: "fmt",
      description: "Format with rustfmt",
      options: [{ name: "--check", description: "Fail on diffs without writing" }],
    },
    {
      name: "add",
      description: "Add a dependency",
      options: [
        { name: "--dev", description: "Add to dev-dependencies" },
        { name: "--features", aliases: ["-F"], description: "Enable features", takesValue: true },
      ],
    },
    { name: "remove", aliases: ["rm"], description: "Remove a dependency" },
    { name: "update", description: "Update the lockfile" },
    { name: "clean", description: "Remove build artifacts" },
    {
      name: "doc",
      description: "Build documentation",
      options: [{ name: "--open", description: "Open in a browser" }],
    },
    { name: "install", description: "Install a Rust binary" },
    { name: "new", description: "Create a new package" },
    { name: "init", description: "Create a package in an existing dir" },
    { name: "publish", description: "Upload to crates.io" },
    { name: "bench", description: "Run benchmarks" },
    { name: "tree", description: "Show the dependency graph" },
  ],
}

export const nodeSpec: CliSpec = {
  name: "node",
  description: "Node.js runtime",
  options: [
    { name: "--version", aliases: ["-v"], description: "Show version" },
    { name: "--eval", aliases: ["-e"], description: "Evaluate a script string", takesValue: true },
    { name: "--watch", description: "Restart on file change" },
    { name: "--test", description: "Run the built-in test runner" },
    { name: "--inspect", description: "Enable the debugger" },
    { name: "--env-file", description: "Load env vars from a file", takesValue: true },
    { name: "--experimental-strip-types", description: "Run TS by stripping types" },
  ],
}

export const denoSpec: CliSpec = {
  name: "deno",
  description: "Deno runtime",
  subcommands: [
    {
      name: "run",
      description: "Run a program",
      options: [
        { name: "--allow-net", description: "Allow network access" },
        { name: "--allow-read", description: "Allow fs reads" },
        { name: "--allow-write", description: "Allow fs writes" },
        { name: "--allow-env", description: "Allow env access" },
        { name: "--watch", description: "Restart on change" },
      ],
    },
    { name: "test", description: "Run tests" },
    { name: "fmt", description: "Format source files" },
    { name: "lint", description: "Lint source files" },
    { name: "task", description: "Run a config task" },
    { name: "check", description: "Type-check" },
    { name: "compile", description: "Compile to a binary" },
    { name: "install", description: "Install dependencies or a script" },
    { name: "add", description: "Add dependencies" },
    { name: "repl", description: "Start the REPL" },
  ],
}

export const bunSpec: CliSpec = {
  name: "bun",
  description: "Bun runtime and toolkit",
  subcommands: [
    {
      name: "run",
      description: "Run a script or file",
      options: [
        { name: "--watch", description: "Restart on change" },
        { name: "--hot", description: "Hot reload" },
      ],
    },
    { name: "test", description: "Run tests" },
    {
      name: "install",
      aliases: ["i"],
      description: "Install dependencies",
      options: [{ name: "--frozen-lockfile", description: "Fail on lockfile drift" }],
    },
    {
      name: "add",
      description: "Add a dependency",
      options: [{ name: "--dev", aliases: ["-d"], description: "Save to devDependencies" }],
    },
    { name: "remove", aliases: ["rm"], description: "Remove a dependency" },
    { name: "update", description: "Update dependencies" },
    { name: "build", description: "Bundle for production" },
    { name: "init", description: "Scaffold a project" },
    { name: "x", description: "Run a package binary" },
  ],
}

export const goSpec: CliSpec = {
  name: "go",
  description: "Go toolchain",
  subcommands: [
    {
      name: "build",
      description: "Compile packages",
      options: [
        { name: "-o", description: "Output file", takesValue: true },
        { name: "-race", description: "Enable the race detector" },
      ],
    },
    { name: "run", description: "Compile and run" },
    {
      name: "test",
      description: "Run tests",
      options: [
        { name: "-v", description: "Verbose output" },
        { name: "-run", description: "Filter test names", takesValue: true },
        { name: "-count", description: "Run N times (1 disables cache)", takesValue: true },
        { name: "-cover", description: "Coverage analysis" },
      ],
    },
    {
      name: "mod",
      description: "Module maintenance",
      subcommands: [
        { name: "tidy", description: "Prune and add requirements" },
        { name: "download", description: "Download modules" },
        { name: "init", description: "Initialize a module" },
        { name: "vendor", description: "Vendor dependencies" },
      ],
    },
    { name: "get", description: "Add or update a dependency" },
    { name: "fmt", description: "Format packages" },
    { name: "vet", description: "Report likely mistakes" },
    { name: "install", description: "Compile and install" },
    { name: "generate", description: "Run //go:generate directives" },
    { name: "version", description: "Show version" },
    { name: "env", description: "Show Go environment" },
    {
      name: "work",
      description: "Workspace maintenance",
      subcommands: [
        { name: "init", description: "Initialize a workspace" },
        { name: "use", description: "Add a module dir" },
        { name: "sync", description: "Sync workspace deps" },
      ],
    },
  ],
}
