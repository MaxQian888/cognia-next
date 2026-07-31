import type { CliSpec, CliSubcommand } from "../types"

/** Subcommands npm / pnpm / yarn share (script running + dep management). */
const SHARED_PM_SUBCOMMANDS: CliSubcommand[] = [
  {
    name: "install",
    aliases: ["i"],
    description: "Install dependencies",
    options: [
      { name: "--save-dev", aliases: ["-D"], description: "Save to devDependencies" },
      { name: "--global", aliases: ["-g"], description: "Install globally" },
      { name: "--frozen-lockfile", description: "Fail on lockfile drift" },
    ],
  },
  { name: "run", description: "Run a package script" },
  { name: "test", aliases: ["t"], description: "Run the test script" },
  { name: "init", description: "Create a package.json" },
  { name: "publish", description: "Publish the package" },
  { name: "outdated", description: "List outdated dependencies" },
  { name: "audit", description: "Check for vulnerable dependencies" },
  { name: "link", description: "Symlink a package" },
]

export const npmSpec: CliSpec = {
  name: "npm",
  description: "Node package manager",
  options: [{ name: "--version", aliases: ["-v"], description: "Show version" }],
  subcommands: [
    ...SHARED_PM_SUBCOMMANDS,
    { name: "ci", description: "Clean install from lockfile" },
    {
      name: "uninstall",
      aliases: ["rm", "remove"],
      description: "Remove a dependency",
      options: [{ name: "--save-dev", aliases: ["-D"], description: "From devDependencies" }],
    },
    { name: "update", description: "Update dependencies" },
    { name: "exec", description: "Run a command from a package" },
    { name: "ls", aliases: ["list"], description: "List installed packages" },
    { name: "view", description: "Show registry info" },
    { name: "pack", description: "Create a tarball" },
    { name: "login", description: "Log in to the registry" },
    { name: "whoami", description: "Show the logged-in user" },
  ],
}

export const pnpmSpec: CliSpec = {
  name: "pnpm",
  description: "Fast, disk-efficient package manager",
  options: [
    {
      name: "--filter",
      aliases: ["-F"],
      description: "Limit to workspace packages",
      takesValue: true,
    },
    { name: "--recursive", aliases: ["-r"], description: "Run in every workspace package" },
  ],
  subcommands: [
    ...SHARED_PM_SUBCOMMANDS,
    {
      name: "add",
      description: "Add a dependency",
      options: [
        { name: "--save-dev", aliases: ["-D"], description: "Save to devDependencies" },
        { name: "--global", aliases: ["-g"], description: "Install globally" },
        { name: "--workspace", description: "Link from the workspace" },
      ],
    },
    { name: "remove", aliases: ["rm"], description: "Remove a dependency" },
    { name: "update", aliases: ["up"], description: "Update dependencies" },
    { name: "dlx", description: "Run a package without installing" },
    { name: "exec", description: "Run a shell command in the project scope" },
    { name: "list", aliases: ["ls"], description: "List installed packages" },
    { name: "why", description: "Explain why a package is installed" },
    {
      name: "store",
      description: "Manage the content-addressable store",
      subcommands: [
        { name: "status", description: "Check store integrity" },
        { name: "prune", description: "Remove orphaned packages" },
      ],
    },
  ],
}

export const yarnSpec: CliSpec = {
  name: "yarn",
  description: "Yarn package manager",
  options: [{ name: "--version", aliases: ["-v"], description: "Show version" }],
  subcommands: [
    ...SHARED_PM_SUBCOMMANDS,
    {
      name: "add",
      description: "Add a dependency",
      options: [{ name: "--dev", aliases: ["-D"], description: "Save to devDependencies" }],
    },
    { name: "remove", description: "Remove a dependency" },
    { name: "up", description: "Upgrade dependencies" },
    { name: "dlx", description: "Run a package without installing" },
    {
      name: "workspaces",
      description: "Workspace utilities",
      subcommands: [
        { name: "list", description: "List workspaces" },
        { name: "foreach", description: "Run a command in every workspace" },
      ],
    },
    { name: "why", description: "Explain why a package is installed" },
  ],
}
