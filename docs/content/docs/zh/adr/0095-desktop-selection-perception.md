---
title: "0095 — 桌面选区感知：监听、门控与 OCR 支撑"
description: "选择感应从每次点击轮询，转变为AXObserver-driven总线，配备廉价点击回退、无可访问文本的应用OCR路径，以及拒绝盲读屏幕的权限探针。"
---

# 0095 — 桌面选区感知：监听、门控与 OCR 支撑

- **状态：** 已接受
- **日期：** 2026-07-29
- **基于：** ADR-0020（电脑使用/输入监控）、ADR-0024（OCR）、ADR-0093（选择工具栏）
- **住在：** `crates/cognia-automation/src/automation/{selection_events.rs,platform/ax/observer.rs,platform/shared/{screen_capture.rs,screenshot.rs}}`，`src-tauri/src/selection_toolbar.rs`

## 背景

选择工具栏（ADR-0093）只以一种方式感知选择：订阅全进程输入点按，在桌面任何位置的**每**个左键释放时，生成一个睡眠60毫秒的任务，读取无障碍选项，如果返回为空——再休眠120毫秒再读取。macOS该读的焦点窗口查找在250ms缓存未命中时就会`osascript`分叉。

接下来有三件事，这三者都是同一个根本原因：该功能无法知道是否发生了什么。

1. **按点击付费，而非按选择付费。** 普通点击无法产生选择，但支付了全价。用户明确禁用的应用中的点击也被检查——`app_is_disabled`是在读取后，使用读取时报告的源应用进行的。
2. **键盘选择是不可见的。** ⇧→和⌘A不产生鼠标向上，因此工具栏从未对键盘用户显示。
3. **没有可访问文本的应用是死地。** 图片、PDF查看器、Java 和 Qt 应用程序、远程桌面以及未被要求发布其网页内容树的 Chromium 版本，都永远没有任何信息，且成本全额。

与此同时，`subscribe_events`——“选择变动时告诉我”的明显机制——在macOS返回`UnsupportedPlatform`，`pick_at_point`无论给出的点是什么，都返回了聚焦的*窗口*元数据。

## 决策

### 1. 两层，由手势仲裁——而非应用

第一层是对现有输入分流的廉价门禁：记住媒体，将发布分为`Drag { bounds }`、`MultiClick { count }`或`Ignore`，并预滤新`selection_preflight()`（进程名称、窗口标题、安全字段决策），该程序能一次性从AX响应，且不分叉进程。第二层是真正的大`AXObserver`。

两者不得同时阅读同一个选段。诱人的规则——“这个应用通常会发布通知吗？”——已拒绝：它需要一个PID来比较，鼠标上方唯一可用的PID是最后一次通知，所以比较从结构上是成立的;而用户从一个多话的应用（Safari）移动到信任窗口内的静默应用（终端）时，他们的拖拽会被引导到一个永远不会触发的层。

规则是**“是否*该手势*被遵守”**，这正是武装定时器的含义。一个话多的应用在拖拽时激活，释放延迟，沉降立即点火。静默应用从未启动它，所以发布文件读取的是选择本身。没有窗口，没有PID，也没有每个应用的状态。

### 2. 总线上的元数据，一条门控路径上的文本

`selection_events`是一个类似`input_monitor`的扇出集线器：有界、直接插入全屏，因此本地回调不会被慢吞的消费者阻挡。它只包含类型、点数、选中长度和时间戳。

在上面放选定的文本意味着桌面上每个文本字段的每一个按键都通过一个拥有多个订阅者的全进程广播频道进行流式传输。决定想要文本的消费者仍然必须在自己选择的时刻去阅读——因此正文保持在单一的、封闭的 `read_text_selection` 路径上，每个用户文本字符都有一条可审计的路径。

### 3. 一名观察者，重新聚焦于最前沿的应用

`AXObserverCreate`是按进程计算的。对所有运行中的应用程序进行注册意味着数百名观察者，几乎全都保持沉默。相反，一个专用线程运行一个`CFRunLoop`——与`input_monitor/hook_mac.rs`用来做其`CGEventTap`的结构相同，故意不使用第二个模式——并在最前端的PID发生变化时重新定位。

`CFRunLoop::run_in_mode`使轮询免费：它服务回调一个间隔并返回，所以循环*就是*定时器，不需要`CFRunLoopTimer`。最前端的PID来自系统范围元素的`AXFocusedApplication`，即一马赫往返——不是`NSWorkspace`（一个没有马赫依赖的crate中的新AppKit依赖），也不是`osascript`（分叉）。

注册设置在 *application* 元素上，因此一个注册覆盖了其中的所有文本控件，`AXUIElementSetMessagingTimeout(0.25)`确保一个楔形应用不会阻碍其他应用的运行循环。每一次失败——沙箱应用、无辅助服务器、注册被拒——都会在调试时被记录，并让该应用进入点击路径。这里没有任何问题能让不配合的应用变成全功能错误。

### 4. 键盘选择在出现前就已定

`AXSelectedTextChanged`在⇧→运行中每次按键触发一次。350毫秒的静默期会使突发崩溃;重新装填是把截止日期*推迟*，而不是直接发射。空选项立即被淘汰。超过4000字符的选区不会自动升起，因为⌘A在文档上方是删除或替换之前的，而不是翻译——和弦依然有效。

用于*构建*选择的键（箭头、Home/End、页面Up/Down和`A`，在和解过程中）被排除在“用户已离开”的驳回之外。没有这个排除，键盘路径会被结构性破坏：触发工具栏的按键也会关闭它。

### 5. OCR是回退，拒绝盲读屏幕

当两个无障碍读取都为空时，拖拽区域会被捕获并OCR——但前提是拖动是真实且有清晰文字空间的拖动，且应用未被禁用或凭证提示，后端有正常工作OCR，**并且**且实际授权了屏幕录制权限。

最后门禁正是本节存在的原因。macOS在授权缺失时不会出错：`CGDisplayCreateImage`及其上的所有内容`xcap`（包括在内）都成功，并返回了*每个窗口内容*都被省略的桌面。OCR生成自信且结构良好的文本，与选择无关——该功能将将其提供为“你的选择”，发送给模型，或写入长期记忆。带有文字的壁纸是完全有效的图像，因此事后无法检测到这一点。我们用`CGPreflightScreenCaptureAccess`预检并无声地跳跃;我们从不暗示`CGRequestScreenCaptureAccess`，因为每次申请只提示一次，拒绝是永久性的。

区域捕获需要第二个修正。`ScreenshotOpts.region`是显示器本地的*物理*像素——这是计算机使用的正确合同，模型指向它展示过的图像。拖拽边界盒既不是，而是全局*逻辑*点。直接通过它会裁剪一个矩形，这在Retina上极其错误，且在非桌面起点的显示器上位置错误，同时还能返回图像。因此`capture_global_region`是一个独立的入口点，`global_rect_to_monitor_pixels`纯粹，转换通过单元测试钉住，而不是通过发现不良OCR来确定。

OCR文本有自己的`SelectionOrigin::Ocr`，而不是兄弟布尔值：它有不同的信任层级，并且会传播，所以下游消费者可以免费获得事实。

### 6. 可用性是呼叫站点的一种能力，而非功能标志

`NativeOcrRegistry::list_ids()`无法回答“OCR可用吗”——`install_platform_backends`在*每*个ID下注册一个`PlaceholderBackend`，以确保调度表保持稠密。`NativeBackend::is_available()`（占位符为假）和`available_ids()`给出了真实答案，因此在默认的Windows版本中——所有`ocr-*`功能都是选择加入的，且`ocr-windows`还需要MSIX包身份——回退会自行禁用，呼叫站点没有`cfg`。Apple Vision无条件绑定在macOS上，所以回退在那里是在线的。

### 7. 渲染器载荷不值得信任

决定是否显示“已开链路”的分类器会运行在覆盖层中。Rust重新解析URL和允许列表 http（s），从必须通过形状检查的地址构建`mailto:`本身（无空白、无`?`/`&`/newline，恰好一个`@`），并通过 `url` 对搜索查询对其自身的引擎表进行编码。渲染器为引擎命名;它从未提供过任何URL。UX过滤器不是安全边界。

浏览器页面URLs来自AX（`AXWebArea` → `AXURL`），绝不AppleScript：`tell application "Google Chrome" to get URL` 每个目标应用程序触发一次 Apple 事件TCC提示，因此用户在三个浏览器中选择文本时会看到三个新的权限对话框。AX只需要该特性已经要求的资助。

## 后果

- `EventKind::TextSelectionChanged`是自愿加入的，并且故意不在默认过滤器中。加入它会让每个已有订阅——尤其是桌面事件触发流程——开始注册一个子树范围的 20014 UIA 处理器并为此付费。电线的数值在`lib/automation/types.ts`镜像，zod `DesktopEventKind`在`lib/workflow/nodes/params-schemas.ts`;如果错过了，触发器就会拒绝那种。
- `capabilities().has_events`现在在macOS上是真的，这也让桌面事件触发流程首次变得真实。
- 订阅必须在`selection_toolbar_stop`明确发布。监视任务是`abort`ed的，因此内部的`Drop`-based异步拆解永远不会运行，否则观察线程会比每次关闭都存活。
- `AxBackend`实现`Drop`原因相同：Worker在恐慌后重建后端，没有后端，每次恐慌都会让另一个观察线程被困。
- Windows 在UIA半段时间里是未经编译验证的——这仓库的工具链没有安装任何 Windows 目标，环境也无法获取。API 接口被逐个签名与`uiautomation` 0.25源签名进行核对。
- Linux保持不变。AT-SPI选择阅读从未被实施，这里也没有改变这一点。
