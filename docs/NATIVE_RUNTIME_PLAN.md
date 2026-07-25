# SullyOS APK Native Runtime 长程任务规划

> 记录时间：2026-07-25  
> 背景：SullyOS 主要以 APK 形式使用。用户反馈：切出 APP / 锁屏 / 一段时间不看后，APP 容易被系统杀掉或 WebView 重载，导致需要重进、聊天生成中断、状态接续差。  
> 重要约束：**不要把 Worker 作为 APK 主路径依赖**。用户多次体感 Worker 连不上；APK 下可以接受原生 Android/Capacitor 方案。  
> 任务性质：这是一个长程基建任务。分步骤是为了工程实现，不是每做一小阶段就要求用户测试一个体验级别。最终应形成一个整体可用版本后再交给用户统一体验和反馈。

---

## 0. 安全与凭据说明

- 用户曾提供一个临时 GitHub PAT 用于 push / 触发 APK 构建。
- **不要把 PAT 写入仓库、文档、localStorage、git config、脚本或任何持久化文件。**
- 需要使用时，只允许在单次命令进程环境中临时注入，并在输出中脱敏。
- 用户表示后续会 revoke。应在完成相关推送/构建后提醒用户撤销。

---

## 1. 用户真实优先级

用户明确指出：

1. **不是优先做语音。**
2. 更重要的是：
   - APK 本体保活；
   - 常规聊天生成稳定；
   - APP 切后台 / 锁屏 / 被系统杀后能恢复现场；
   - 聊天生成中断后能接续或重试；
   - 不依赖 Worker；
   - 原生方案可以接受。
3. 通话以后也要考虑能接上，但不是第一优先级。
4. 分阶段是工程拆分，不是拆体验交付。用户不会每个中间状态测试，最终做完后统一使用并反馈。

---

## 2. 总目标

构建一个 APK 专用运行时层：

```text
SullyOS JS / React UI
  ↓
SullyOS Runtime Manager
  ↓
Native Runtime Capacitor Plugin
  ↓
Android Foreground Service + Native Job Queue
  ↓
OkHttp / 本地任务结果文件 / 通知 / 恢复机制
```

最终体验目标：

- 切 APP、锁屏、一段时间后回来，尽量仍在原状态。
- 如果 WebView 没死：继续当前状态。
- 如果 WebView 被杀但原生任务还完成了：重开后补上结果。
- 如果原生任务也失败/被杀：不污染对话；只记录状态和开发者/系统日志，后续可做轻量重试入口。
- APK 常规聊天长请求不依赖 Worker。
- Web/PWA 路径保留原行为，不因 APK 原生方案被破坏。

---

## 3. 非目标 / 暂不优先

本任务第一轮不要把重心放在：

- 真后台语音通话；
- 后台录音；
- 蓝牙 / 扬声器 / audio focus 全套处理；
- 原生 STT / TTS；
- 通话音频持久化作为首要目标；
- Worker 重构；
- 重写聊天上下文构造逻辑。

通话后续可以接，但本轮重点：

```text
APP 本体保活 + 常规聊天生成接续 + 原生任务队列 + 恢复现场
```

---

## 4. 设计原则

### 4.1 不追求“永不被杀”

Android 普通 App 无法保证永不被杀。正确方向是：

```text
尽量不死 + 死了也能恢复 + 长任务有结果可 drain
```

### 4.2 APK 下优先原生，Worker 只作辅助

优先级：

```text
Native Runtime > CapacitorHttp / 原 safeFetchJson > Worker 辅助
```

Worker 可以保留用于：

- Web/PWA；
- 主动消息；
- 云端补充能力；
- 非 APK fallback。

但 APK 常规聊天不应把 Worker 当核心依赖。

### 4.3 不重写 prompt/context 构造

SullyOS 现有聊天上下文构造很复杂，包括：

- 角色设定；
- 用户资料；
- 聊天历史；
- 记忆宫殿；
- 情绪 / 日程 / 备忘录；
- 世界书；
- 工具调用；
- 流式 / reasoning / API 日志等。

本任务尽量只替换“请求如何发送与如何恢复”，不要重写“请求体如何构造”。

### 4.4 Web 版必须 fallback

所有 Native Runtime 调用都要有 Web fallback：

```ts
if (!Capacitor.isNativePlatform()) {
  return originalSafeFetchJson(...)
}
```

---

## 5. 核心模块规划

### 5.1 Runtime Snapshot

新增运行时快照层，记录当前 APP 现场。

建议文件：

```text
utils/runtime/runtimeState.ts
utils/runtime/lifecycle.ts
```

保存内容示例：

```ts
interface RuntimeSnapshot {
  version: 1;
  activeApp?: AppID;
  activeCharacterId?: string;
  lastVisibleAt?: number;
  lastHiddenAt?: number;
  chat?: {
    draftsByCharId?: Record<string, string>;
    pendingJobIds?: string[];
    lastCharId?: string;
    scrollAnchorMessageId?: number;
  };
  call?: {
    active?: boolean;
    charId?: string;
    sessionId?: string;
    startedAt?: number;
    state?: string;
    updatedAt?: number;
  };
}
```

触发保存时机：

- activeApp 变化；
- activeCharacterId 变化；
- 聊天草稿变化；
- 创建 / 完成 / 失败 pending job；
- App hidden / pause；
- App resume / visible；
- 通话状态变化（后续）。

恢复时机：

- OSContext 初始化后；
- App `resume`；
- `visibilitychange → visible`。

---

### 5.2 Native Runtime Capacitor Plugin

新增本地 Capacitor 插件：

```text
plugins/sully-native-runtime/
```

目标：Android 原生层提供前台服务与任务队列。

JS API 草案：

```ts
NativeRuntime.ping(): Promise<{ ok: boolean; platform: string }>;

NativeRuntime.startForegroundTask({
  id: string;
  kind: 'chat' | 'call' | 'tts' | 'memory' | 'generic';
  title: string;
  text: string;
  ongoing?: boolean;
}): Promise<void>;

NativeRuntime.stopForegroundTask({
  id: string;
}): Promise<void>;

NativeRuntime.enqueueHttpJob({
  jobId: string;
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  responseType?: 'text' | 'json';
}): Promise<{ jobId: string }>;

NativeRuntime.getJob({
  jobId: string;
}): Promise<NativeJobRecord | null>;

NativeRuntime.listJobs(): Promise<{ jobs: NativeJobRecord[] }>;

NativeRuntime.cancelJob({ jobId: string }): Promise<void>;
NativeRuntime.clearJob({ jobId: string }): Promise<void>;
```

Native job 状态：

```ts
type NativeJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

interface NativeJobRecord {
  jobId: string;
  status: NativeJobStatus;
  createdAt: number;
  updatedAt: number;
  request?: {
    url: string;
    method: string;
  };
  response?: {
    statusCode: number;
    headers?: Record<string, string>;
    body?: string;
  };
  error?: string;
}
```

Android 侧建议：

- Kotlin；
- OkHttp；
- ForegroundService；
- NotificationManager；
- app-specific files 保存 job json；
- 第一版不引入 Room，降低复杂度。

本地文件结构：

```text
files/native-jobs/{jobId}.json
files/native-jobs/{jobId}.result.json
```

---

### 5.3 Foreground Service

用于降低后台任务被杀概率。

通知策略：

#### 聊天生成中

```text
SullyOS 正在生成回复
某某正在回应你
```

#### 通用长任务

```text
SullyOS 正在处理任务
完成后可返回查看
```

#### 后续通话中

```text
正在与某某通话
```

权限 / Manifest 关注点：

```xml
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
```

如果以后真后台通话再考虑：

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
```

第一轮主要使用 `dataSync` / generic foreground service，避免过早碰后台麦克风复杂度。

---

### 5.4 JS Native Runtime 封装

新增：

```text
utils/runtime/nativeRuntime.ts
utils/runtime/nativeJobQueue.ts
```

职责：

- 判断是否 APK；
- 检查插件是否可用；
- 提供 `enqueueAndWait`；
- 统一 timeout / poll；
- drain completed native jobs；
- Web fallback。

示意：

```ts
export async function runHttpViaRuntime(req: RuntimeHttpRequest) {
  if (!isNativeRuntimeAvailable()) {
    return runViaSafeFetchJson(req);
  }
  const job = await NativeRuntime.enqueueHttpJob(...);
  return await waitNativeJob(job.jobId);
}
```

---

### 5.5 Chat Pending Job

新增聊天生成任务状态层。

建议文件：

```text
utils/runtime/chatJobs.ts
```

数据结构：

```ts
interface ChatGenerationJob {
  id: string;
  charId: string;
  userMessageId?: number;
  nativeJobId?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  createdAt: number;
  updatedAt: number;
  requestHash?: string;
  error?: string;
}
```

存储位置：

- 优先 IndexedDB / existing DB；
- 第一版可以先 localStorage 镜像，但最终应进入 DB，方便恢复和清理。

用户发消息后流程：

1. 用户消息立即落 DB；
2. 创建 `ChatGenerationJob`；
3. 构造原有 request body；
4. APK 下交给 Native Runtime；
5. 成功后写 assistant 消息；
6. 标记 completed；
7. 失败/中断标记 failed/interrupted。

恢复时流程：

1. App 启动 / resume；
2. 查 pending chat jobs；
3. 查 native job；
4. completed → 补 assistant 消息；
5. failed → 标记 failed，写开发者/系统日志，不插入聊天；
6. running 超时 → interrupted，等待后续无感重试策略。

---

### 5.6 Chat 请求接入点

目标：不要大改 prompt 构造，只替换最终发送方式。

当前主要关注：

```text
hooks/useChatAI.ts
utils/safeApi.ts
utils/chatRequestPayload.ts
utils/activeMsgClient.ts（注意不要乱动）
```

改造目标：

```ts
sendChatCompletionViaRuntime({
  url,
  headers,
  body,
  timeoutMs,
  meta,
  fallbackToSafeFetch: true,
})
```

APK + Native Runtime 可用：

```text
Native Job Queue
```

否则：

```text
原 safeFetchJson
```

注意：

- 第一版可先对 native job 使用非流式整包返回；
- 但不要破坏现有流式 Web 路径；
- 如果用户开 stream，APK native 第一版可以降级整包，并提示/日志记录；
- 后续再补 native SSE。

---

### 5.7 Drain / Recovery

新增统一恢复入口：

```text
utils/runtime/recovery.ts
```

触发：

- App 启动；
- `App.addListener('appStateChange', active === true)`；
- `visibilitychange → visible`；
- `focus`。

职责：

```ts
recoverRuntimeState();
drainNativeJobs();
recoverChatJobs();
refreshCurrentChatIfNeeded();
```

恢复表现：

- 如果任务完成：无感补消息，刷新聊天；
- 如果任务失败：记录状态与开发者日志；
- 如果任务中断：不插入聊天消息，只记录状态与开发者日志；
- 如果仍在运行：保持现状，不额外打扰用户。

---

### 5.8 无感接续原则

默认不在聊天界面额外显示状态。

- 成功：直接补写真正 assistant 消息；
- 失败/中断：只记录本地 job 状态与开发者/系统日志；
- 不把 pending / interrupted 状态伪装成普通消息；
- 如以后要做重试入口，也必须很轻，且不进入聊天记录。

---

### 5.9 设置项

后续可加设置：

```text
APK 原生稳定模式
- 使用原生任务队列处理聊天生成
- 生成中显示前台通知，提高后台存活率
```

可选高级项：

```text
后台待命模式
- App 切后台时保持低优先级前台服务
- 更稳但更耗电，并会常驻通知
```

默认建议：

- 原生任务队列：APK 下开启；
- 生成中 Android 前台服务通知：开启（前台服务必须有系统通知，不是聊天 UI）；
- 后台待命常驻：默认关闭，由用户手动开。

---

## 6. 工程步骤

这些是实现顺序，不是用户分阶段测试体验。

### Step 1：Runtime Snapshot 底座

- 新增 runtime state 文件；
- 接 OSContext / PhoneShell 的 activeApp、activeCharacterId；
- 监听 appStateChange / visibilitychange；
- 保存 / 恢复基础状态；
- 不改变现有聊天请求。

### Step 2：Native Runtime 插件骨架

- 新增本地 Capacitor 插件；
- Android Kotlin 实现 `ping`；
- 实现 `startForegroundTask` / `stopForegroundTask`；
- 处理通知权限；
- 确保 APK build 通过。

### Step 3：Native HTTP Job Queue

- Android OkHttp；
- job 状态文件；
- enqueue / get / list / cancel / clear；
- 前台服务与任务状态联动；
- 不接 Chat，只做底层能力。

### Step 4：JS Runtime 封装

- `nativeRuntime.ts`；
- `nativeJobQueue.ts`；
- Web fallback；
- enqueueAndWait；
- drain completed jobs。

### Step 5：Chat Pending Job 存储

- 新增 chat job 记录；
- 用户消息落库后创建 pending job；
- job 状态可恢复。

### Step 6：接入普通聊天请求

- 在 `useChatAI.ts` 最终 API 调用点接 `sendChatCompletionViaRuntime`；
- 不重写上下文构造；
- APK 下 native；Web 下原逻辑；
- 保留 API 日志 / retry / error 可见性。

### Step 7：Recovery / Drain

- App 启动 / 回前台 drain native jobs；
- 完成的 native job 补 assistant 消息；
- 失败/中断 job 标记并写入开发者日志；
- 刷新当前聊天。

### Step 8：无感恢复收口

- 聊天页面默认无额外提示；
- 成功只补角色回复；
- 失败/中断只进本地状态与开发者/系统日志；
- 如后续做重试入口，必须轻量且不进聊天记录。

### Step 9：设置项与开关

- APK 原生稳定模式；
- 原生请求开关；
- 后台待命模式（可选，默认关闭）。

### Step 10：验证与清理

- 根项目 tests；
- 根项目 build；
- APK workflow；
- Android manifest 权限；
- 插件注册；
- 原生 job 文件清理；
- Web fallback；
- 无 Worker 强依赖。

---

## 7. 关键风险点

### 7.1 原生层不能直接写 WebView IndexedDB

解决：

```text
Native 写 job result 文件 → JS resume 后 drain → JS 写 SullyOS DB
```

### 7.2 流式响应

第一实现可以 native 非流式整包，保证稳。  
后续再做 native SSE：边读边存、JS 活着时发 delta、死了时保存最终结果。

### 7.3 Android 权限与前台服务限制

尤其 Android 13+ 通知权限、Android 14+ foreground service type。  
第一版不要碰后台麦克风，降低风险。

### 7.4 不要破坏现有 Web/PWA 行为

Native Runtime 必须是 APK 优先路径，Web fallback 原样保留。

---

## 8. 验收标准

最终整体验收时，应满足：

1. APK 下普通聊天可通过 Native Runtime 发起长请求。
2. 生成中切后台，通知栏显示 SullyOS 正在生成。
3. WebView 未死：回来继续/完成正常显示。
4. WebView 被杀但 native job 完成：重开后 drain 并补 assistant 消息。
5. native job 失败/中断：不污染聊天记录；本地状态和开发者日志可排查。
6. APP 重开能恢复基本现场：active app / active character / 草稿 / pending 状态。
7. 不依赖 Worker 才能完成常规聊天接续。
8. Web 版仍可走原 safeFetchJson，不要求原生插件。
9. 根项目测试通过。
10. 根项目 build 通过。
11. APK build 通过。

---

## 9. 当前仓库状态备注

- `ai-gateway-management-app/` 原型已按用户要求删除。
- 删除提交：`c23c83a Remove gateway management prototype`。
- 删除后已验证：
  - `vitest run`：109 passed / 1233 tests passed；
  - `pnpm run build`：通过。

---

## 10. 后续开工前提醒

开工前先确认：

- 当前分支是否最新；
- 是否需要先 merge upstream；
- 用户是否仍希望用 Kaka 身份提交；
- 是否需要 push / build APK；
- 如需用 PAT，只临时使用，不落盘。

---

## 11. 当前实现进度记录（2026-07-25 / commit d9ae4b4）

### 11.1 总体进度估算

按最终目标「APK Native Runtime：原生保活 + 常规聊天生成接续 + App 现场恢复」计算，当前约 **35%**。

这个百分比含义：

- 原生地基已经落地；
- 主聊天请求已经有 APK native 通路；
- 现场快照已有基础；
- 但“WebView 被杀后自动 drain 结果 / 失败后的无感重试策略 / 完整现场恢复”还没完成，所以还不能算完整体验闭环。

### 11.2 已完成

1. **本地 Capacitor 插件骨架**
   - 路径：`plugins/sully-native-runtime/`
   - Android 侧：`SullyNativeRuntimePlugin.java`、`SullyNativeRuntimeService.java`
   - 能力：`ping`、前台服务启动/停止、HTTP job enqueue/get/list/cancel/clear。

2. **Android Foreground Service 基础**
   - 生成任务时可显示前台通知，降低 APK 后台生成时被系统回收概率。
   - 第一版使用轻量实现，没有引入 OkHttp / Room 等额外重依赖。

3. **Native HTTP Job Queue 基础**
   - 原生层使用 `HttpURLConnection` 发请求。
   - job 状态写入 app 私有目录 `native-jobs/*.json`。
   - JS 可以轮询等待结果。

4. **JS Runtime 封装**
   - `utils/runtime/nativeRuntime.ts`
   - `utils/runtime/nativeJobQueue.ts`
   - 提供 native 可用性判断、enqueue + wait、job 查询等。

5. **主聊天回复接入 Native Runtime**
   - 修改点：`utils/safeApi.ts`
   - 仅对 `appName === '消息' && purpose === '聊天回复'` 的 `/chat/completions` 启用 native 路径。
   - 其它旁路任务仍走原 fetch / OSContext monkey-patch，避免一次性扩大影响面。

6. **采样参数兼容保留**
   - native 路径发送前会对已知拒绝采样参数的模型剥离参数。
   - native 返回 400 且识别为采样参数错误时，会剥离后重试。

7. **Native 路径 API 调用记录**
   - native 请求不会经过浏览器 fetch 拦截器，所以在 `safeApi.ts` native 分支里手动调用 `recordApiCall` 和 `appendDevDebugApiLog`。

8. **Runtime Snapshot 基础**
   - `utils/runtime/runtimeState.ts`
   - OSContext 已接入 activeApp、activeCharacterId、前后台时间、suspendedCall 快照。
   - App 重开时可恢复上次 activeApp 与挂起通话基础状态。

9. **验证**
   - `vitest run`：109 passed / 1233 tests passed。
   - `pnpm run build`：通过。
   - `npx cap add android && npx cap sync android`：能识别 `sully-native-runtime@0.1.0`。
   - GitHub Actions APK：成功。
   - Release：`v2026-07-25-11-52-76`。

### 11.3 未完成 / 下一步

1. **ChatGenerationJob 本地状态表**
   - 需要记录主聊天生成 job：queued/running/completed/failed/interrupted。

2. **Native completed job drain**
   - App 启动 / 回前台时读取 native job 结果。
   - 如果 WebView 被杀但 native job 已完成，需要无感补写 assistant 消息。

3. **无感恢复策略**
   - 正常情况下不在聊天界面额外提示。
   - 中断只进本地状态 / 开发者日志；如以后需要重试入口，也应做得很轻，不插入对话。

4. **失败和清理策略**
   - native job 超时、取消、失败后的状态同步。
   - 成功 drain 后清理 native job 文件。

5. **设置项**
   - APK 原生稳定模式开关。
   - 原生聊天请求开关。
   - 后台待命模式暂不默认开启。

6. **完整 resume 体验**
   - 当前 snapshot 只是基础恢复，不等于完整现场恢复。
   - 草稿、滚动位置、pending 状态还未全部接入。

### 11.4 当前提交与 APK

- 实现提交：`d9ae4b4 Add APK native runtime foundation`
- APK Release：`https://github.com/post090/SullyOS/releases/tag/v2026-07-25-11-52-76`
- 当前阶段关键词：**原生地基已完成，主聊天 native 请求已接入；接续闭环未完成。**

---

## 12. 当前实现进度记录（2026-07-25 / 本轮继续）

### 12.1 总体进度估算

当前约 **50%**。

比 35% 前进的部分：

- 已经有 ChatGenerationJob 本地状态；
- native job 完成后，App 启动 / 回前台会尝试 drain；
- 如果 WebView 被杀但 native 请求完成，恢复逻辑会把助手回复补写回聊天；
- 如果 native job 失败 / 超时，只记录本地 job 状态和开发者日志，不打扰正常对话。

仍未到完整体验的原因：

- 恢复时目前走“安全降级写入”：保存清洗后的普通 assistant 文本，不完整重放 `applyAssistantPostProcessing` 的 13 步后处理管线；
- 不做聊天 UI 卡片；恢复/中断应尽量无感，只在必要的系统/开发者日志里留下痕迹。
- 草稿、滚动位置等完整现场恢复还未做；
- 设置项还没做。

### 12.2 本轮新增

1. **ChatGenerationJob 本地状态**
   - 文件：`utils/runtime/chatJobs.ts`
   - 状态：`running / native_completed / consumed / recovered / failed / interrupted`
   - 记录 nativeJobId、charId、charName、createdAt、updatedAt。

2. **Native job drain / recovery**
   - 文件：`utils/runtime/recovery.ts`
   - OSContext 启动与回前台时调用 `recoverNativeChatJobs()`。
   - completed：解析 native response，提取 `choices[0].message.content`，清洗后写回 assistant 消息。
   - failed / stale：只记录本地状态与开发者日志，不插入聊天消息。

3. **主聊天 native job 消费闭环**
   - `safeApi.ts` native 分支创建 ChatGenerationJob。
   - native 请求成功后标记 `native_completed`，并在返回对象上附加隐藏字段 `__sullyChatJobId`。
   - `useChatAI.ts` 在后处理成功后 `markChatJobConsumed()`，清掉 native job 文件，避免下次启动重复恢复。
   - 如果 WebView 在 native 完成后、后处理完成前被杀，job 会保留为 recoverable，下一次启动可 drain。

4. **恢复触发点**
   - OSContext mount 时跑一次；
   - `visibilitychange → visible` 跑；
   - Capacitor `appStateChange.isActive === true` 跑。

### 12.3 当前恢复行为的边界

当前恢复是“保底恢复”，不是完全等价本地活着时的聊天后处理：

- 会保存普通文本回复；
- 会使用 `ChatParser.sanitize` 和 `chunkText` 清理/拆泡；
- 不会完整执行音乐、小红书、备忘录、任务监督等复杂副作用；
- 不会恢复流式预览；
- 不会恢复思考过程显示。

这是有意的保守做法：先保证“回复不丢”，再逐步把恢复路径做成更接近正常路径。

### 12.4 下一步优先级

1. 继续完善无感恢复：成功就补消息，失败只进日志，不插入对话。
2. 给 ChatGenerationJob 补 userMessageId / request fingerprint，支持一键重试上一条。
3. 将 recovery 从“普通文本保底写入”升级为可选择地重放更多后处理，但要避免副作用重复执行。
4. 设置页加入 APK 原生稳定模式开关。
5. 继续完善 runtime snapshot：草稿、滚动位置、当前聊天角色恢复。

---

## 13. 当前实现进度记录（2026-07-25 / 设置与系统日志）

### 13.1 总体进度估算

当前约 **55%**。

本轮推进：

- 设置页已有 APK 原生稳定模式开关；
- 主聊天原生请求可单独开关；
- native recovery 摘要会进入系统日志，不插入聊天记录。

### 13.2 本轮新增

1. **设置开关**
   - 位置：设置 → API 配置 → 高级（不建议修改）。
   - 仅 APK 下显示。
   - 「APK 原生稳定模式」控制整体 Native Runtime。
   - 「主聊天原生请求」只影响消息 App 的主回复。

2. **系统日志摘要**
   - recovery 有成功/失败时，会写入 OS 系统日志：`Native Runtime`。
   - 不会写入聊天对话。

### 13.3 下一步

1. 完整现场恢复：草稿、当前聊天、滚动位置。
2. native recovery 质量增强：恢复路径尽量更接近正常回复，但避免重复执行副作用。
3. 继续拆薄 `safeApi.ts` 里的 native 分支，保持代码干净。

---

## 14. 当前实现进度记录（2026-07-25 / 代码清理）

### 14.1 总体进度估算

当前约 **58%**。

本轮主要不是加新体验，而是把代码边界收干净：

- 从 `safeApi.ts` 拆出 `utils/runtime/nativeChatRequest.ts`；
- native 主聊天请求的判断、job 创建、采样参数剥离、完成/失败标记集中到 runtime 模块；
- `safeApi.ts` 只保留调度、重试和响应解析，后续维护风险降低。

### 14.2 验证

- safeApi 相关测试通过；
- `pnpm run build` 通过；
- `npx cap add android && npx cap sync android` 能识别 `sully-native-runtime@0.1.0`。

---

## 15. 当前实现进度记录（2026-07-25 / 恢复与现场收口）

### 15.1 总体进度估算

当前约 **65%**。

本轮做的是一组连续工作，不再碎片拆提交：

- 恢复角色选择时优先读取 runtime snapshot；
- ChatGenerationJob 记录 requestHash；
- native recovery 增加重复恢复保护，避免同一个 job 被补写多次；
- recovery 支持基础 emoji 恢复；
- recovery 成功 / 中断只写开发者生命周期日志，不插聊天系统提示；
- job 清理统一走 `saveChatGenerationJobs`，避免手写 localStorage key。

### 15.2 仍未完成

- 当前聊天滚动位置恢复；
- 更完整的草稿现场快照（目前仍主要依赖既有 `chat_draft_<charId>`）；
- recovery 仍是保底文本/emoji恢复，不执行复杂副作用；
- 更完整的重试策略。

---

## 16. 当前实现进度记录（2026-07-25 / 聊天现场恢复）

### 16.1 总体进度估算

当前约 **68%**。

本轮新增：

- Chat 页面按角色保存滚动位置；
- 重新进入同一角色聊天时，恢复 24 小时内的滚动位置；
- 保留既有草稿恢复逻辑；
- build 与 cap sync 通过。

### 16.2 边界

- 滚动位置只做 best-effort；如果消息高度变化较大，会尽量恢复到接近位置；
- 太旧的位置不恢复，避免用户误以为消息丢失；
- 如果有新回复到达，正常逻辑仍会滚到底部。

---

## 17. 当前实现进度记录（2026-07-25 / 状态存储测试）

### 17.1 总体进度估算

当前约 **69%**。

本轮补强：

- `ChatGenerationJob` 失败时会主动清理对应 native job 文件；
- 新增 `utils/runtime/chatJobs.test.ts`，覆盖 job 创建、可恢复队列、终态过滤、容量上限。

这主要是稳定性和可维护性补强，不改变用户可见体验。

---

## 18. 当前实现进度记录（2026-07-25 / 恢复清洗与快照测试）

### 18.1 总体进度估算

当前约 **70%**。

本轮补强：

- recovery 写回聊天前使用终态清洗，避免 XHS/READ_NOTE/HTML/think 等控制标签漏进聊天；
- 新增 runtime snapshot 测试，覆盖 activeApp、activeCharacterId、非法 appId、挂起通话恢复。

这主要提升“无感恢复”的干净度和可维护性。

---

## 19. 当前实现进度记录（2026-07-25 / 滚动快照收口）

### 19.1 总体进度估算

当前约 **71%**。

本轮补强：

- Chat 页面在 `visibilitychange → hidden`、`pagehide`、组件卸载时立即 flush 滚动位置；
- 进入角色时先准备要恢复的位置，再加载消息，降低异步竞态导致恢复失败的概率。

这继续完善 App 被切后台 / WebView 被回收后的现场恢复。

---

## 20. 当前实现进度记录（2026-07-25 / 现场恢复完成）

### 20.1 总体进度估算

当前约 **80%**，可以作为一个完整阶段交付给用户测试。

本轮完成：

- 聊天滚动快照同时保存 visibleCount；
- 重新进入角色时先恢复 visibleCount，再加载消息，避免用户看旧消息时只加载最近 30 条导致位置恢复失败；
- 切后台 / pagehide / 卸载时会立即 flush 滚动快照；
- 草稿继续使用既有 `chat_draft_<charId>`，配合 activeApp / activeCharacterId snapshot，完成常规现场恢复闭环。

### 20.2 当前剩余边界

- Native recovery 仍选择安全保底路线：只恢复可读文本/基础 emoji，不执行小红书、备忘录、任务等副作用；
- 这是有意保守，避免后台恢复时重复执行副作用；
- 真后台通话、语音持久化不是本阶段范围。

### 20.3 阶段验收

- APK 主聊天可走原生后台请求；
- 成功恢复无感补消息；
- 失败不污染聊天；
- 系统日志 / 开发者日志可排查；
- App / 角色 / 草稿 / 滚动位置有基础恢复；
- 代码边界集中在 `utils/runtime/`，`safeApi.ts` 已拆薄。
