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
- 如果原生任务也失败/被杀：显示明确的“上次生成中断，可重试”。
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
5. failed → UI 显示可重试；
6. running 超时 → interrupted。

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

UI 表现：

- 如果任务完成：补消息，刷新聊天；
- 如果任务失败：显示轻量提示；
- 如果任务中断：显示“上次回复中断，可重试”；
- 如果仍在运行：显示“正在后台生成回复”。

---

### 5.8 UI 接续提示

聊天界面应能显示：

```text
正在后台生成回复……
```

或：

```text
上次回复生成中断
[重试] [忽略]
```

注意：

- 不要把 pending 状态伪装成普通 assistant 消息；
- 避免污染聊天历史；
- 成功后再写真正 assistant 消息。

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
- 生成中通知：开启；
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
- 失败/中断 job 标记并提示；
- 刷新当前聊天。

### Step 8：UI 状态提示

- 聊天页面显示后台生成 / 中断 / 重试；
- 不污染聊天历史。

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
5. native job 失败/中断：聊天 UI 显示可重试提示。
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
