# 定时任务子系统 — 缺陷修复与扩展点硬化计划

**日期**: 2026-07-16
**状态**: 待评审(未实施 —— 下文每一项都是已核实的缺陷或缺口,不是设想)
**范围**: 四波 —— W1 正确性缺陷(影响线上用户)、W2 幽灵代码清理、W3 扩展点硬化、W4 文档补位
**参考 ADR**: 0002(scheduler,主 ADR)、0011(workflows / `trigger.cron`)、0006/0016/0026(插件扩展点)、0067(crate 分解 → `cognia-scheduling`)、拟新增 **0073**(调度扩展点契约,见 W4.2)

---

## 0. 如何使用本文档

每个工作项自成单元:**问题 → 证据 → 修法 → 验收**。除非标注 **依赖**,否则彼此独立,一项一个 commit。

### 0.1 置信标签 —— 动手前先读这节

沿用 `2026-07-15-tui-audit-remediation.md` / `2026-07-16-otel-native-telemetry.md` 的约定。**标签不是装饰。**

| 标签            | 含义                                       | 你必须做什么                                   |
| --------------- | ------------------------------------------ | ---------------------------------------------- |
| **[CONFIRMED]** | 本文作者亲手 read/grep 核实,file:line 已对 | 可信,但行号会漂 —— **按符号重新定位,别按行号** |
| **[AGENT]**     | 由 subagent 提供证据,作者未独立复核        | **动手前先自行复核这条具体主张**               |
| **[OPEN]**      | 真正未决,需要人拍板                        | **不要默默替它做决定**,见 §6                   |

本文的调研由四个 subagent 完成(TS 核心 / Rust crate / 聚合层+UI / 插件),作者随后**只对 W1、W2 的承重主张做了一手复核**。W3 的触点计数、Rust trait 形状、`PluginSchedulerAPI` 沙箱结论**全部是 [AGENT]**。

### 0.2 证据标准(不可妥协)

**本次调研最贵的一课:subagent 之间会互相打架,而错的那个听起来一样自信。**

1. 第一个 agent 报告 `plugins/github-delivery/src/github-poll.ts` "每 `everyMs`(默认 5 分钟)轮询一次"。第四个 agent 查出**根本没有循环**,`runPluginPoll` 零调用者。**作者复核后确认第四个是对的** —— 第一个 agent 把源码里的**文档注释**当成了实现。
2. 作者自己第一次跑 `rg --include=*.ts` 时被 zsh 吞掉(`no matches found`),**"零调用者"一度是工具假象**。加引号重跑 + 阳性对照后才确认是真零。

**因此:凡本文出现「零 / 不存在 / 未使用 / 从不」的主张,均已跑阳性对照** —— 用同形状的命令搜一个已知存在的符号,确认工具在工作,再采信那个零。你复核时请照做:

```bash
# 阳性对照的正确写法(引号必须有)
rtk grep -rn "getTaskScheduler" lib --include="*.ts" -l   # 必须有命中,否则你的工具坏了
rtk grep -rn "<你要证伪的符号>" --include="*.ts" .        # 此时的零才可信
```

---

## 1. 研究结论(先读这节,它推翻了「本仓没有定时任务」的默认假设)

第一直觉是「要加定时任务功能」。**事实相反:本仓已有一个成熟的多层调度平台。**

- `lib/scheduler/` ≈ 19.7k LOC [AGENT];专用 Rust crate `crates/cognia-scheduling/` ≈ 4.3k LOC,含 macOS/Windows/Linux 三套 OS 原生后端 [AGENT]
- 四种触发:`cron | interval | once | event`;overlap 策略五种、jitter、`endAt`/`maxRuns`、重试、连续失败追踪、任务链 [AGENT]
- **13 个 executor 全部注册且 live**:`chat`/`agent`/`agent-team`/`skill`/`script`/`plugin`/`backup`/`external-agent`/`twin`/`wiki-rebuild`/`wiki-lint`/`radar-report`/`custom` [AGENT]
- 自然语言建任务、OS 级服务提升、workflow 反向操作调度器的 13 个 `action.scheduler.task.*` 节点 [AGENT]
- `/loop 5m` **不是**第二个引擎,是复用同一 scheduler 建的 `chat` 任务 [AGENT]

> **所以本计划不是「加调度功能」,而是「修好已建成的调度器,并把扩展点变得可用」。**
> 一句话总结:**引擎是好的;OS 提升层在静默说谎(W1.1);插件层的写路径绕过了引擎(W1.2);时区和方言在两侧对不上(W1.3/W1.4);还有一批建好没接线的幽灵(W2)。**

**为什么没人发现**:`scheduler` **不在 `CLAUDE.md` 的 Subsystem Map 里** [CONFIRMED] —— 表里 30 个子系统没有它,尽管它体量比大多数都大。按 Working Rule 1「先查文档再实现」反而查不到。见 W4.1。

---

## 2. 扩展性矩阵(本次调研的可复用产出)

**规律:第一方在树内扩很便宜;插件在树外扩基本封死。**

| 轴                      | 代价                 | 开放性                                                       | 置信    |
| ----------------------- | -------------------- | ------------------------------------------------------------ | ------- |
| **executor 类型**       | **3 文件**           | 开放 —— `Map<string, TaskExecutor>`,可延迟注册               | [AGENT] |
| **"触发类型"**          | **0 文件**           | 走 `event` 逃生口,`eventType` 是开放 `string`                | [AGENT] |
| **payload 形状**        | **0 文件**           | union 含 `Record<string, unknown>` ⇒ 什么都能塞,类型不设防   | [AGENT] |
| **timing driver**       | **1 行**             | 接口是干净的缝;只有 `task-scheduler.ts:181` 的三元写死了选择 | [AGENT] |
| **Rust 计时域**         | **0 处 crate 改动**  | 真泛型 `trait Alarm` + `trait DueEmitter<T>`                 | [AGENT] |
| **workflow 插件触发器** | **开放**             | `lib/workflow/triggers/registry.ts`,插件自带计时机器         | [AGENT] |
| 统一视图 kind           | 17 处(6 处静默)      | 编译期 + 运行期**双闭合**                                    | [AGENT] |
| OS 可提升触发器         | 20+ 处(约半数无保护) | 4 份手写 capability vec + 2 份 TS 列表会静默漂移             | [AGENT] |

### 2.1 两条最有用的结论(动手前必读)

**① 要加「新触发方式」,不要加 `TaskTriggerType`。** 闭合的那个 union(`SchedulerEventType`)只存在于一个便利包装上;真正的通路 `triggerEventTask(eventType: string, ...)` 是开放 string。写个 ticker 算出时机,调
`getTaskScheduler().triggerEventTask("solar:sunrise", src, data)` 即可,**零核心改动**。加真的第 5 种触发类型要动约 13 处,几乎必然是错的选择。[AGENT]

**② 插件的天花板是五个 No** [AGENT]:加触发类型 ✗、加 unified kind ✗、注册 driver ✗、OS 级提升 ✗(设计如此:handler 是活的 JS 闭包,合理)、app 关了跑 ✗。
**插件唯一的开放逃生口在 workflow 那边** —— `lib/workflow/triggers/registry.ts` 接受插件贡献的带前缀 trigger kind,并通过 `PluginTriggerStartContext`/`PluginTriggerHandle` 自带计时。
**记住:workflow 的触发器系统是开放的,scheduler 的触发器系统是封闭的。**

---

## 3. 工作项

### Wave 1 — 正确性缺陷(影响线上用户,优先)

---

#### W1.1 — macOS cron 翻译器静默丢字段,最高 15× 超额触发 **[CONFIRMED] / Blocker**

**问题**:被提升到 launchd 的任务会以远高于用户设定的频率触发,且系统报告"校验通过"。

**证据**(作者一手复核):

`crates/cognia-scheduling/src/scheduler/macos.rs:349-356`:

```rust
fn parse_cron_field(field: &str) -> Option<u32> {
    if field.starts_with("*/") { None }   // 步进 → None
    else { field.parse().ok() }           // "1-5".parse::<u32>() 失败 → 也是 None
}
```

`macos.rs:293-346` `cron_to_calendar_interval`:

- `:295` 只接受**恰好 5 字段**,否则 `return None`
- `:299` `let (minute, hour, day, _month, weekday)` —— **`_month` 直接丢弃**,launchd 的 `Month` 键从不产出
- `:305-342` 四个字段全是 `if let Some(val) { push }`,**没有 `else`** ⇒ 解析失败 = 静默省略该键

launchd 语义:**省略的键 = 通配符;空字典 = 每分钟触发**。后果:

| cron            | 用户意图    | 实际行为                                                            | 超额     |
| --------------- | ----------- | ------------------------------------------------------------------- | -------- |
| `*/15 * * * *`  | 每 15 分钟  | 空字典 → **每分钟**                                                 | **15×**  |
| `0 9 * * 1-5`   | 工作日 9 点 | Weekday 丢失 → **每天 9 点**                                        | 7/5×     |
| `0 9 1 1 *`     | 每年元旦    | Month 丢弃 → **每月 1 号**                                          | 12×      |
| `0 9 * * 1,3,5` | 一三五      | Weekday 丢失 → **每天**                                             | 7/3×     |
| 6 字段          | —           | `None` → `:126` `if let Some` 无 else → **plist 无触发键,永不触发** | 静默失效 |

**且校验层不接**:`validate_trigger_translation`(`macos.rs:860-877`)返回 **`valid: true`**,警告只在 `*/` 前缀时触发(`:865`)—— 范围、列表、丢掉的月份**零警告** [AGENT]。TS 侧 `lib/scheduler/promote-to-system.ts:101-137` `checkOsCronCompatibility` 拦的是宏、>5 字段、`L`/`#`,**恰好不拦 `*/N` 和范围** [AGENT]。整条链没人接得住。

**对照组**:Windows `cron_to_schtasks`(`windows.rs:128-211`)遇到映射不了的**硬报错** `Err(SchedulerError::InvalidCron)`,并正确处理 `*/N` → `/SC MINUTE /MO N`;Linux `expand_cron_field`(`linux.rs:247-255`)映射 `*/5` → `0/5`。**macOS 是唯一异类,且是唯一静默失败的。** [AGENT —— 请复核这两处再动手]

**修法** —— 见 §6 [OPEN-1],两条路线未定。最小正确版本:

1. `parse_cron_field` 改返回 `Result<Option<u32>, SchedulerError>`,区分"通配"与"无法表达"
2. `cron_to_calendar_interval` 返回 `Result<String, SchedulerError>`,遇到无法表达的字段**拒绝**而非省略(对齐 Windows 的姿态)
3. `_month` 接上 launchd `Month` 键
4. `validate_trigger_translation` 对齐:无法表达 ⇒ `valid: false` + 明确原因
5. TS 侧 `checkOsCronCompatibility` 补上 `*/N` 与范围/列表的预检,让用户在提升**之前**看到拒绝理由

**验收**:

- Rust 单测覆盖上表 5 行,每行断言"要么正确翻译,要么明确报错",**不允许静默省略**
- 新增 round-trip 测试:`cron → plist → parse_trigger_from_plist` 语义等价
- `cargo test --manifest-path src-tauri/Cargo.toml scheduler::macos` —— **读 tee 日志,别信 `$?`**(RTK 会掩盖 cargo 退出码)
- TS 侧 `promote-to-system.test.ts` 覆盖新预检
- 手动:在 macOS 上提升一个 `*/15 * * * *` 任务,`launchctl list | grep cognia`,确认 plist 含正确 `StartCalendarInterval` 或创建被拒

---

#### W1.2 — `ctx.scheduler` 的写操作绕过引擎,任务不上弦 **[CONFIRMED] / 高**

**问题**:插件通过 `ctx.scheduler.createTask()` 建的任务**本次会话永不触发**;`pauseTask` 后**照常触发**;`deleteTask` 后 driver 仍留着已上弦的条目。

**证据**(作者一手复核):

`lib/plugin/core/context.ts:1929` —— `import { schedulerDb } from "@/lib/scheduler/scheduler-db"`,**直接拿库,不走引擎**。

| `ctx.scheduler` 方法 | 实际行为                                                            | 真 `TaskScheduler` 的行为                                                  |
| -------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `createTask`         | `:1986` 裸 `schedulerDb.createTask(task)`                           | `task-scheduler.ts:644` 设 `nextRunAt` + `:652` `scheduleTask()`(**上弦**) |
| `pauseTask`          | `:2106` 裸 `schedulerDb.updateTask()`                               | 先 `unscheduleTask(taskId)` 再改状态 [AGENT]                               |
| `deleteTask`         | `:2043` 裸 `schedulerDb.deleteTask()`                               | 先 `unscheduleTask(taskId)` 再删 [AGENT]                                   |
| `runTaskNow`         | `:2149-2151` **动态 import `getTaskScheduler()` —— 唯一正确的一个** | —                                                                          |

`:1975-1984` 的行构建体里**确实没有 `nextRunAt`** —— 作者逐行读过。

**关键判断**:`runTaskNow` 正确委托给了单例 ⇒ **作者知道单例存在** ⇒ 这是不一致,不是无知。改起来风险低。

**恢复路径是偶然的**:重启时 `initialize()` → `scheduleAllActiveTasks()` → `scheduleTask` 用 `task.nextRunAt || this.calculateNextRunTime(task)` 补上 —— 所以症状是"重启后才生效",极难定位。 [AGENT]

**对照**:声明式路径是**对的** —— `lib/plugin/bridge/scheduled-task-bridge.ts` 解析真 `getTaskScheduler()` 并经它创建 [AGENT]。

**修法**:把 `createTask`/`updateTask`/`deleteTask`/`pauseTask`/`resumeTask` 全部改走 `getTaskScheduler()`,保留现有的 `payload.pluginId === pluginId` 属主校验(**每一处都要保留,这是沙箱边界**)。沿用 `runTaskNow` 已有的动态 import 形态,避免 `lib/plugin/**` 在 node 测试环境下的循环依赖。

**验收**:

- `context.test.ts` 新增:`ctx.scheduler.createTask()` 后断言 driver 被 `arm`(mock driver 断言调用)
- 断言 `pauseTask` 触发 `unscheduleTask`
- 断言跨插件属主校验仍然拒绝(**回归防护:别把沙箱改漏了**)
- **注意 Jest 分区**:`lib/plugin/**` 跑在 **node** 环境(无 `window`/IndexedDB)。需要 Dexie 的话加 `/** @jest-environment jsdom */` docblock,或 mock 掉 `schedulerDb`
- `pnpm test -- lib/plugin/core/context.test.ts`

---

#### W1.3 — workflow 的 cron 按 UTC 算,其余所有面按本地时间 **[CONFIRMED] / 高**

**问题**:UTC+8 用户设 `0 0 9 * * *`,Rust daemon 在 **09:00 UTC = 17:00 本地** 触发,而 dashboard 显示的"下次运行"看起来还是对的。

**证据**(作者一手复核)——`crates/cognia-scheduling/src/workflow/triggers/cron_daemon.rs:37-44`:

```rust
struct CronEntry {
    trigger_id: String,
    workflow_id: String,
    schedule: Schedule,
    enabled: bool,
    binding: Option<TriggerBinding>,
    next_fire_at: Option<DateTime<Utc>>,   // ← 没有 timezone 字段
}
```

阳性对照:`timezone` 在本 crate 别处**确实存在**(`scheduler/types.rs:93` `timezone: Option<String>`、`macos.rs:515`),所以这个"缺失"不是 grep 假象。

`recompute` 用 `Schedule::after(&anchor)` 在 `DateTime<Utc>` 上算 [CONFIRMED,`:49-51`]。而:

- TS `cron-parser` 默认**宿主本地时区**(有意为之)[AGENT]
- launchd / schtasks 按**本地时间**触发 [AGENT]
- `SystemTaskTrigger::Cron`(`types.rs:90-94`)**带** `timezone: Option<String>`,但 OS 后端忽略它;workflow 路径连字段都没有 [AGENT]

**作者额外发现** [CONFIRMED]:`macos.rs:515` 在从 plist 反解时**硬编码 `timezone: Some("UTC".to_string())`** —— 而 launchd 实际按本地时间跑。round-trip 又撒了一次谎。

**修法**:`CronEntry` 加 `timezone: Option<Tz>`(`chrono-tz`),`recompute` 在指定时区求解后转回 UTC 存 `next_fire_at`;`workflowTriggers` 行补 `timezone` 字段(Dexie 加版本 —— **用真实 `nextSchemaVersion`,不是 `db.verno+1`**,照 `dexie-migration` skill);缺省取宿主时区以对齐既有 TS 行为。修 `macos.rs:515` 的假 UTC。

**验收**:Rust 单测跨 DST 边界(取一个真实 DST 切换日,如 `America/New_York` 的 3 月某日)断言不重不漏;TS↔Rust 同一表达式同一时区的 `nextFireAt` 一致。

---

#### W1.4 — 两套 cron 方言不兼容,UI 说的 5 字段被 Rust 拒 **[CONFIRMED] / 中**

**证据**(作者一手复核):`crates/cognia-scheduling/Cargo.toml:23` `cron = "0.16"`;`package.json:227` `"cron-parser": "^5.6.1"`。

|           | Rust `cron` 0.16       | TS `cron-parser` 5.6  |
| --------- | ---------------------- | --------------------- |
| 字段数    | **6-7,秒在前** [AGENT] | 秒可选(5 或 6)[AGENT] |
| `L` / `#` | ✗ [AGENT]              | ✓ [AGENT]             |
| 宏        | `@daily` 等 ✓ [AGENT]  | ✓ [AGENT]             |
| 时区      | 无(见 W1.3)[CONFIRMED] | ✓ [AGENT]             |

⇒ 整个 scheduler UI 说 5 字段,而 workflow 路径(`workflow_register_trigger` → `CronDaemon::upsert`)会**直接 `Err`** [AGENT]。`promote-to-system.ts` 的守卫只覆盖 OS 提升路径,**不覆盖 workflow 触发器** [AGENT]。

**修法**:见 §6 [OPEN-2] —— 统一方向未定。无论选哪边,交付物必含**一份差异测试**:同一组表达式(含 `*/N`、范围、列表、`L`、`#`、5/6 字段)喂给 TS 与 Rust,断言"要么都接受且 `nextFireAt` 相等,要么都拒绝"。这份测试是防漂移的唯一保障。

**验收**:差异测试绿;`workflow_register_trigger` 对 5 字段表达式的行为有明确定义(接受或给出可读错误,**不是静默 Err**)。

---

### Wave 2 — 幽灵代码(建好没接线 —— 本仓的招牌病)

---

#### W2.1 — `pluginScheduledJobs` 是幽灵表,统一视图的插件处理与设计文档相反 **[CONFIRMED(零写入) / AGENT(反转)] / 中**

**证据**(作者一手复核 + 阳性对照):`createScheduledJob` 的**调用点只在 `lib/db/plugins.test.ts`**;生产代码零写入(唯一非测试路径是数据**恢复** `components/data/import/import-preview.tsx:38`)[AGENT]。

**两处文档都是假的** [AGENT —— 请复核]:

- `types/scheduler/unified.ts:9` 称其为"插件调度器的表"
- `lib/db/plugin-scheduled-jobs.ts:3-5` 称"executor 每次 tick 会查这些行"
- 而 `plugin-executor.ts:37-43` 读的是 `task.payload`,**从不碰这张表**

**后果**:`plugin-source.ts` 在列一张**永远为空的表**;真正的插件任务从 `"app"` kind 冒出来(`app-source.ts:39-41` `isAppOwnedTask` 只排除 connector 前缀,放行了 `type:"plugin"`)。**统一视图对插件的处理和它自己的设计文档是反的。**

**修法**:见 §6 [OPEN-3](删表 vs 接线)。

**验收**:无论选哪条,`types/scheduler/unified.ts:9` 与 `lib/db/plugin-scheduled-jobs.ts:3-5` 的注释必须与实现一致 —— **这两句谎话是本项的根因**。

---

#### W2.2 — `github-delivery` 的轮询器是完整的死代码 **[CONFIRMED] / 中**

**证据**(作者一手复核 + 阳性对照):

```
runPluginPoll  →  只有 plugins/github-delivery/src/index.ts:290 的声明,零调用者
runGithubPoll  →  只被 runPluginPoll(:303)和自己的测试调用
```

自己的 docstring(`index.ts:281-283`)写着"Exported so the scheduler can invoke it on its own cadence" —— **那个集成从未接线**。`github-poll.ts:8` 的注释描述了一个不存在的 `everyMs` 参数。插件 `plugin.json` 无 `scheduledTasks[]`、无 `scheduler` capability [AGENT]。

live 路径是 webhook(Rust `webhook_router.rs`)+ connector adapter [AGENT]。

**这条的意义大于它本身**:它是**唯一一个需要周期性工作的第一方插件**,而它**没有采用插件调度 API**。结合 W1.2 —— **一个真采用了 `ctx.scheduler.createTask()` 的插件,会发布一个静默不工作、直到用户重启才生效的轮询器。** 这解释了为什么 W1.2 至今没被发现。

**修法**:见 §6 [OPEN-4](接线 vs 删除)。

**验收**:选接线 ⇒ 加 `scheduledTasks[]` + `registerHandler`,E2E 断言到点真的拉取;选删除 ⇒ `runPluginPoll`/`runGithubPoll`/`github-poll.ts` 及其测试一并移除,`github-poll.test.ts` 不再存在。**不允许留着"以后可能用"**(Working Rule 7:刻意的休眠必须三轴同时标注,否则就是潜伏 bug)。

---

#### W2.3 — 插件卸载清错了表 **[AGENT] / 低**

`components/plugins/plugin-panel.tsx:360` 删 `db.pluginScheduledJobs.where("pluginId").equals(id)` —— 但真任务在 `tasks` 表。**目前没出事只是因为 disable 先跑**(`unregisterScheduledTasksForPlugin` 会删掉该插件所有 `type:"plugin"` 任务)。一旦有人调换顺序或加一条不经 disable 的卸载路径,就会留下永久孤儿任务。

**修法**:改为经 `getTaskScheduler()` 删真任务;若 W2.1 选择删表,本项自然消解 —— **依赖 W2.1 的决定**。

**验收**:卸载后断言 `tasks` 表无该 `pluginId` 残留;测试覆盖"不经 disable 直接卸载"的路径。

---

#### W2.4 — manifest 的 `trigger` 改动被静默忽略 **[AGENT] / 低**

`scheduled-task-bridge.ts:109-116` 的幂等键只匹配 `(name, handler)`。插件更新版本、改了 manifest 里的 `trigger`,现存行被判定 `skipped`,**旧节奏永久保留**。

**修法**:幂等键纳入 trigger 指纹;不一致时经 `getTaskScheduler().updateTask()` 更新(**依赖 W1.2** —— 否则更新同样不上弦)。

**验收**:测试"改 manifest trigger → 重新 enable → 行的 trigger 与 `nextRunAt` 都更新"。

---

### Wave 3 — 扩展点硬化(把 §2 的矩阵变成可用的)

> **本波全部 [AGENT]** —— 触点计数与 trait 形状均未经作者一手复核。**每项动手前先自行验证那一条。**

| 项       | 问题                                                                                                                                                                                                                                                             | 修法                                                                                         | 验收                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **W3.1** | driver 选择写死在 `task-scheduler.ts:181` 的三元里;注入只存在于 `createTaskScheduler(driver?)`,`initSchedulerSystem()` 够不着                                                                                                                                    | 给 `initSchedulerSystem(driver?)` 加参数并向下透传(约 3 个签名)                              | 单测:注入 fake driver 后 `getTaskScheduler()` 用的是它。**这是 mobile 后台调度的前置**                                         |
| **W3.2** | `KIND_ORDER` **三份独立拷贝**(`kind-filter-chips.tsx:22`、`scheduler-dashboard-view.tsx:124`、`app/me/scheduler/page.tsx:61`),类型 `ScheduledItemKind[]` 被任意子集满足 ⇒ 漏一个 kind = 无 chip、无汇总卡、**移动端条目静默消失**                                | 合成单一导出常量,类型改为**穷尽元组**(如 `readonly [...] satisfies` 全量校验),让 TS 拦住遗漏 | 单测:新增 kind 不更新常量则**编译失败**                                                                                        |
| **W3.3** | 运行历史不可插拔 —— `use-unified-recent-runs.ts` 是**绕过 registry 的平行汇聚**(5 个手写 `useLiveQuery` + 5 个硬编码 mapper);source 契约无 `listRuns()` ⇒ 新 kind 静默零历史。其中一处靠嗅探 `connection:` id 前缀反推 kind                                      | 给 `ScheduledItemSource` 加 `listRuns?()`,hook 改为遍历 registry                             | 单测:注册假 source 后其 run 出现在统一历史里                                                                                   |
| **W3.4** | `ctx.scheduler` **无 capability gate**(`context.ts:295` 是裸的);`scheduler` capability 纯装饰。对比 `dexie` 有 `manifest.dexie` 门禁、`network`/`fs` 有 `guardNativeApi`                                                                                         | 纳入现有 GUARD_MAP / capability 门禁                                                         | 单测:未声明 `scheduler` 的插件访问 `ctx.scheduler` 被拒。**注意:这是破坏性变更**,现存插件若未声明会挂 —— 先扫一遍 `plugins/**` |
| **W3.5** | `get_trigger_capabilities()` **4 份手写 vec**(`macos.rs:783-836`、`windows.rs:1027-1080`、`linux.rs:825-880`、`mod.rs:831`)+ TS 侧 `PROMOTABLE_TRIGGER_TYPES`、`checkOsCronCompatibility` —— 加第 7 种触发器时编译器拦住约 15 处,**这 6 份会编译通过并且是错的** | 由枚举派生 capability(macro 或 `impl` 上的穷尽 match),消灭手写 vec                           | Rust 测试:枚举加一个变体则**编译失败**直到所有后端表态                                                                         |

---

### Wave 4 — 文档补位

- **W4.1** [CONFIRMED / 必做] —— **`CLAUDE.md` 的 Subsystem Map 加一行 scheduler**。这是本次全部返工的根因:一个 19.7k LOC + 专用 Rust crate 的子系统不在复用查找表里,导致"先查文档"查不到。建议行:

  | Subsystem    | Lives in                                                                                                                                                           | Schema         | ADR  |
  | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ---- |
  | 定时任务调度 | `lib/scheduler/`(**独立 `SchedulerDatabase`,不在 `lib/db/schema.ts`**)、`types/scheduler/`、`components/scheduler/`、`app/scheduler/`、`crates/cognia-scheduling/` | SchedulerDB v2 | 0002 |

  **`lib/scheduler/scheduler-db.ts` 是第二个 Dexie 库**这点必须写进去 —— 任何新调度表都要先想清楚落在哪个库。

- **W4.2** [OPEN,见 §6] —— 新增 **ADR-0073「调度扩展点契约」**,把 §2 的矩阵固化:哪些轴开放、哪些封闭、插件的天花板、以及"要加新触发方式请用 `event` + `triggerEventTask`,不要加 `TaskTriggerType`"这条指引。ADR 编号请 `ls docs/content/docs/en/adr/` 取 max+1 再定(**别信本文的 0073**)。

---

## 4. 建议顺序与依赖

```
W1.1 (macOS)        ── 独立,可先发
W1.3 (时区)         ── 独立
W1.4 (方言)         ── 建议与 W1.3 同期(都动 cron_daemon)
W1.2 (ctx.scheduler)── 独立;是 W2.4 的前置
   └─ W2.4 (manifest trigger)
W2.1 (幽灵表)       ── 需 [OPEN-3] 先拍板
   └─ W2.3 (卸载清错表)  ── 依赖 W2.1 的选择
W2.2 (死轮询)       ── 需 [OPEN-4] 先拍板
W3.*                ── 全部独立;W3.1 是 mobile 后台调度的前置
W4.1                ── 现在就能做,零风险
```

**W4.1 建议第一个合入** —— 一行文档,零风险,且立刻阻止下一个人重蹈覆辙。

---

## 5. 验证命令

```bash
# TS
pnpm test -- <changed test files>
pnpm test:coverage:changed -- --strict              # ≥90% on changed files
pnpm exec eslint <changed files>                    # 只 lint 你改的(eslint . 全仓红,pre-existing)
NODE_OPTIONS=--max-old-space-size=12288 pnpm typecheck   # 门禁 = 无 NEW 错误(baseline 已破)

# Rust —— 读日志,别信退出码(RTK/tee 会掩盖 cargo 失败)
cargo test --manifest-path src-tauri/Cargo.toml scheduler 2>&1 | tee /tmp/sched-test.log
cargo test -p cognia-scheduling 2>&1 | tee /tmp/crate-test.log

# i18n(若碰了 messages)
pnpm i18n:build && pnpm lint:i18n

# 真机验证(W1.1 必须)
pnpm tauri dev
launchctl list | grep cognia          # macOS:确认 plist 真的按预期节奏
```

### 5.1 本仓陷阱(每条都对应一次真实事故)

- **破损的 baseline —— 门禁是"无 NEW 失败",不是"全绿"**:`pnpm typecheck` 有存量错误;`eslint .` 全仓红;`i18n:sort:check` 存量失败;`cargo test` 有存量失败(macOS 7 个已知)。不确定就 stash 前后对比。
- **RTK 会掩盖 cargo 退出码** —— 必须 `tee` 并读日志。
- **Jest 分区**:`lib/plugin/**`、`lib/stores/**`、`types/**` 等纯 `.ts` 跑 **node** 环境(无 `window`/IndexedDB)。要 Dexie/`localStorage` 必须加 `/** @jest-environment jsdom */` docblock。**W1.2 会踩这个。**
- **Dexie 加版本**:用真实 `nextSchemaVersion`,**永远不要 `db.verno+1`**;照 `dexie-migration` skill。**W1.3 会踩这个。**
- **两个 Dexie 库**:scheduler 的 `tasks`/`executions` 在 `lib/scheduler/scheduler-db.ts` 的 `SchedulerDatabase`(v2);`workflowTriggers`/`pluginScheduledJobs`/`loops`/`outboundQueue` 在主 `lib/db/schema.ts`。**下手前先确认你改的是哪个。**
- **并发工作树**:其他 agent 会话可能共用本分支。任何 git stage/commit 前照 `concurrent-tree-safety` skill;**别裸 stash**;逐项 commit,别把整波打成一个巨 diff。
- **i18n 分源**:改 `i18n/messages/{en,zh-CN}/<ns>.json` 后跑 `pnpm i18n:build`;生成的 `en.json`/`zh-CN.json` **从不手改**。有 PostToolUse hook 强制 en/zh 键平衡。
- **changeset**:W1.1/W1.2/W1.3 是用户可感知的修复 ⇒ 每项跑 `pnpm changeset`(选 `cognia-next`,`patch`)。W3/W4 属内部改动,跳过。

### 5.2 每项的 Definition of Done

1. 行为完整实现(无 stub) 2. co-located 测试已加且绿 3. `test:coverage:changed --strict` 过 4. `eslint` 在改动文件上干净 5. `typecheck` 无新增错误 6. 碰了 i18n ⇒ `i18n:build` + `lint:i18n` 绿 7. 碰了 Rust ⇒ `cargo test` 过(**读日志**) 8. 用户可感知 ⇒ 有 changeset 9. 一项一个 commit / PR

---

## 6. [OPEN] —— 需要人拍板,不要默默替它决定

**[OPEN-1] W1.1 macOS 修法:拒绝 vs 完整实现?**
launchd 的 `StartCalendarInterval` **原生支持 array-of-dicts**,所以 `*/15` 理论上可以展开成 4 个 dict(0/15/30/45),范围 `1-5` 可展开成 5 个 dict。

- **A. 拒绝**(对齐 Windows):代价小、行为诚实,但用户会发现"macOS 不能提升 `*/15`",而 Windows 能 —— 平台能力不一致。
- **B. 展开成数组**:能力对齐,代价大(组合爆炸需设上限,如 `* * * * *` 展开成 1440 个 dict 显然不行)。
  **建议 A 先止血**(它现在正在误伤用户),B 作为后续增强单独评估。**但这是产品决定,请拍板。**

**[OPEN-2] W1.4 两套 cron 方言统一到哪边?**

- **A. Rust 迁到 5 字段**(对齐 UI 与 TS):`cron` crate 需要 6-7 字段,得在 upsert 前补 `0 ` 前缀,或换 crate。
- **B. TS 迁到 6 字段**:破坏所有存量任务与用户习惯。**几乎肯定不可接受。**
- **C. 双方都接受两种**,在边界归一化。
  **建议 A 或 C。** 无论哪个,差异测试是必交付物。

**[OPEN-3] W2.1 `pluginScheduledJobs`:删表还是接线?**

- **A. 删表** + 删 `plugin-source.ts`,让 `app-source` 把 `type:"plugin"` 映射到 kind `"plugin"`。承认现实,少一层。**subagent 推荐此项。**
- **B. 接线**:让 plugin executor 真的用这张表。但这与"插件任务就是 `ScheduledTask`"的现有设计冲突,等于凭空造第二套存储。
  **倾向 A**,但涉及 Dexie 删表 + 数据迁移(存量用户的表是空的 ⇒ 迁移风险低,**但需确认恢复路径 `import-preview.tsx:38` 的行为**)。

**[OPEN-4] W2.2 `github-delivery` 轮询器:接线还是删除?**
取决于 webhook 路径是否已完全覆盖轮询的场景(**私有仓 / 无公网回调 / webhook 配置失败时的降级**)。若有这些场景 ⇒ 接线;若 webhook 已是唯一支持路径 ⇒ 删除。**需要产品判断,不是技术判断。**

**[OPEN-5] W3.4 `ctx.scheduler` capability gate 是破坏性变更**
现存插件若未声明 `scheduler` 会挂。要不要给一个宽限期(先 warn 后 enforce)?先扫 `plugins/**` 看影响面。

**[OPEN-6] 本计划未覆盖的两个已知能力缺口**(需求未明,故未列工作项):

- **app 完全退出后跑 AI 类任务** —— 架构性天花板。OS 提升只支持 `script`/`workflow`/`backup`/`sync`;`agent`/`chat`/`plugin` 需要活着的 app。要突破得让 CLI 能起 headless 运行时(`lib/headless/runtimes/initializers.ts` 已有 `initSchedulerSystem` 的接线点,是个可能的切入口 [AGENT])。
- **移动端后台定时** —— Capacitor 侧只有 `renderer-driver`,app 切后台即停。要做得接原生(LocalNotifications / BackgroundTask),**前置是 W3.1**。

---

## 7. 调研溯源

四路 subagent(TS 核心 / Rust crate / 聚合层+UI / 插件层)+ 作者对 W1、W2 承重主张的一手复核。

**作者亲手核实过的**(可直接采信):`macos.rs:293-356`、`context.ts:1929/1975-1988/2035-2151`、`task-scheduler.ts:644`、`cron_daemon.rs:37-44`、`runPluginPoll`/`runGithubPoll` 调用图(含阳性对照)、`createScheduledJob` 调用点、`Cargo.toml:23`、`package.json:227`、`CLAUDE.md` Subsystem Map 无 scheduler 行。

**未复核的**(标 [AGENT],动手前自行验证):全部触点计数(17 处 / 20+ 处 / 13 处)、Rust trait 形状、`PluginSchedulerAPI` 的 16 方法与沙箱结论、Windows/Linux 后端行为、`validate_trigger_translation` 的返回值、executor 注册表的开放性。
