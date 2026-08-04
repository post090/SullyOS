# TIAO-Capacitor：AMSG2 Android 原生推送

本分支只用于条条自己的 Capacitor Android 构建。`master` 的普通浏览器/PWA 构建默认
没有原生桥：只有 `vite build --mode capacitor` 读取 `.env.capacitor` 后，才动态加载
`utils/nativeAmsgPush.ts`。

实际的原生壳保留在 `D:\CHICK\CHICK2`。不要再把整份 SullyOS 源码复制覆盖过去；这样
容易覆盖 CHICK2 中的图标、原生配置和其他本地改动。专用脚本只替换可再生成的 `dist`，
再同步 Capacitor 插件并构建 APK。

## Firebase

1. 在 Firebase 项目中添加 Android App，包名必须是 `com.aetheros.simulator`。
2. 下载 `google-services.json`，放到
   `D:\CHICK\CHICK2\android\app\google-services.json`。
   该文件已被 Android `.gitignore` 排除，不提交。
3. 在项目设置 → 服务账号创建一个服务账号密钥 JSON。不要提交这份 JSON。

## Cloudflare AMSG Worker

在现有 AMSG Worker 的 Variables and Secrets 增加：

- `FCM_PROJECT_ID`：服务账号 JSON 的 `project_id`。
- `FCM_SERVICE_ACCOUNT_EMAIL`：服务账号 JSON 的 `client_email`。
- `FCM_SERVICE_ACCOUNT_PRIVATE_KEY`：服务账号 JSON 的完整 `private_key`，包含 PEM 头尾。

后三项只有同时存在才启用 FCM。原来的 VAPID 可以继续保留；浏览器订阅仍走 Web Push，
`fcm:<registration-token>` 订阅才走 FCM HTTP v1。

## 构建

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sync-tiao-capacitor.ps1
```

只想同步、不生成 APK 时加 `-SkipAndroidBuild`。生成的 APK 位于：

`D:\CHICK\CHICK2\android\app\build\outputs\apk\debug\app-debug.apk`

本分支的 `.env.capacitor` 会为私有 App 预设
`https://amsg.noir2.cc.cd`。首次启动会申请通知权限，随后把 FCM token 登记到该 AMSG
Worker。普通生产构建不会包含这个地址。

## 隔离保证

- `VITE_AMSG_NATIVE_PUSH` 默认不存在时，不加载 `@capacitor/push-notifications` 动态模块。
- Worker 默认地址也只在 `VITE_AMSG_NATIVE_PUSH=true` 的 Capacitor 构建中读取。
- 没有本地 FCM token 时，`ActiveMsgClient` 完整沿用原 Web Push 登记路径。
- Worker 对普通 `https://...` PushSubscription 完整委托原 Web Push 发送器。
- 只有 endpoint 以 `fcm:` 开头才读取 FCM Secrets 并请求 Google FCM。
