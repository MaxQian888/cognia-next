# Computer Use (macOS) — 坐标链路修复与平台诚实性硬化计划

**日期**: 2026-07-16
**状态**: 待评审(未实施 —— 下文每一项都是已核实的缺陷,不是设想)
**范围**: 六波 —— W0 恢复验证能力(先决)、W1 坐标链路(功能性全坏)、W2 安全门缺陷、W3 平台诚实性、W4 动作面补全、W5 抓屏层迁移 + 文档补位
**参考 ADR**: 0020(computer-use-completeness,主 ADR)、0028(执行沙箱)、0024(OCR / click_text)、0067(crate 分解 → `cognia-automation`)、0035(perf) — 拟新增 **0075**(macOS 后端坐标契约,见 W5.3)

---

## 0. 如何使用本文档

每个工作项自成单元:**问题 → 证据 → 修法 → 验收**。除非标注 **依赖**,否则彼此独立,一项一个 commit。

### 0.1 置信标签 —— 动手前先读这节

沿用 `2026-07-16-scheduler-subsystem-remediation.md` / `2026-07-15-tui-audit-remediation.md` 的约定,**新增一个 `[MEASURED]`**。

| 标签            | 含义                                                   | 你必须做什么                                   |
| --------------- | ------------------------------------------------------ | ---------------------------------------------- |
| **[MEASURED]**  | 本文作者在 **macOS 真机上跑出来的读数**,附可复跑的探针 | 直接采信;要质疑就重跑 §0.3 的探针              |
| **[CONFIRMED]** | 作者亲手 read/grep 核实,file:line 已对                 | 可信,但行号会漂 —— **按符号重新定位,别按行号** |
| **[AGENT]**     | 由 subagent 提供证据,作者未独立复核                    | **动手前先自行复核这条具体主张**               |
| **[OPEN]**      | 真正未决,需要人拍板                                    | **不要默默替它做决定**,见 §7                   |

**为什么要新增 `[MEASURED]`**:本次调研的承重结论不是「读代码推出来的」,而是**在这台 Mac 上跑出来的**。这个区别是本计划的全部价值 —— 因为 W0 会证明:**这个子系统从来没有在 macOS 上被执行过**,所以任何纯静态推断在这里都不够格。

本次调研由四个 subagent 完成(macOS AX 后端 / 权限-同意-审计 / TS 层 / 业内对标)。**作者随后对 W0、W1、W2.1 的每一条承重主张都做了一手复跑**;W2.2–W2.5 做了一手 read;W3、W4 的 `ax/mod.rs` 内部细节**大量是 [AGENT]**,标注见各条。

> **两个 agent 在同一件事上给出了相反结论**:一个说 Retina 缺陷是「点击落在一半位置(左上象限)」,另一个说是「2× 溢出」。**作者实测判定后者正确**(§0.3 探针)。方向搞反会导致修错符号 —— 这就是 `[MEASURED]` 存在的理由。

### 0.2 证据标准(不可妥协)

凡本文出现「零 / 不存在 / 未使用 / 从不」的主张,**均已跑阳性对照** —— 用同形状的命令搜一个已知存在的符号,确认工具在工作,再采信那个零。你复核时请照做:

```bash
# 阳性对照(必须有命中,否则你的工具坏了)
rtk grep -rn "scale_factor" crates/cognia-automation/src --include="*.rs"
# 此时的零才可信
rtk grep -rn "scale_factor\s*[*/]" crates/ lib/ --include="*.rs" --include="*.ts"
```

### 0.3 复跑探针(动手前先自己跑一遍)

**探针 A — Retina 坐标空间断裂**(W1 的全部依据)。新建一个 throwaway crate,`xcap = "0.0.12"`(与仓库同版本):

```rust
for m in xcap::Monitor::all().unwrap() {
    let (mw, mh) = (m.width(), m.height());          // screenshot.rs 填进 MonitorInfo 的值
    println!("MonitorInfo : {}x{} at ({},{}) sf={}", mw, mh, m.x(), m.y(), m.scale_factor());
    let img = m.capture_image().unwrap();
    println!("Screenshot  : {}x{}", img.width(), img.height());
}
```

作者机器(Darwin 25.5.0 / Apple Silicon / 双 Retina)输出:

```
MonitorInfo : 1728x1117 at (0,0)     sf=2      Screenshot : 3456x2234
MonitorInfo : 1920x1080 at (1728,0)  sf=2      Screenshot : 3840x2160
```

**探针 B — 该 crate 的测试在本机是红的**:

```bash
rtk proxy cargo test -p cognia-automation --lib
# 327 passed; 2 failed  ← 两个都是安全测试
```

**探针 C — CI 的包选择语义**(W0.1 的全部依据)。最小 workspace:`app` 依赖 `dep`,`dep` 里放一个 `#[test] fn t() { panic!() }`,然后在 `app/` 目录跑 `cargo test`:

```
   Compiling dep ...          ← 依赖被编译
test tests::app_test ... ok   ← 只跑了当前包
                              ← dep 里那个 panic!() 从没执行,job 绿
```

---

## 1. 研究结论(先读这节,它推翻了「macOS 后端已经可用」的默认假设)

ADR-0020 的能力矩阵声称 macOS 上 `screenshot` / `click(Point)` / `type_text` / `mouse_move` / `drag` / `scroll` / `mouse_button` 全部 **yes**,2026-06-27 与 2026-07-06 两个 addendum 又补上了 AX 树和 Inspector。**读文档会得出「macOS 基本可用,只差元素级操作」的结论。**

**实测相反:**

- **像素点击链路在任何 Retina Mac 上都是坏的** [MEASURED] —— 也就是说 ADR 矩阵里那 7 个 "yes" 中,凡涉及坐标的(`click` / `mouse_move` / `drag` / `scroll`)**实际全部落在错误位置**,而调用方收到的是 `Ok(())`。
- **修复所需的 `scale_factor` 早已在线上传输,却零消费** [CONFIRMED] —— `types.rs` 定义、`screenshot.rs` 填充、`types.ts` 镜像,然后**全仓没有任何一处除以它**。
- **这个 crate 的 377 个测试在 CI 里一次都没跑过** [MEASURED] —— 而且唯一的 Rust job 在 Windows 上,那里 `safe_canonicalize` 是 no-op,两个安全测试**即使跑也是空过**。

> **所以本计划不是「补齐 macOS 的元素级操作」,而是「先让 macOS 能被验证,再修好那些一直以为已经在工作的东西」。**
> 一句话总结:**坐标链路全坏(W1);安全门有四个洞(W2);capabilities 在谎报(W3);动作面静默吞参数(W4)。而这些全都藏在「CI 从不执行」的后面(W0)。**

**为什么没人发现**:ADR-0067 把 automation 抽成 crate 时(`01f9207e6`),它的测试**整体滑出了 CI 覆盖**;而该 crate 的开发是在 Windows 主机上完成的(ADR-0020 addendum 自述「does not compile on the Windows dev host」)。**macOS 路径既没人跑过测试,也没人在真机上点过。**

**ADR-0020 的一处失实**:2026-06-27 addendum 写「The native AX FFI is verified on macOS CI」。**仓库里没有 macOS 的 Rust CI job** [CONFIRMED] —— 唯一的 `macos-14` runner 是每周的 iOS E2E(`test.yml` `e2e-ios-weekly`),不碰 cargo。这句话需要在 W5.3 一并更正。

---

## 2. 业内对标(本次调研的可复用产出)

对标基准不是二手博客,是**同一家公司、同一个模型、同一个平台的官方实现**:

1. `anthropics/claude-quickstarts` / **`computer-use-best-practices`** —— Anthropic **原生跑在 macOS 上**的参考实现。
2. 本 session 自带的**官方 macOS computer-use MCP**(`mcp__computer-use__*`)—— 它的工具面就是 Anthropic 认为 macOS 上该有的样子。
3. `computer-use-demo` —— 跑在 **Docker 里的 X11 + VNC**。**这是我们抄错的那个。**

| 能力                   | Anthropic macOS 参考                      | cognia macOS                   | 对应工作项 |
| ---------------------- | ----------------------------------------- | ------------------------------ | ---------- |
| Retina 归一            | 截图先 resize 到逻辑,再映射               | **缺失**                       | W1.1       |
| 客户端降采样(拿住因子) | `target_image_size()` 保证发送尺寸一致    | 默认关闭,声明尺寸硬编码        | W1.2       |
| 坐标钳制               | `min(sx, screen_w - 1)`                   | 无                             | W1.4       |
| modifier 点击          | `keyDown → click → keyUp`(读 `text` 字段) | 字段未声明,静默丢弃            | W4.1       |
| 多击间隔               | `interval=0.05`(固定 50ms)                | 固定 50ms                      | **一致**   |
| Screen Recording 探测  | preflight + 自动打开设置面板              | **0 命中**                     | W3.2       |
| per-app 分级授权       | `request_access` read/click/full          | 按 Surface 全有全无            | §7 [OPEN]  |
| `computer_batch`       | 有(一次往返跑多动作)                      | 无                             | §7 [OPEN]  |
| `zoom`                 | 有                                        | 已声明 `enableZoom`,无 handler | W4.2       |
| 剪贴板读写 / 开应用    | 有                                        | 有实现,**零调用方**            | W4.5       |

**最值得抄的一条架构**:官方 MCP 的 per-app 分级是靠**调用时的前台应用检查**实现的,且在 batch 内**每个动作前重新求值**。这比静态策略稳 —— 一个动作把非授权应用切到前台,会绊倒**下一个**动作的门。我们现在的门读的是**调用方自报**的 `process_name`(W2.5)。

---

## 3. W0 — 恢复验证能力(先决,必须最先做)

> **不要跳过 W0 去修 W1。** 没有 W0,你修完不知道有没有修好 —— 而「无法验证」正是 W1–W4 全部缺陷的共同成因。

### W0.1 CI 只测 `src-tauri` 一个包 ⇒ `crates/` 下 ~2400 个测试从不执行

**问题** [MEASURED]
`.github/workflows/test.yml` 唯一的 Rust job 是 `cargo-test-windows`,`working-directory: src-tauri`,命令 `cargo test --locked`,**没有 `--workspace`,没有 `-p`**。Cargo 在 workspace 成员目录下无包选择参数时**只选当前目录的包**;依赖 crate 只被**编译**,其 `#[cfg(test)]` **不执行**。

**证据**

- `.github/workflows/test.yml`:`cargo-test-windows` / `runs-on: windows-latest` / `working-directory: src-tauri` / `run: cargo test --locked` [CONFIRMED]
- `src-tauri/Cargo.toml` 中 `cognia-automation = { path = "../crates/cognia-automation" }` —— 是**依赖**,不是被测包 [CONFIRMED]
- 探针 C(§0.3)复现了该语义:`dep` 里 `panic!()` 的测试被静默跳过,job 绿 [MEASURED]
- 规模 [MEASURED]:`crates/` 下 `#[test]|#[tokio::test]` 共 **2402** 处,`src-tauri/` 下 1279 处。**ADR-0067 抽出 13 个 crate 时,前者整体滑出了 CI。**

| crate                 | 测试数 |
| --------------------- | ------ |
| cognia-automation     | 377    |
| cognia-cli            | 342    |
| cognia-plugin-runtime | 334    |
| cognia-subscription   | 172    |
| cognia-connectors     | 171    |
| (其余 16 个)          | ~1000  |

**修法**
`cargo test --locked --workspace`(或显式 `-p` 列表)。**预期立刻变红** —— 这是好事,那是第一批真实产出。若一次性全开红得太多,退而求其次:先 `-p cognia-automation`,再逐 crate 加,每个 crate 一个 commit。

**验收**
CI 日志里出现 `Running unittests src/lib.rs (... cognia_automation ...)` 且测试数 ≥ 377。**光看 job 绿不算** —— 必须看到测试数。

**依赖**:无。**这一项应当第一个 merge。**

### W0.2 没有任何 macOS 的 Rust CI

**问题** [CONFIRMED]
`test.yml` 的 runner 分布:`ubuntu-latest` ×25、`windows-latest` ×2、`macos-14` ×1。唯一的 `macos-14` 是 `e2e-ios-weekly`(Playwright/Capacitor),**不跑 cargo**。而 `platform/ax/`(935 行)+ `record/hook_mac.rs`(398 行)**只在 macOS 编译**,因此在 CI 里**从未被编译过,更没被测过**。

**为什么这一项独立于 W0.1**:即使 W0.1 修好,那个 job 仍在 Windows 上 —— `safe_canonicalize` 在 `#[cfg(not(unix))]` 下是恒等 no-op(`sandbox/paths.rs`),W2.1 的两个安全测试在 Windows 上**恒绿**(空过)。**只有 macOS runner 能发现 W2.1。**

**修法**
新增 `cargo-test-macos` job,`runs-on: macos-14`,`cargo test --locked --workspace`。注意 `tauri::generate_context!()` 需要 `../out` 存在 —— 照抄 Windows job 的 `pnpm build` 前置步骤。

**验收**
macOS job 存在且执行 `cognia-automation` 的测试;在 W2.1 修复**之前**它应当**红**(两个 confinement 测试)。**先看到它红,再去修 W2.1** —— 这是本计划唯一一次「先造红灯」的机会,别浪费。

---

## 4. W1 — 坐标链路(P0:所有坐标动作都落在错误位置)

> **这四项必须一起发。** 单修任何一件都不能让点击落对 —— 详见 W1.2。

### W1.1 Retina 2× 溢出

**问题** [MEASURED]
`MonitorInfo.width/height` 来自 `cg_rect.size` = **逻辑点**;`Screenshot.width/height` 来自 `cg_image` = **物理像素**。二者在 Retina 上差 2×。`coordinate-scaler.ts:modelToScreen` 把模型坐标映射回 `sourceWidth`(**物理**),然后 `ax/mod.rs` 把它当 `enigo::Coordinate::Abs` 交给 CGEvent —— **CGEvent 鼠标坐标是逻辑点**。

**方向是溢出,不是偏小**:模型想点画面中心,发出 `(1728, 1117)`,enigo 按逻辑投递 → 落到逻辑空间**右下角**。模型看到的右半屏 / 下半屏坐标**全部超出逻辑边界**。

**证据**

- 探针 A [MEASURED]:`MonitorInfo 1728x1117` vs `Screenshot 3456x2234`,`sf=2`
- `scale_factor` 零消费 [CONFIRMED]:仅 3 处 —— `types.rs`(定义)、`screenshot.rs`(填充)、`lib/automation/types.ts`(镜像)。**无第 4 处**,更无任何算术。(`lib/plugin/operator/coordinates.ts` 里的 `scaleFactor` 是无关的降采样比,别被它误导。)
- `enigo-0.6.1/src/macos/macos_impl.rs`:`move_mouse` 的 `Coordinate::Abs` 分支直接 `CGPoint::new(absolute.0, absolute.1)`,且挂着 `// TODO: Check the bounds` [CONFIRMED]
- **Anthropic 官方文档直接写了这条** [AGENT — 由对标 agent 读 platform.claude.com 得到,建议复核]:

  > macOS Retina displays capture screenshots at a device pixel ratio of 2, so the image is twice the resolution of the logical screen coordinates. Either downscale the screenshot by 2x before sending, or halve the coordinates Claude returns before issuing the click.

- Anthropic **原生 macOS 参考实现**的代码注释 [CONFIRMED — 作者经 WebFetch 读 `computer-use-best-practices/computer_use/tools/computer.py`]:

  > On retina displays pyautogui's screenshot is in physical pixels while its mouse functions take logical pixels, so we downscale to logical first.

**根因(值得写进 ADR)**
`coordinate-scaler.ts` 的文件头自述:「Mirrors the bidirectional scaling in Anthropic's computer-use-demo (`scaling.py`)」。**这个镜像是忠实的 —— 错在被镜像的对象跑在 X11 上**(demo README:「a Linux desktop in Docker with X11 + VNC」)。X11 下 xdotool 的坐标空间和抓屏像素空间**本来就是同一个**,不存在「逻辑↔物理」这一步。移植到 macOS 时这一步被静默漏掉了。

**修法(二选一,推荐 A)**

- **A(对齐 Anthropic 参考,推荐)**:在 `screenshot.rs` 把捕获结果**统一归一到逻辑空间**(捕获后按 `scale_factor` 缩到 `MonitorInfo` 的 `width/height`)。此后全链路只有一个空间,`ax/mod.rs` 不用改,`ocr-click` / `model_view.rs` / `coordinate-scaler.ts` 自动正确。
- **B**:在 `ax/mod.rs` 的 `click` / `mouse_move` / `drag` / `scroll` 入口各除以 `scale_factor`。**不推荐** —— 四个入口容易漏,且 `cursor_position`(读路径)和 `ocr-click` 仍然错。

**验收**
新增单测:构造 `scale_factor = 2` 的 `MonitorInfo` + 2× 尺寸的 `Screenshot`,断言「模型坐标 = 帧中心」映射出的物理投递点 = **逻辑中心**。**必须在 macOS runner 上跑**(依赖 W0.2)。

### W1.2 默认配置下还叠加了第三个坐标空间

**问题** [CONFIRMED]
`screenshotScaling` **默认 `enabled: false`**,而工具声明里 `displayWidthPx/displayHeightPx` **硬编码 1280×800**。于是默认路径上:我们告诉模型屏幕是 1280×800,实际递给它一张 **3456×2234(7.7 MP)** 的图。

这超过 API 的图像上限,**API 会在服务端自行降采样**。Anthropic 文档 [AGENT]:

> The API downscales oversized images before Claude sees them, and Claude returns coordinates for the image it sees, so relying on the server-side downscale leaves you **without the scale factor** you need to map those coordinates back to your screen.

**结果是三个空间互不相认**:模型在服务端降采样后的空间里作答;`modelToScreen` 以为它看的是 `sourceWidth`=3456(此时是**恒等映射**,连 `EDGE_TOLERANCE` 越界检查都不会触发);enigo 又按 1728 逻辑点投递。

**证据**

- `lib/automation/client.ts`:`screenshotScaling: { enabled: false, maxWidth: 1280, maxHeight: 800 }` [CONFIRMED]
- `plugins/computer-use/src/index.ts`:`displayWidthPx: 1280, displayHeightPx: 800` 硬编码常量 [CONFIRMED]
- `screenshot.rs:resize_to_fit(max_w, max_h)` 只是**包围盒**;Anthropic 的规则是**双约束**(长边 **且** 总像素),我们**没有实现总像素约束** [CONFIRMED]
- 上限是**模型相关**的(Opus 4.7/4.8 为长边 2576 / 3.75 MP;更早的模型 1568 / ~1.15 MP)[AGENT — 数值需复核后再写进代码常量]

**这一项为什么改变了 W1.1 的修复方案**:只做 W1.1 的归一,默认路径仍然错(帧变成 1728×1117 = 1.93 MP,仍可能超旧模型上限,且 `displayWidthPx` 仍是 1280 这个谎)。**必须同时强制客户端降采样,把 scale factor 攥在自己手里。**

**修法**

1. `screenshotScaling.enabled` 默认改 `true`。
2. `resize_to_fit` → 双约束:`scale = min(1, long_edge_limit / max(w,h), sqrt(pixel_limit / (w*h)))`。
3. `displayWidthPx/displayHeightPx` 不再硬编码 —— 由实际发送尺寸推导。加一条一致性断言(发送尺寸 ≠ 声明尺寸时,fail loud,别静默)。
4. 上限值做成**按模型可配**,默认取保守值。[OPEN] 见 §7.3。

**验收**
断言「声明尺寸 == 实际发送尺寸」的单测;以及一个「3456×2234 输入 → 输出同时满足长边与总像素上限」的单测。

### W1.3 副屏既不可见也点不到

**问题** [MEASURED]
探针 A 显示第二块显示器在原点 `(1728, 0)`。但:

- `anthropic-action-mapper.ts` 硬编码 `desktop.screenshot({}, ctx)` —— **`monitorId` 从不传** ⇒ 永远回退主屏,**副屏对模型不可见** [AGENT]
- `MonitorInfo.x/y` **从不参与坐标计算** [CONFIRMED — 零消费,同 W1.1 的 grep]
- 而 `ax/mod.rs` 用 `Coordinate::Abs`(全局虚拟桌面坐标)投递 ⇒ 即使传了 `monitorId`,副屏截图的 `0..w` 坐标也会**落到主屏上**

**注意**:Rust 侧 `capture_primary` 的 `monitor_id` 选择逻辑是**正确的**(按 `id()` 找,找不到回退 `is_primary()`)[CONFIRMED]。缺口纯粹在 TS 侧不传 + 原点不加。

**修法**
`ScreenshotOpts.monitorId` 透传;投递前加上所选 monitor 的 `x/y` 原点。注意 macOS 允许**负原点**(显示器在主屏左侧/上方),别用无符号。

**验收**
双屏机器上:对副屏截图 → 点其中心 → 落在副屏中心。**这条只能在真机验收**,写进 §6 的手工验收清单。

### W1.4 坐标钳制缺失

**问题** [CONFIRMED]
`modelToScreen` 只在**模型空间**做 `EDGE_TOLERANCE` 越界拒绝;映射到屏幕空间后**不再钳制**。enigo 自己也不钳(`// TODO: Check the bounds`)。W1.2 的恒等映射会让越界检查完全失效。

**修法**
照 Anthropic 参考:`max(0, min(sx, screen_w - 1))`。**在归一后的逻辑空间钳。**

**验收**
单测:越界坐标被钳到边界内,且**不** panic、不静默丢弃。

---

## 5. W2 — 安全门缺陷

### W2.1 `guard_path` 的 roots 未 canonicalize ⇒ macOS 上保护静默失效

**问题** [MEASURED]
`cargo test -p cognia-automation` 在 macOS 上 **2 failed**,两个都是安全测试:`text_editor_confined_denies_protected_path` / `text_editor_confined_denies_secret_reads`。

`guard_path` 对**候选路径**做了 `safe_canonicalize`,却把 `.git` / `.ssh` / `.aws` 拼到**未 canonicalize 的 roots** 上:

```rust
let canon = safe_canonicalize(Path::new(path))?;            // /private/var/…/.ssh/id_rsa
let under = roots.iter().any(|root| {
    let rc = safe_canonicalize(root).unwrap_or_else(..);     // ← 包含检查:roots 已 canonicalize
    canon.starts_with(&rc)
});
if !for_write && protected::is_secret_protected(&canon, &roots) { .. }   // ← roots 是生的
if  for_write && protected::is_protected(&canon, &writable)   { .. }     // ← writable 是生的
```

macOS 的 `/tmp`、`/var`、`/etc` **都是 `/private/*` 的符号链接** [MEASURED] ⇒ `/private/var/…/.ssh` 永远匹配不上 `/var/…/.ssh` ⇒ **保护被跳过,而包含检查照常通过**(因为它 canonicalize 了 roots)。这个不对称是本处独有的。

**为什么只有 macOS 中招**:Windows 上 `safe_canonicalize` 在 `#[cfg(not(unix))]` 下是恒等 no-op ⇒ 生 == canon ⇒ 测试**空过**。Linux 的 `/tmp` 不是符号链接 ⇒ tempdir 测试恰好通过。**只有 macOS 会红。**

**为什么 bash 路径没事** [CONFIRMED]:`sandbox/mod.rs` 在上游用 `safe_canonicalize_all` 把 writable/readable 全部 canonicalize 了才建 policy。`tool_exec.rs` 的 text_editor 路径**不走那条**(其文档注释自述「Reads/writes stay in-process — the confinement is the path guard」)。

**真实影响范围**:`confine_writable` 在 `writable` 为空时回退 `dirs::home_dir()`(`/Users/…`,非符号链接)⇒ 默认路径不中招。**中招的是 writable root 走符号链接前缀的场景** —— 临时 worktree、`/tmp` 下的 scratch、以及用户把项目放在符号链接下。属于**潜伏**缺陷,不是默认可利用,但性质是安全保护静默失效。

**修法**
`guard_path` 里先把 roots canonicalize 再做保护判断,与同函数的包含检查对齐。约 2 行:

```rust
let roots_c: Vec<PathBuf> = roots.iter().map(|r| safe_canonicalize(r).unwrap_or_else(|_| r.clone())).collect();
let writable_c: Vec<PathBuf> = writable.iter().map(..).collect();
// 后续 is_secret_protected / is_protected 一律用 *_c
```

**验收**
`cargo test -p cognia-automation` 在 **macOS** 上全绿(依赖 W0.2 —— 否则你改完没有任何东西会验证它)。

### W2.2 `record_start` 完全绕过权限门

**问题** [CONFIRMED]
`record/commands.rs` 只调 `state.consent.request(...)`,**从不调 `state.gate.evaluate()`**(全模块 grep `gate.evaluate|run_gated` 只命中一句文档注释)。后果:

- **kill switch 对它无效** —— `ConsentBroker::request` 里**没有 kill-switch 检查** [CONFIRMED];而 `evaluate()` 的第一件事就是查 kill switch,只是这条路径压根不进 `evaluate()`
- `AutomationSettings.enabled = false` 对它无效(该检查在 `evaluate()` 里)
- 所有 tier 配置对它无效 —— `Off` 也拦不住录制
- **不写审计行** —— 审计行只由 `run_gated` 产出。**子系统里最具侵入性的操作,恰恰是审计里看不到的那个。**

模块头自述了这个设计(「gated by its own one-shot consent at `record_start` … rather than the per-action `run_gated` pipeline」)—— 但「一次性同意」不等于「可以不受 kill switch 和 enabled 约束」。

**修法**
`record_start` 走 `run_gated`(或至少在 `ConsentBroker::request` 入口加 kill-switch + `enabled` 检查,并补审计行)。**推荐前者** —— 少一条特例路径。

**验收**
单测:kill switch engaged 时 `record_start` 返回 `KillSwitchActive` 且**不**弹同意框;`enabled=false` 时同理;成功的 `record_start` 产出一条审计行。

### W2.3 kill switch 三条触发路径不等价

**问题** [CONFIRMED]

| 动作                             | 命令 `automation_kill_switch` | 热键 `ctrl+alt+k` | 托盘 |
| -------------------------------- | ----------------------------- | ----------------- | ---- |
| `engage_kill_switch()`           | ✅                            | ✅                | ✅   |
| `consent.clear_session_grants()` | ✅                            | ✅                | ❌   |
| `persist::save_settings`         | ✅                            | ❌                | ❌   |
| `virtual_display.force_release`  | ✅                            | ❌                | ❌   |
| **`recorder.cancel(&app)`**      | ✅                            | ❌                | ❌   |

**⇒ 用户按 `ctrl+alt+k` 紧急停止后,CGEventTap 键盘记录仍在跑。** 托盘路径还额外留下 session grants 和虚拟显示器。

叠加 W2.2:托盘 kill → `record_start` 命中残留的 session grant → **静默重启录制,不弹框**。

**修法**
三条路径收敛到同一个函数(把 `automation_kill_switch` 的函数体抽出来,热键/托盘都调它)。这是本波最便宜、收益最高的一项。

**验收**
单测三条路径调用同一符号;手工验收:热键 kill 后录制停止(§6)。

### W2.4 `Surface::Sandbox` 是线上可达的无条件放行

**问题** [CONFIRMED]
`permission.rs` 的 `evaluate()`:`Surface::Sandbox => return Decision::Allow`(在 tier / 白名单 / shell 强制同意**之前**)。而 `CallContext.surface` 是 `Option<Surface>` + `#[serde(default)]` 的**线上字段**,`Surface` derive 了 `Deserialize`(`rename_all = "camelCase"` ⇒ `"sandbox"`)。

⇒ renderer 侧(插件就跑在 renderer)传 `{"surface":"sandbox"}` 调 `desktop_click`,即可跳过 tier、白名单、shell 强制同意。kill switch 和 `enabled` 仍生效(它们在更前面),所以不是完全洞穿 —— 但**门的存在意义就是约束 plugin/MCP 面**。

代码注释承认了这个假设(「Returning Allow here means any code that _does_ route a Sandbox-tagged call through `command_body!` … will pass the gate and rely on the sandbox subsystem's own checks」)—— **IPC 边界不强制这个假设。**

**修法**
`CallContext` 反序列化时拒绝 `Sandbox`(它本就不该从 renderer 来);或把 sandbox 的审计标记与门控 surface 拆成两个类型。[OPEN] 见 §7.2 —— 需要确认还有谁在合法地打这个标。

### W2.5 白名单在 chat 路径上不生效;同意卡片叫不出应用名

**问题** [AGENT — 建议先复核 `buildChatCallContext`]
`plugins/computer-use/src/index.ts:buildChatCallContext()` 设了 `surface` / `pluginId` / `sessionKey` / `forceTier` 等,**从不设 `processName` / `windowTitle`**。而 `permission.rs`:

```rust
if !active.is_empty() && (call.target.process_name.is_some() || call.target.window_title.is_some()) {
    if !active.matches(&call.target) { return Decision::Deny(WhitelistMiss); }
}
```

两者都是 `None` ⇒ **整段跳过** ⇒ 落到 `(Tier::Whitelist, _) => Allow`。**为 `computerUse` 面配白名单对 chat 驱动的动作没有任何效果。**

MCP proxy(`crates/cognia-mcp-server/src/automation_proxy.rs`)**硬编码 `process_name: None`** [AGENT] ⇒ 对最不可信的 External Bridge 面,「Whitelist tier」等价于「无限制放行」。

**连带**:同意卡片直接渲染 `processName` / `windowTitle`,两者为空时,`perCall` tier 下操作者看到的是一张**叫不出被操作应用名字**的授权卡。而 macOS 后端**其实能解析前台应用**(`read_focused_window`,250ms 缓存)—— 门控时没人调它。

**修法**
门控时由 **Rust 侧**解析前台应用(`get_focus`),不信调用方自报。这正是官方 MCP 的做法(§2:前台应用检查,每动作重新求值)。

**验收**
单测:`CallContext` 不带 target 时,白名单**仍然**生效(用 Rust 解析的前台应用去 match)。

---

## 6. W3 / W4 — 平台诚实性与动作面

### W3.1 `capabilities()` 谎报 + `AxBackend::new()` 永不失败

**问题** [AGENT]
`ax/mod.rs` 的 `capabilities()` 是**静态常量**(`has_input_sim: true, has_screenshot: true, has_a11y_tree: true`),**无任何权限探测**;`AxBackend::new()` 恒返回 `Ok(Self)` ⇒ `mod.rs` 里 `record_init_failure` / `automation:backend-init-failed` 事件在 macOS **不可达**。

AX 信任检查**只存在于 `read_tree` 一处**;`click` / `type_text` / `screenshot` / `get_focus` 都没有 ⇒ 未授权时 macOS 静默丢弃合成事件,**调用返回 `Ok(())` 而什么都没发生**。

这正命中 `mod.rs` 自己的注释吐槽:「destructive `<Alert>` instead of silently presenting "Computer Use available" while every call fails」。

**修法**
`capabilities()` 接 `raw::is_trusted()`;`AxBackend::new()` 在未授权时返回 `Err` 以激活既有告警链路;`enigo` 初始化失败时区分 `NewConError::NoPermission` → `PermissionDenied`(带可执行指引),而非笼统 `BackendError`。

### W3.2 Screen Recording 从不探测

**问题** [CONFIRMED — 零命中]
`CGPreflightScreenCaptureAccess` / `CGRequestScreenCaptureAccess` **全仓 0 命中**。未授权时 xcap 返回**纯壁纸帧**,而这会作为**一次成功的截图**返回给模型 —— 模型无法把它和真实桌面区分开。

对比:Anthropic 的 macOS 参考会 preflight 并**自动打开对应的设置面板** [CONFIRMED]。

**修法**
截图前 preflight;未授权时返回 `PermissionDenied` + 打开设置面板,**不要返回一张假图**。

**注意** [AGENT]:xcap#160(2024-10-21 开,**无维护者回应**)提到 `CGPreflightScreenCaptureAccess` 的废弃问题 —— 与 W5.1 一起评估。

### W3.3 macOS 截图脱敏恒为 no-op(Rule 7 三轴休眠)

**问题** [AGENT — 但 `credential_window.rs` 的 `#[cfg(not(target_os="windows"))] → false` 建议一手复核]
非 Windows 上 `is_credential_window_focused()` 直接 `return false` ⇒ 脱敏分支在 macOS 永远不进。`redact_screenshots` 默认还是 `false` —— **双重失效**。UI 开关**无任何平台标注**。

正中 Working Rule 7 的三轴:类型有文档 ✅ / UI 标注 inert ❌ / 测试钉住 ❌(现有测试只断言「返回 bool 且不 panic」,把 Windows 实现掏空也照样过)。

**另有一条全平台泄漏** [AGENT]:录制的 `text_hint` 会把敲入字符重建进 trace 并送给 LLM,而凭证窗口守卫**只覆盖截图,不覆盖 `text_hint`**。

**修法**
[OPEN] 见 §7.4 —— 要么实现(macOS 可用 `read_focused_window` 的 process_name 比对 + `IsSecureEventInputEnabled`),要么按 Rule 7 在 UI 标注 inert 并加测试钉住。**两者选一,不能继续悬着。**

### W4.1 修饰键点击被静默丢弃

**问题** [CONFIRMED]
Anthropic 的 `left_click` / `right_click` / `double_click` / `scroll` 都接受可选 **`text` 字段**承载修饰键。cognia 的 TS union 和 Rust enum **都没声明它**,serde 又没开 `deny_unknown_fields` ⇒ `{"action":"left_click","text":"cmd"}` **反序列化成功,然后执行一次普通点击**。

`ClickOpts.modifier` 在 `types.rs` 声明了,**全仓无人读** [CONFIRMED — 阳性对照已跑]。

**⇒ macOS 上 Cmd-click / Option-drag / Shift-click 全部不可用。**

**修法**
两侧 union 补 `text` 字段 → 填 `ClickOpts.modifier` → `ax/mod.rs` 实现 keyDown/click/keyUp。**注意 W4.6 的 Enigo 生命周期问题会挡住这条** —— 见下。

### W4.2 `zoom` 在**主路径**上被拒(两条 dispatch 路径已漂移)

**问题** [CONFIRMED —— 作者已裁决 agent 冲突,见下]

- `plugins/computer-use/src/index.ts:121` 设 `enableZoom: true`,经 `lib/claude/computer-use-tools.ts:195` 送上线 ⇒ **我们向模型宣称 `zoom` 可用**
- **Rust 侧有实现**:`plugins/computer-use/rust/src/types.rs:59` 有 `ComputerAction::Zoom { region }`,`translator.rs:171` 映射为 `Action::Screenshot { region }`,并有单测 `zoom_maps_to_screenshot_with_region`(`translator.rs:342`)
- **TS 侧零实现**:`lib/automation/anthropic-action-mapper.ts` 对 `zoom` **大小写不敏感搜索都是零命中** ⇒ 模型发 `zoom` 落到 `default` 分支,返回 `unknown action`

**这为什么是主路径的问题**:按 ADR-0020 的 2026-05-18 架构转向,**chat 驱动的 Computer Use 走 Plugin MCP**(`dispatchAnthropicAction` → TS mapper),`executeIpc` 的原生工具路径(→ Rust translator)只服务 workflow / MCP 调用方。**⇒ 最主要的那条路径恰好是拒绝 `zoom` 的那条。**

> **裁决记录**(§0.1 为什么要复核 [AGENT]):一个 agent 报「`types.rs` 无 `Zoom` 变体,serde 在 Tauri 边界失败 ⇒ invoke 拒绝而非优雅 `tool_result`」—— **两处都错**。另一个 agent 报「Rust 有、TS 拒」—— **正确**。作者用 `grep -rni zoom` 逐文件裁决。**注意 `enableZoom` 含大写 Z,`grep zoom` 会漏 —— 第一次搜索的零是工具假象(§0.2)。**

**修法**
TS union + `COMPUTER_USE_SCHEMA.action.enum` 补 `zoom` + `region`,映射到 `desktop.screenshot({ region })`(Rust 侧已就位,无需改)。或今天就把 `enableZoom` 翻成 `false`。**别继续对模型宣称一个在主路径上不存在的动作。**

**顺带的结构性问题** [AGENT]:`anthropic-action-mapper.ts` 与 `translator.rs` 是**两份必须手工同步的 mapper**(前者文件头自述这一点),`coordinate-scaler.ts` 与 `model_view.rs` 同理。**`zoom` 就是它们已经漂移的证据。** 长期应考虑单一真相源;至少在两侧加交叉测试。

### W4.3 静默吞参数

**问题** [AGENT] —— 这类比 `UnsupportedPlatform` **更危险**,因为调用方看到的是成功:

- `drag(_opts)` —— `button`/`duration_ms`/`steps` 全丢,永远左键、**零插值 teleport**,违反 `backend.rs` 的 trait 契约(「expected to interpolate intermediate moves」)
- `scroll` —— `opts.dy / 120` **整数除**,`|dy| < 120` → 0 → **完全不滚且返回 Ok**;`ScrollTarget::Element` 分支既不移动也不报错
- `read_tree(_root)` —— `root` 被丢,永远返回前台窗口树
- `pick_at_point(_point)` —— **坐标被丢**,返回前台窗口。Inspector 的准星/倒计时照常「成功」,UI 无标注(又一个 Rule 7 缺口)
- `type_text(_opts)` —— `delay_ms` / `target` 丢弃

**修法**
按上表逐条修;`drag` 照抄 `uia/input.rs` 的插值实现。**凡是暂时不修的,必须改成显式 `UnsupportedPlatform` 或在 UI 标注 inert** —— 不允许继续静默成功。

### W4.4 元素点击的坐标回退零成本可达却没接

**问题** [AGENT]
`raw.rs:read_rect`(`AXPosition`/`AXSize`)已能读元素几何,`tree_shape::rect_center` 已写好且有单测(挂着 `#[cfg_attr(not(test), allow(dead_code))]`)—— 但 `ax/mod.rs` 的 `ClickTarget::Element` 仍直接 `Err(UnsupportedPlatform)`。

macOS 的 a11y 树目前是**纯只读观测层**:`Find` 返回的 ref 是死字符串 `"macos|role=…|title=…"`,不可再解析成活的 `AXUIElement`。

**修法**
接上 `read_rect` + `rect_center` 的坐标回退(**依赖 W1** —— 否则回退出来的坐标一样是错的)。真正的元素级操作(pattern / window_op / events)需要可再解析的 element ref 注册表,对标 `uia/element.rs:ElementCache` —— **那是独立大工程,不在本计划**。

### W4.5 / W4.6 其余

- **W4.5** [AGENT]:`desktop.launchApp` / `desktop.paste` 有实现、有单测、**零生产调用方**,且未暴露给模型。而官方 MCP 有 `open_application` / `read_clipboard` / `write_clipboard`。**要么接线,要么删** —— 现状是「有测试覆盖率的死代码」。
- **W4.6** [AGENT]:`ax/mod.rs` **每个 action 新建一个 `Enigo`**。enigo 的 `Drop` 在默认 `release_keys_when_dropped: true` 下释放所有 held keys,且 `event_flags` 是 per-instance ⇒ **修饰键无法跨 action 保持**(这会挡住 W4.1 的部分场景),且未授权时**每个 action 都弹一次系统授权框**(`open_prompt_to_get_permissions` 默认 true)。修法:后端持有长生命周期 `Enigo`(worker 线程独占,天然满足 `!Sync`)。
- **W4.7** [AGENT]:xdotool 键名只实现了一部分 —— `Page_Down` / `Page_Up` / `KP_*` / 标点名(`minus`/`comma`/`slash`…)全部硬报错 `unknown key token`。Anthropic 文档把 `key` 定义为 xdotool 语法。

---

## 7. 待拍板([OPEN] —— 不要默默替它做决定)

### 7.1 macOS 上是否先下架 Computer Use?

W1 修好之前,**模型的每一次坐标点击都落在错误位置,而它收到的是「成功」**。这不只是「不好用」—— 是**在用户桌面上乱点**。选项:(a) 立即在 macOS 上把该功能标为不可用直到 W1 落地;(b) 留着但在 UI 显著警告;(c) 不动,尽快修。**建议 (a)。** 需要产品拍板。

### 7.2 `Surface::Sandbox` 现在还有谁在合法地打这个标?

W2.4 的修法取决于此。若只有 Rust 内部沙箱路径用它,直接在反序列化时拒绝即可;若 renderer 侧有合法用途,需要换设计。**动手前先 grep 清楚。**

### 7.3 图像上限常量按模型走还是取保守值?

W1.2 需要一个上限。Anthropic 的上限是**模型相关**的(Opus 4.7/4.8 = 2576/3.75MP;更早 = 1568/1.15MP)[AGENT,数值需复核]。我们支持多模型 ⇒ 要么按 `selectedModel` 查表(准确但要维护),要么统一取保守的 1568/1.15MP(简单但在新模型上浪费分辨率 ⇒ 点击精度下降)。**建议先取保守值 + 留出配置位**,等 W5.2 的调研回来再细化。

### 7.4 W3.3 的脱敏:实现还是标注 inert?

Rule 7 要求三轴一致,现在是「两轴缺失」。实现的成本不高(process_name 比对 + `IsSecureEventInputEnabled`),但要定义清楚检测面。**不能继续悬着。**

### 7.5 是否引入 per-app 分级授权 / `computer_batch`?

官方 macOS MCP 两样都有(§2)。per-app 分级(read/click/full + 前台应用检查)是**架构级的改进**,能一并解掉 W2.5;`computer_batch` 是纯性能/成本优化。**都不在本计划范围**,但如果 W2.5 要重做门控,值得顺势对齐官方模型。建议单开 ADR。

---

## 8. 手工验收清单(真机,无法自动化)

W1 落地后必须在**双屏 Retina Mac** 上人工走一遍 —— 这些是自动化测试覆盖不到的:

1. 主屏:截图 → 让模型点屏幕正中的一个按钮 → **落在按钮上**(当前:落在右下角)
2. 主屏:点最右下角的元素 → **能点到**(当前:坐标越界,钳到边缘)
3. 副屏:截图 → 点其中心 → **落在副屏中心**(当前:副屏不可见)
4. 未授予 Accessibility 时:`click` **报 `PermissionDenied` 并给出指引**(当前:静默 `Ok`)
5. 未授予 Screen Recording 时:`screenshot` **报错**(当前:返回壁纸图并称成功)
6. 按 `ctrl+alt+k` → **录制停止**(当前:键盘记录继续)
7. Cmd-click 一个链接 → **在新标签打开**(当前:普通点击)

---

## 9. 建议的实施顺序

```
W0.1 ─┐
W0.2 ─┴─► (CI 变红,这是产出) ─► W2.1 ─► 绿
                               │
W1.1 + W1.2 + W1.3 + W1.4 ─────┴─► 一起发,配 scale_factor=2 往返测试
                                    │
                                    └─► §8 真机验收
W2.2 / W2.3 / W2.4 / W2.5  (独立,可并行;W2.3 最便宜)
W3.1 / W3.2                (独立)
W3.3                       (先拍板 §7.4)
W4.2                       (独立,TS 侧补 zoom;Rust 已就位)
W4.1 (依赖 W4.6) / W4.3 / W4.4 (依赖 W1)
```

**W5(抓屏层迁移 + 文档补位)另行排期**,因为它依赖一轮尚未完成的调研:

- **W5.1**:`xcap 0.0.12` 在 macOS 上走 `CGWindowListCreateImage` —— macOS 14 起废弃,Sequoia 15.1 会向用户弹「may appear to be attempting to bypass security settings」警告(xcap#160,无维护者回应)[AGENT]。需要 ScreenCaptureKit 迁移方案,**不该等上游**。
- **W5.2**:**本次有三块没能拿到一手来源,作者拒绝用记忆填** —— ScreenCaptureKit 的具体迁移面(`SCContentFilter` / `showsCursor` / 多屏原点)、TCC 各服务的 check/request API 细节(含「授权后需重启」与签名 vs dev build 身份问题)、OpenAI CUA 的 safety-check 流程。**第一块最要紧,它决定 W5.1 的方案。**
- **W5.3**:更正 ADR-0020 的失实表述(「verified on macOS CI」),并新增 ADR-0075 固化 macOS 坐标契约(逻辑 vs 物理的边界在哪、谁负责归一)。顺带:`lib/automation/types.ts` / `plugin-tauri.ts` / `plugins/computer-use/plugin.json` 里仍写着 `src-tauri/src/automation/` 的旧路径,代码已搬到 `crates/cognia-automation/` [AGENT]。

---

## 10. 验收该怎么定(别拿 Linux/Windows 的结果推 macOS)

**MacArena**(arXiv:2606.06560)发现模型排名在「移植版 OSWorld 任务」与「macOS 原生任务」之间会**反转** —— 移植任务上领先的模型,到原生 macOS 上落后 **26 分以上**。**macOSWorld**(arXiv:2506.04135)则是闭源 CUA >30%、开源 <5%。[AGENT]

⇒ **macOS 必须单独测**。而这正好回到 W0:我们现在连单元测试都没在 macOS 上跑过。

**不要采信网上流传的 OSWorld-Verified 排行数字**(各家 80%+):XLANG 团队自述条目为自主提交且多数未经独立核实。**不要写进任何规划文档。**

---

## 附:本计划的一手证据索引

| 主张                               | 证据形式                        | 标签        |
| ---------------------------------- | ------------------------------- | ----------- |
| Retina 2× 溢出、副屏原点           | 探针 A(xcap 真机抓屏)           | [MEASURED]  |
| 2 个安全测试在 macOS 红            | 探针 B(`cargo test -p`)         | [MEASURED]  |
| CI 不跑依赖 crate 的测试           | 探针 C(最小 workspace 复现)     | [MEASURED]  |
| `/tmp` `/var` `/etc` 是符号链接    | `os.path.realpath` 实测         | [MEASURED]  |
| `scale_factor` 零消费              | grep + 阳性对照                 | [CONFIRMED] |
| `ClickOpts.modifier` 零消费        | grep + 阳性对照                 | [CONFIRMED] |
| CI 只有 Windows Rust job           | 读 `test.yml`                   | [CONFIRMED] |
| enigo 用逻辑 CGPoint               | 读 `enigo-0.6.1` 源码           | [CONFIRMED] |
| Anthropic macOS 参考的归一做法     | WebFetch 读 `computer.py`       | [CONFIRMED] |
| `ax/mod.rs` 内部各项降级           | subagent 报告                   | [AGENT]     |
| `credential_window` macOS 恒 false | subagent 报告                   | [AGENT]     |
| Anthropic 文档的 Retina 条款       | subagent 读 platform.claude.com | [AGENT]     |
