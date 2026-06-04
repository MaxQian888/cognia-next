import type { CliSpec } from "../types"

export const ghSpec: CliSpec = {
  name: "gh",
  description: "GitHub CLI",
  subcommands: [
    {
      name: "pr",
      description: "Pull requests",
      subcommands: [
        {
          name: "create",
          description: "Create a PR",
          options: [
            { name: "--title", aliases: ["-t"], description: "PR title", takesValue: true },
            { name: "--body", aliases: ["-b"], description: "PR body", takesValue: true },
            { name: "--draft", aliases: ["-d"], description: "Create as draft" },
            { name: "--fill", aliases: ["-f"], description: "Fill from commits" },
            { name: "--web", aliases: ["-w"], description: "Open in browser" },
          ],
        },
        { name: "list", description: "List PRs" },
        {
          name: "view",
          description: "View a PR",
          options: [{ name: "--web", aliases: ["-w"], description: "Open in browser" }],
        },
        { name: "checkout", description: "Check out a PR branch" },
        {
          name: "merge",
          description: "Merge a PR",
          options: [
            { name: "--squash", aliases: ["-s"], description: "Squash merge" },
            { name: "--rebase", aliases: ["-r"], description: "Rebase merge" },
            { name: "--delete-branch", aliases: ["-d"], description: "Delete branch after" },
          ],
        },
        { name: "checks", description: "Show CI status" },
        { name: "diff", description: "View PR changes" },
        {
          name: "review",
          description: "Review a PR",
          options: [
            { name: "--approve", aliases: ["-a"], description: "Approve" },
            { name: "--request-changes", aliases: ["-r"], description: "Request changes" },
            { name: "--comment", aliases: ["-c"], description: "Comment only" },
          ],
        },
        { name: "status", description: "Your PR status" },
      ],
    },
    {
      name: "issue",
      description: "Issues",
      subcommands: [
        {
          name: "create",
          description: "Create an issue",
          options: [
            { name: "--title", aliases: ["-t"], description: "Issue title", takesValue: true },
            { name: "--body", aliases: ["-b"], description: "Issue body", takesValue: true },
            { name: "--label", aliases: ["-l"], description: "Add a label", takesValue: true },
          ],
        },
        { name: "list", description: "List issues" },
        { name: "view", description: "View an issue" },
        { name: "close", description: "Close an issue" },
        { name: "comment", description: "Comment on an issue" },
      ],
    },
    {
      name: "repo",
      description: "Repositories",
      subcommands: [
        { name: "clone", description: "Clone a repo" },
        { name: "create", description: "Create a repo" },
        { name: "fork", description: "Fork a repo" },
        { name: "view", description: "View a repo" },
        { name: "list", description: "List your repos" },
      ],
    },
    {
      name: "run",
      description: "Workflow runs",
      subcommands: [
        { name: "list", description: "List runs" },
        {
          name: "view",
          description: "View a run",
          options: [
            { name: "--log", description: "Show the full log" },
            { name: "--web", aliases: ["-w"], description: "Open in browser" },
          ],
        },
        { name: "watch", description: "Watch a run" },
        { name: "rerun", description: "Re-run a run" },
      ],
    },
    {
      name: "workflow",
      description: "Workflows",
      subcommands: [
        { name: "list", description: "List workflows" },
        { name: "run", description: "Dispatch a workflow" },
        { name: "view", description: "View a workflow" },
      ],
    },
    {
      name: "release",
      description: "Releases",
      subcommands: [
        { name: "create", description: "Create a release" },
        { name: "list", description: "List releases" },
        { name: "view", description: "View a release" },
        { name: "upload", description: "Upload assets" },
      ],
    },
    {
      name: "auth",
      description: "Authentication",
      subcommands: [
        { name: "login", description: "Log in" },
        { name: "logout", description: "Log out" },
        { name: "status", description: "Auth status" },
      ],
    },
    { name: "api", description: "Call the GitHub API" },
    {
      name: "gist",
      description: "Gists",
      subcommands: [
        { name: "create", description: "Create a gist" },
        { name: "list", description: "List gists" },
      ],
    },
  ],
}

export const pipSpec: CliSpec = {
  name: "pip",
  description: "Python package installer",
  subcommands: [
    {
      name: "install",
      description: "Install packages",
      options: [
        { name: "--upgrade", aliases: ["-U"], description: "Upgrade to newest" },
        {
          name: "--requirement",
          aliases: ["-r"],
          description: "Requirements file",
          takesValue: true,
        },
        { name: "--editable", aliases: ["-e"], description: "Editable install", takesValue: true },
        { name: "--user", description: "Install to the user site" },
      ],
    },
    {
      name: "uninstall",
      description: "Uninstall packages",
      options: [{ name: "--yes", aliases: ["-y"], description: "Skip confirmation" }],
    },
    {
      name: "list",
      description: "List installed packages",
      options: [{ name: "--outdated", aliases: ["-o"], description: "Only outdated" }],
    },
    { name: "show", description: "Show package info" },
    { name: "freeze", description: "Requirements-format output" },
    { name: "download", description: "Download packages" },
    { name: "check", description: "Verify dependencies" },
  ],
}

export const makeSpec: CliSpec = {
  name: "make",
  description: "GNU make",
  options: [
    { name: "--jobs", aliases: ["-j"], description: "Parallel jobs", takesValue: true },
    { name: "--file", aliases: ["-f"], description: "Makefile path", takesValue: true },
    {
      name: "--directory",
      aliases: ["-C"],
      description: "Change directory first",
      takesValue: true,
    },
    { name: "--dry-run", aliases: ["-n"], description: "Print without executing" },
    { name: "--keep-going", aliases: ["-k"], description: "Continue after errors" },
    { name: "--silent", aliases: ["-s"], description: "Don't echo commands" },
  ],
}

export const brewSpec: CliSpec = {
  name: "brew",
  description: "Homebrew package manager",
  subcommands: [
    {
      name: "install",
      description: "Install a formula or cask",
      options: [{ name: "--cask", description: "Install a cask" }],
    },
    { name: "uninstall", aliases: ["remove", "rm"], description: "Uninstall" },
    { name: "upgrade", description: "Upgrade outdated packages" },
    { name: "update", description: "Update Homebrew itself" },
    { name: "list", aliases: ["ls"], description: "List installed" },
    { name: "search", description: "Search formulae and casks" },
    { name: "info", description: "Show package info" },
    {
      name: "services",
      description: "Manage background services",
      subcommands: [
        { name: "list", description: "List services" },
        { name: "start", description: "Start a service" },
        { name: "stop", description: "Stop a service" },
        { name: "restart", description: "Restart a service" },
      ],
    },
    { name: "doctor", description: "Diagnose problems" },
    { name: "cleanup", description: "Remove stale files" },
    { name: "tap", description: "Add a tap" },
    { name: "outdated", description: "List outdated packages" },
  ],
}
