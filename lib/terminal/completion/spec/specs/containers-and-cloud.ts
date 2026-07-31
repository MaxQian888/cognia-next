import type { CliSpec } from "../types"

export const dockerSpec: CliSpec = {
  name: "docker",
  description: "Container platform CLI",
  subcommands: [
    {
      name: "build",
      description: "Build an image",
      options: [
        { name: "--tag", aliases: ["-t"], description: "Name:tag for the image", takesValue: true },
        { name: "--file", aliases: ["-f"], description: "Dockerfile path", takesValue: true },
        { name: "--no-cache", description: "Disable layer cache" },
        { name: "--platform", description: "Target platform", takesValue: true },
      ],
    },
    {
      name: "run",
      description: "Run a container",
      options: [
        { name: "--detach", aliases: ["-d"], description: "Run in background" },
        { name: "--interactive", aliases: ["-i"], description: "Keep stdin open" },
        { name: "--tty", aliases: ["-t"], description: "Allocate a TTY" },
        { name: "--rm", description: "Remove on exit" },
        { name: "--publish", aliases: ["-p"], description: "Publish a port", takesValue: true },
        { name: "--volume", aliases: ["-v"], description: "Bind mount", takesValue: true },
        { name: "--env", aliases: ["-e"], description: "Set env var", takesValue: true },
        { name: "--name", description: "Container name", takesValue: true },
      ],
    },
    {
      name: "ps",
      description: "List containers",
      options: [
        { name: "--all", aliases: ["-a"], description: "Include stopped" },
        { name: "--quiet", aliases: ["-q"], description: "IDs only" },
      ],
    },
    { name: "images", description: "List images" },
    {
      name: "exec",
      description: "Run a command in a container",
      options: [
        { name: "--interactive", aliases: ["-i"], description: "Keep stdin open" },
        { name: "--tty", aliases: ["-t"], description: "Allocate a TTY" },
      ],
    },
    {
      name: "logs",
      description: "Container logs",
      options: [
        { name: "--follow", aliases: ["-f"], description: "Stream output" },
        { name: "--tail", description: "Last N lines", takesValue: true },
      ],
    },
    { name: "stop", description: "Stop containers" },
    { name: "start", description: "Start containers" },
    { name: "restart", description: "Restart containers" },
    { name: "rm", description: "Remove containers" },
    { name: "rmi", description: "Remove images" },
    { name: "pull", description: "Pull an image" },
    { name: "push", description: "Push an image" },
    {
      name: "compose",
      description: "Multi-container apps",
      subcommands: [
        {
          name: "up",
          description: "Create and start",
          options: [
            { name: "--detach", aliases: ["-d"], description: "Run in background" },
            { name: "--build", description: "Build before starting" },
          ],
        },
        {
          name: "down",
          description: "Stop and remove",
          options: [{ name: "--volumes", aliases: ["-v"], description: "Also remove volumes" }],
        },
        { name: "logs", description: "Service logs" },
        { name: "ps", description: "List services" },
        { name: "build", description: "Build services" },
        { name: "restart", description: "Restart services" },
      ],
    },
    {
      name: "system",
      description: "Manage Docker",
      subcommands: [
        { name: "prune", description: "Remove unused data" },
        { name: "df", description: "Disk usage" },
      ],
    },
    { name: "inspect", description: "Low-level object info" },
    {
      name: "network",
      description: "Manage networks",
      subcommands: [
        { name: "ls", description: "List networks" },
        { name: "create", description: "Create a network" },
        { name: "rm", description: "Remove networks" },
      ],
    },
    {
      name: "volume",
      description: "Manage volumes",
      subcommands: [
        { name: "ls", description: "List volumes" },
        { name: "create", description: "Create a volume" },
        { name: "rm", description: "Remove volumes" },
        { name: "prune", description: "Remove unused volumes" },
      ],
    },
  ],
}

export const kubectlSpec: CliSpec = {
  name: "kubectl",
  description: "Kubernetes CLI",
  options: [
    { name: "--namespace", aliases: ["-n"], description: "Target namespace", takesValue: true },
    { name: "--context", description: "Kubeconfig context", takesValue: true },
    { name: "--output", aliases: ["-o"], description: "Output format", takesValue: true },
  ],
  subcommands: [
    {
      name: "get",
      description: "Display resources",
      subcommands: [
        { name: "pods", aliases: ["pod", "po"], description: "Pods" },
        { name: "services", aliases: ["service", "svc"], description: "Services" },
        { name: "deployments", aliases: ["deployment", "deploy"], description: "Deployments" },
        { name: "nodes", aliases: ["node", "no"], description: "Nodes" },
        { name: "namespaces", aliases: ["namespace", "ns"], description: "Namespaces" },
        { name: "configmaps", aliases: ["configmap", "cm"], description: "ConfigMaps" },
        { name: "secrets", aliases: ["secret"], description: "Secrets" },
        { name: "ingress", aliases: ["ing"], description: "Ingresses" },
        { name: "events", aliases: ["ev"], description: "Events" },
      ],
      options: [
        { name: "--watch", aliases: ["-w"], description: "Watch for changes" },
        { name: "--all-namespaces", aliases: ["-A"], description: "Across namespaces" },
        { name: "--selector", aliases: ["-l"], description: "Label selector", takesValue: true },
      ],
    },
    { name: "describe", description: "Detailed resource info" },
    {
      name: "apply",
      description: "Apply a configuration",
      options: [
        { name: "--filename", aliases: ["-f"], description: "Manifest file", takesValue: true },
        {
          name: "--kustomize",
          aliases: ["-k"],
          description: "Kustomization dir",
          takesValue: true,
        },
      ],
    },
    {
      name: "delete",
      description: "Delete resources",
      options: [
        { name: "--filename", aliases: ["-f"], description: "Manifest file", takesValue: true },
      ],
    },
    {
      name: "logs",
      description: "Container logs",
      options: [
        { name: "--follow", aliases: ["-f"], description: "Stream output" },
        { name: "--previous", aliases: ["-p"], description: "Previous instance" },
        { name: "--container", aliases: ["-c"], description: "Container name", takesValue: true },
      ],
    },
    {
      name: "exec",
      description: "Execute in a container",
      options: [
        { name: "--stdin", aliases: ["-i"], description: "Keep stdin open" },
        { name: "--tty", aliases: ["-t"], description: "Allocate a TTY" },
      ],
    },
    {
      name: "rollout",
      description: "Manage rollouts",
      subcommands: [
        { name: "status", description: "Rollout status" },
        { name: "restart", description: "Restart a rollout" },
        { name: "undo", description: "Roll back" },
        { name: "history", description: "Rollout history" },
      ],
    },
    {
      name: "scale",
      description: "Scale a resource",
      options: [{ name: "--replicas", description: "Replica count", takesValue: true }],
    },
    { name: "port-forward", description: "Forward local ports" },
    {
      name: "config",
      description: "Kubeconfig maintenance",
      subcommands: [
        { name: "get-contexts", description: "List contexts" },
        { name: "use-context", description: "Switch context" },
        { name: "current-context", description: "Show current context" },
      ],
    },
    {
      name: "top",
      description: "Resource usage",
      subcommands: [
        { name: "pods", description: "Pod usage" },
        { name: "nodes", description: "Node usage" },
      ],
    },
  ],
}

export const terraformSpec: CliSpec = {
  name: "terraform",
  description: "Infrastructure as code",
  subcommands: [
    {
      name: "init",
      description: "Initialize a working directory",
      options: [
        { name: "-upgrade", description: "Upgrade providers/modules" },
        { name: "-reconfigure", description: "Reconfigure the backend" },
      ],
    },
    {
      name: "plan",
      description: "Show the execution plan",
      options: [
        { name: "-out", description: "Save the plan to a file", takesValue: true },
        { name: "-var-file", description: "Variables file", takesValue: true },
        { name: "-destroy", description: "Plan a destroy" },
      ],
    },
    {
      name: "apply",
      description: "Apply changes",
      options: [
        { name: "-auto-approve", description: "Skip interactive approval" },
        { name: "-var-file", description: "Variables file", takesValue: true },
      ],
    },
    {
      name: "destroy",
      description: "Destroy managed infrastructure",
      options: [{ name: "-auto-approve", description: "Skip interactive approval" }],
    },
    { name: "validate", description: "Validate the configuration" },
    {
      name: "fmt",
      description: "Format configuration files",
      options: [
        { name: "-check", description: "Fail on diffs without writing" },
        { name: "-recursive", description: "Process subdirectories" },
      ],
    },
    {
      name: "state",
      description: "State management",
      subcommands: [
        { name: "list", description: "List resources" },
        { name: "show", description: "Show a resource" },
        { name: "mv", description: "Move a resource" },
        { name: "rm", description: "Forget a resource" },
        { name: "pull", description: "Download remote state" },
      ],
    },
    { name: "output", description: "Show output values" },
    {
      name: "workspace",
      description: "Workspace management",
      subcommands: [
        { name: "list", description: "List workspaces" },
        { name: "new", description: "Create a workspace" },
        { name: "select", description: "Switch workspace" },
        { name: "delete", description: "Delete a workspace" },
      ],
    },
    { name: "import", description: "Import existing infrastructure" },
    { name: "refresh", description: "Sync state with real resources" },
  ],
}
