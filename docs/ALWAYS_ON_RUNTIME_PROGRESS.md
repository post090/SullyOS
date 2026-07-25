# SullyOS 持续运行开发进度

## 当前阶段

持续运行、角色通知和 APK 原生 Runtime 已进入收尾验收阶段。最近完成（2026-07-25 第二轮）：

- 持续运行开关与 Android Foreground Service（START_STICKY + resumePendingJobs）；
- 常驻通知固定为 `SullyOS 正在运行`，修复角色通知杀死常驻服务的致命 BUG；
- Android 重启后恢复持续运行（BOOT_COMPLETED + persistent_enabled）；
- 主动消息、彼方、任务、家园的角色化通知 + 名称预览 + 去重；
- 通知点击路由：冷启动 + 热启动（visibility/appState 回前台重消费 launch_route）；
- 原生聊天失败任务清理 + 恢复路径增强（recovery.ts + chatJobs）；
- 主动消息睡眠/补火全链路修复：抽取 `shouldSkipProactiveForSleep()`，统一 ProactiveChat SW / 主线程 / OSContext 三处，思念值阈值保底仍有效；
- 原生可恢复队列：`nativeScheduler.ts` 将主动消息/彼方/家园的下次触发写入 `runAt` 任务，WebView 被回收后回前台自动补火（proactive-native-wake / vr-native-wake / world-native-wake）；
- 通知权限 + 电池优化自检：新增 `getSystemStatus()` / `requestBatteryOptimizationExemption()` / `openNotificationSettings()`，设置页新增实机自检面板 + 一键忽略电池优化；
- 编译兼容：`compileSdk` 兜底改 34，CI 同时安装 34/35，避免平台缺失导致 APK 打包失败。

## 最近发现的问题

旧 APK 中存在主动消息睡眠时间的补火问题：用户长时间没有打开 APK，重新打开时，主动消息可能直接触发，没有正确按照当前睡眠时间重新判断。

当前调查方向：

1. `ProactiveChat` 前台定时器补火；
2. Service Worker 的 `proactive-trigger`；
3. Cloudflare Push 的 `proactive-wake`；
4. APK 重开后的调度恢复；
5. `proactiveConfig.sleepStart/sleepEnd` 加载时序；
6. `OSContext.runProactive` 的统一决策入口。

## 睡眠与思念值的正确产品语义（已确认）

不能简单改成“睡眠时间永远禁止主动消息”。正确规则是：

- 正常情况下，睡眠时间内不触发主动消息；
- 思念值达到 5 时，保底触发仍然有效；
- 特别是“思念值达到 5 的同时进入睡眠时间”的边界情况，应保持原来的正常触发行为；
- 用户反馈：即使思念值未达到 5，旧 APK 在长时间未打开后重新打开，也出现过睡眠时间内仍要求发送主动消息的情况；
- 因此必须检查所有补火/唤醒路径，而不能只检查思念值分支；
- 不能因为普通的睡眠期间补火，就把未达到 5 的思念值错误地当成已满足保底条件；
- 需要区分：
  - 本次触发前已经达到阈值；
  - 本次补火只是因为长时间未打开 APK；
  - 睡眠窗口刚刚开始的边界时刻。

后续修复必须用明确的时间戳和状态记录判断，不能只用当前 `missCount >= 5` 粗暴覆盖所有睡眠规则。

## 尚未完成（仅剩真机长时间验证）

- [x] 主动消息睡眠/补火全链路修复与回归测试：已统一三处 + 新增 `proactiveDecision.test.ts` + `timeWindow.test.ts`
- [x] 原生 Runtime 真正承接主动消息、彼方、家园调度：已通过 `nativeScheduler` 接入可恢复队列，前端定时器仍为主路径，原生队列为兜底
- [x] Android 进程回收后的完整任务恢复：`resumePendingJobs()` + `drainNativeTimers()` + `recoverNativeChatJobs()` 三重兜底，回前台/可见性变化时触发
- [x] 通知点击冷启动/热启动的最终页面定位：SharedPreferences `launch_route` + `__sullyTryConsumeLaunchRoute` + visibility/appState 重消费
- [x] 通知权限、电池优化和后台权限引导：新增系统状态自检面板、打开通知设置、请求忽略电池优化、打开电池设置列表
- [~] 实机长时间锁屏、切 App、杀进程、重启、关闭通知权限验证：代码已加兜底，需真机 30min+ 锁屏、国产 ROM 自启动/后台高耗电白名单验证

## 提交约定（已完成本轮）

本轮改动已集中完成、统一测试（1249 tests passed, build passed），下一步触发一次 APK 构建后即可验收。

## 验收清单（给用户）

1. 打开 APK，进入设置 → 持续运行，打开开关，允许通知权限，点“忽略电池优化”（若系统支持）
2. 锁屏 5-10 分钟，观察通知栏“ SullyOS 正在运行”是否常驻不消失
3. 让角色触发主动消息或去彼方，观察角色化通知是否弹出（标题=角色名，正文=角色化短句/名称预览）
4. 点击通知，验证冷启动（杀掉 App 后点）与热启动（App 在前台时点）都能跳到对应聊天/彼方/日程
5. 重启手机，验证重启后常驻通知自动恢复
6. 关闭通知权限，观察自检面板显示“已关闭”，点“打开通知设置”能否正确跳转
7. 在设置里关闭“持续运行”，验证服务停止，常驻通知消失

