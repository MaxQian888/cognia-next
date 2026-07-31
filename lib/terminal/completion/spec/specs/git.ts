import type { CliSpec } from "../types"

export const gitSpec: CliSpec = {
  name: "git",
  description: "Distributed version control",
  options: [
    { name: "--help", description: "Show help" },
    { name: "--version", description: "Show version" },
    { name: "-C", description: "Run as if started in the given path", takesValue: true },
  ],
  subcommands: [
    {
      name: "add",
      description: "Stage file contents",
      options: [
        { name: "--all", aliases: ["-A"], description: "Stage all changes" },
        { name: "--patch", aliases: ["-p"], description: "Interactively choose hunks" },
        { name: "--update", aliases: ["-u"], description: "Stage tracked files only" },
      ],
    },
    {
      name: "branch",
      description: "List, create, or delete branches",
      options: [
        { name: "--all", aliases: ["-a"], description: "List remote-tracking too" },
        { name: "--delete", aliases: ["-d"], description: "Delete a branch" },
        { name: "--move", aliases: ["-m"], description: "Rename a branch" },
        { name: "--show-current", description: "Print the current branch" },
      ],
    },
    {
      name: "checkout",
      aliases: ["co"],
      description: "Switch branches or restore files",
      options: [
        { name: "-b", description: "Create and switch to a new branch", takesValue: true },
        { name: "--track", aliases: ["-t"], description: "Set upstream" },
      ],
    },
    {
      name: "cherry-pick",
      description: "Apply existing commits",
      options: [
        { name: "--continue", description: "Resume after resolving conflicts" },
        { name: "--abort", description: "Cancel the operation" },
        { name: "--no-commit", aliases: ["-n"], description: "Apply without committing" },
      ],
    },
    {
      name: "clone",
      description: "Clone a repository",
      options: [
        { name: "--depth", description: "Shallow clone depth", takesValue: true },
        {
          name: "--branch",
          aliases: ["-b"],
          description: "Checkout this branch",
          takesValue: true,
        },
        { name: "--recurse-submodules", description: "Init submodules" },
      ],
    },
    {
      name: "commit",
      description: "Record changes",
      options: [
        { name: "--message", aliases: ["-m"], description: "Commit message", takesValue: true },
        { name: "--amend", description: "Amend the previous commit" },
        { name: "--all", aliases: ["-a"], description: "Stage modified/deleted first" },
        { name: "--no-verify", description: "Skip hooks" },
        { name: "--fixup", description: "Create a fixup! commit", takesValue: true },
      ],
    },
    {
      name: "diff",
      description: "Show changes",
      options: [
        { name: "--staged", aliases: ["--cached"], description: "Diff staged changes" },
        { name: "--stat", description: "Show a diffstat" },
        { name: "--name-only", description: "Show only file names" },
      ],
    },
    {
      name: "fetch",
      description: "Download refs from a remote",
      options: [
        { name: "--all", description: "Fetch all remotes" },
        { name: "--prune", aliases: ["-p"], description: "Drop deleted remote refs" },
        { name: "--tags", description: "Fetch all tags" },
      ],
    },
    {
      name: "log",
      description: "Show commit history",
      options: [
        { name: "--oneline", description: "One line per commit" },
        { name: "--graph", description: "ASCII commit graph" },
        { name: "--stat", description: "Per-commit diffstat" },
        { name: "--max-count", aliases: ["-n"], description: "Limit commits", takesValue: true },
      ],
    },
    {
      name: "merge",
      description: "Join development histories",
      options: [
        { name: "--no-ff", description: "Always create a merge commit" },
        { name: "--squash", description: "Squash without merge commit" },
        { name: "--abort", description: "Abort the merge" },
        { name: "--continue", description: "Continue after conflicts" },
      ],
    },
    {
      name: "pull",
      description: "Fetch and integrate",
      options: [
        { name: "--rebase", description: "Rebase instead of merge" },
        { name: "--ff-only", description: "Fast-forward only" },
      ],
    },
    {
      name: "push",
      description: "Update remote refs",
      options: [
        { name: "--force-with-lease", description: "Force push, safely" },
        { name: "--set-upstream", aliases: ["-u"], description: "Set upstream" },
        { name: "--tags", description: "Push tags" },
        { name: "--delete", aliases: ["-d"], description: "Delete a remote ref" },
      ],
    },
    {
      name: "rebase",
      description: "Reapply commits on top of another base",
      options: [
        { name: "--interactive", aliases: ["-i"], description: "Interactive rebase" },
        { name: "--continue", description: "Continue after conflicts" },
        { name: "--abort", description: "Abort the rebase" },
        { name: "--onto", description: "Rebase onto the given ref", takesValue: true },
      ],
    },
    {
      name: "remote",
      description: "Manage remotes",
      subcommands: [
        { name: "add", description: "Add a remote" },
        { name: "remove", aliases: ["rm"], description: "Remove a remote" },
        { name: "rename", description: "Rename a remote" },
        { name: "set-url", description: "Change a remote URL" },
        { name: "show", description: "Show remote details" },
        { name: "prune", description: "Prune stale refs" },
      ],
      options: [{ name: "--verbose", aliases: ["-v"], description: "Show URLs" }],
    },
    {
      name: "reset",
      description: "Reset HEAD to a state",
      options: [
        { name: "--hard", description: "Discard working tree changes" },
        { name: "--soft", description: "Keep index and working tree" },
        { name: "--mixed", description: "Keep working tree (default)" },
      ],
    },
    {
      name: "restore",
      description: "Restore working-tree files",
      options: [
        { name: "--staged", description: "Unstage instead" },
        { name: "--source", description: "Restore from this ref", takesValue: true },
      ],
    },
    {
      name: "stash",
      description: "Stash changes away",
      subcommands: [
        { name: "push", description: "Save a new stash" },
        { name: "pop", description: "Apply and drop the latest stash" },
        { name: "apply", description: "Apply without dropping" },
        { name: "list", description: "List stashes" },
        { name: "drop", description: "Delete a stash" },
        { name: "show", description: "Show stash contents" },
      ],
    },
    {
      name: "status",
      description: "Working-tree status",
      options: [
        { name: "--short", aliases: ["-s"], description: "Short format" },
        { name: "--branch", aliases: ["-b"], description: "Show branch info" },
      ],
    },
    {
      name: "switch",
      description: "Switch branches",
      options: [
        { name: "--create", aliases: ["-c"], description: "Create and switch", takesValue: true },
        { name: "--detach", description: "Detach HEAD" },
      ],
    },
    {
      name: "tag",
      description: "Create, list, or delete tags",
      options: [
        { name: "--annotate", aliases: ["-a"], description: "Annotated tag" },
        { name: "--delete", aliases: ["-d"], description: "Delete a tag" },
        { name: "--list", aliases: ["-l"], description: "List tags" },
        { name: "--message", aliases: ["-m"], description: "Tag message", takesValue: true },
      ],
    },
    {
      name: "worktree",
      description: "Manage worktrees",
      subcommands: [
        { name: "add", description: "Create a worktree" },
        { name: "list", description: "List worktrees" },
        { name: "remove", description: "Remove a worktree" },
        { name: "prune", description: "Prune stale worktrees" },
      ],
    },
  ],
}
