// Session-scoped structured task graph behind the TaskCreate / TaskGet /
// TaskList / TaskUpdate tools (`src/tools/builtin/core-files/tasks.ts`).
//
// Tasks carry stable ids, reciprocal dependency edges (`blocks` /
// `blockedBy`), an owner and metadata. One store is created per Agent session
// and survives the tool map being rebuilt between turns.

export type TaskStatus = "pending" | "in_progress" | "completed"

export interface SessionTask {
  id: string
  subject: string
  description: string
  status: TaskStatus
  /** Ids of the tasks this one blocks. */
  blocks: string[]
  /** Ids of the tasks that must complete before this one can. */
  blockedBy: string[]
  createdAt: number
  updatedAt: number
  activeForm?: string
  owner?: string
  metadata?: Record<string, unknown>
}

export interface TaskCreateInput {
  subject: string
  description: string
  activeForm?: string | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface TaskUpdateInput {
  taskId: string
  /** `"deleted"` removes the task and its edges. */
  status?: TaskStatus | "deleted" | undefined
  subject?: string | undefined
  description?: string | undefined
  /** `null` clears it. */
  activeForm?: string | null | undefined
  addBlocks?: string[] | undefined
  removeBlocks?: string[] | undefined
  addBlockedBy?: string[] | undefined
  removeBlockedBy?: string[] | undefined
  /** `null` clears it. */
  owner?: string | null | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface DeletedTask {
  id: string
  deleted: true
}

export interface SessionTaskStore {
  create(input: TaskCreateInput): SessionTask
  get(taskId: string): SessionTask | undefined
  list(): SessionTask[]
  update(input: TaskUpdateInput): SessionTask | DeletedTask
}

function cloneTask(task: SessionTask): SessionTask {
  return {
    ...task,
    blocks: [...task.blocks],
    blockedBy: [...task.blockedBy],
    ...(task.metadata ? { metadata: { ...task.metadata } } : {}),
  }
}

function unique(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])]
}

/** Create an isolated task graph for one Agent session. */
export function createSessionTaskStore({
  now = Date.now,
}: { now?: () => number } = {}): SessionTaskStore {
  const tasks = new Map<string, SessionTask>()
  let nextId = 1

  function requireTask(taskId: string): SessionTask {
    const task = tasks.get(String(taskId))
    if (!task) throw new Error(`task ${taskId} not found`)
    return task
  }

  function reaches(graph: Map<string, Set<string>>, startId: string, targetId: string): boolean {
    const queue = [String(startId)]
    const seen = new Set<string>()
    while (queue.length > 0) {
      const id = queue.shift()!
      if (id === String(targetId)) return true
      if (seen.has(id)) continue
      seen.add(id)
      queue.push(...(graph.get(id) ?? []))
    }
    return false
  }

  function validateProjectedEdges(
    task: SessionTask,
    input: TaskUpdateInput,
    addBlocks: string[],
    addBlockedBy: string[]
  ): void {
    const graph = new Map([...tasks.values()].map((entry) => [entry.id, new Set(entry.blocks)]))
    for (const blockedId of unique(input.removeBlocks)) graph.get(task.id)?.delete(blockedId)
    for (const blockerId of unique(input.removeBlockedBy)) graph.get(blockerId)?.delete(task.id)

    const additions: [string, string][] = [
      ...addBlocks.map((blockedId): [string, string] => [task.id, blockedId]),
      ...addBlockedBy.map((blockerId): [string, string] => [blockerId, task.id]),
    ]
    for (const [blockerId, blockedId] of additions) {
      const blocker = requireTask(blockerId)
      const blocked = requireTask(blockedId)
      if (blocker.id === blocked.id) throw new Error(`task ${blocker.id} cannot depend on itself`)
      if (reaches(graph, blocked.id, blocker.id)) {
        throw new Error(`dependency cycle: task ${blocker.id} cannot block task ${blocked.id}`)
      }
      graph.get(blocker.id)!.add(blocked.id)
    }
  }

  function create({ subject, description, activeForm, metadata }: TaskCreateInput): SessionTask {
    const id = String(nextId++)
    const timestamp = now()
    const task: SessionTask = {
      id,
      subject,
      description,
      status: "pending",
      blocks: [],
      blockedBy: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(activeForm ? { activeForm } : {}),
      ...(metadata ? { metadata: { ...metadata } } : {}),
    }
    tasks.set(id, task)
    return cloneTask(task)
  }

  function get(taskId: string): SessionTask | undefined {
    const task = tasks.get(String(taskId))
    return task ? cloneTask(task) : undefined
  }

  function list(): SessionTask[] {
    return [...tasks.values()].map(cloneTask)
  }

  function removeEdge(blockerId: string, blockedId: string, timestamp: number): void {
    const blocker = tasks.get(String(blockerId))
    const blocked = tasks.get(String(blockedId))
    if (blocker) {
      blocker.blocks = blocker.blocks.filter((id) => id !== String(blockedId))
      blocker.updatedAt = timestamp
    }
    if (blocked) {
      blocked.blockedBy = blocked.blockedBy.filter((id) => id !== String(blockerId))
      blocked.updatedAt = timestamp
    }
  }

  function addEdge(blockerId: string, blockedId: string, timestamp: number): void {
    const blocker = requireTask(blockerId)
    const blocked = requireTask(blockedId)
    if (!blocker.blocks.includes(blocked.id)) blocker.blocks.push(blocked.id)
    if (!blocked.blockedBy.includes(blocker.id)) blocked.blockedBy.push(blocker.id)
    blocker.updatedAt = timestamp
    blocked.updatedAt = timestamp
  }

  function remove(task: SessionTask): DeletedTask {
    const timestamp = now()
    for (const blockedId of [...task.blocks]) removeEdge(task.id, blockedId, timestamp)
    for (const blockerId of [...task.blockedBy]) removeEdge(blockerId, task.id, timestamp)
    tasks.delete(task.id)
    return { id: task.id, deleted: true }
  }

  function update(input: TaskUpdateInput): SessionTask | DeletedTask {
    const task = requireTask(input.taskId)
    if (input.status === "deleted") return remove(task)

    const addBlocks = unique(input.addBlocks)
    const addBlockedBy = unique(input.addBlockedBy)
    // Validate the entire mutation before changing any edge, so a bad final id
    // cannot leave a half-applied dependency graph.
    validateProjectedEdges(task, input, addBlocks, addBlockedBy)

    if (input.status === "completed") {
      const incomplete = task.blockedBy.filter((id) => tasks.get(id)?.status !== "completed")
      if (incomplete.length > 0) {
        throw new Error(`task ${task.id} is still blocked by task ${incomplete.join(", ")}`)
      }
    }

    const timestamp = now()
    for (const blockedId of unique(input.removeBlocks)) removeEdge(task.id, blockedId, timestamp)
    for (const blockerId of unique(input.removeBlockedBy)) {
      removeEdge(blockerId, task.id, timestamp)
    }
    for (const blockedId of addBlocks) addEdge(task.id, blockedId, timestamp)
    for (const blockerId of addBlockedBy) addEdge(blockerId, task.id, timestamp)

    if (input.status) task.status = input.status
    if (input.subject !== undefined) task.subject = input.subject
    if (input.description !== undefined) task.description = input.description
    if (input.activeForm !== undefined) {
      if (input.activeForm === null) delete task.activeForm
      else task.activeForm = input.activeForm
    }
    if (input.owner !== undefined) {
      if (input.owner === null) delete task.owner
      else task.owner = input.owner
    }
    if (input.metadata !== undefined) task.metadata = { ...input.metadata }
    task.updatedAt = timestamp
    return cloneTask(task)
  }

  return { create, get, list, update }
}
