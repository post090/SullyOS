# instant-push Worker

基于 `@rei-standard/amsg-instant` 的自部署 Cloudflare Worker。
收到前端的 POST 请求后，调用你自己的 OpenAI 兼容 LLM，把回复分句后逐条发成 Web Push 通知。
零数据库、零 cron，HTTPS 已保护传输。

---

## 文件说明

| 文件 | 说明 |
|------|------|
| `src/index.ts` | Worker 源码入口（极薄封装） |
| `wrangler.toml` | CF Worker 部署配置 |
| `package.json` | 子目录依赖声明 —— CF Workers Builds 用它跑 `npm install + wrangler deploy` |
| `worker.bundle.js` | 已打包好的 Worker，**仅备用方案**：复制到 CF 控制台直接部署 |

---

## 阶段 1：生成 VAPID 密钥对

打开 **SullyOS → 设置 → Instant Push → 配置**，点"生成新密钥对"按钮。

- 页面上会显示公钥（自动填入表单）和**一次性显示的私钥**
- **立即复制私钥**，关闭弹窗后私钥消失，不可恢复
- 公钥会自动填进表单，等下第 3 步一起贴进 CF 后台

---

## 阶段 2：在 Cloudflare 部署 Worker

### 主方案：用 Git URL 克隆（推荐）

1. 访问 [dash.cloudflare.com](https://dash.cloudflare.com/) → Workers & Pages → Create → Worker
2. 选择 **Clone a public repository via Git URL**
3. Git repository URL 填：
   ```
   https://github.com/qegj567-cloud/SullyOS/tree/master/worker/instant-push
   ```
   （URL 末尾的 `worker/instant-push` 子目录路径必须保留，CF 才知道用哪一份 wrangler.toml）
4. CF 会自动 `npm install` + `wrangler deploy`，部署成功后记录 Worker 地址：
   `https://instant-push.<你的账号>.workers.dev`
5. 之后只要上游仓库 push 新版，CF Workers Builds 会自动重新部署，**不用再手动同步**

### 备用方案：复制 `worker.bundle.js`

CF 后台连不上 GitHub、或者你 fork 了私有副本不想接 OAuth 时用这条路：

1. 同样在 CF 后台 Create → Worker，给 Worker 起名（如 `instant-push`），点 Deploy 先建一个空 Worker
2. 进入 Worker 详情页 → **Edit code**（在线编辑器）
3. 把 `worker/instant-push/worker.bundle.js` 的全部内容粘贴进去，覆盖原有代码
4. 点 **Deploy** 完成部署
5. 同样记录 Worker 地址

> ⚠️ 备用方案部署的是 commit 时的 bundle 快照，要拿最新代码就得重新粘贴一次。主方案才会自动跟最新。

---

## 阶段 3：配置环境变量

在 Worker 详情页 → **Settings → Variables and Secrets** 里依次添加：

### 必填（2 个）

| 变量名 | 来源 |
|--------|------|
| `VAPID_PUBLIC_KEY` | 阶段 1 生成的公钥 |
| `VAPID_PRIVATE_KEY` | 阶段 1 生成的私钥（类型选 **Secret**） |

### 可选（2 个）

| 变量名 | 说明 |
|--------|------|
| `VAPID_EMAIL` | 留空则默认 `mailto:noreply@example.com`，填什么都行 |
| `AMSG_CLIENT_TOKEN` | 防止别人扫到你的 Worker URL 滥用 CF 配额；前端填相同的值 |

配置完重新 Deploy 一次让 secrets 生效。

---

## 阶段 4：测试

回到 **SullyOS → 设置 → Instant Push → 配置**：

1. 填入 Worker URL（阶段 2 末尾记录的地址）
2. 确认公钥已自动填入
3. 如果配了 `AMSG_CLIENT_TOKEN`，在"Client Token"字段填入相同的值
4. 点**发送测试推送** —— 浏览器会先申请通知权限，然后调用你的 LLM 生成一句话推送过来
5. 系统通知里收到消息 = 链路全通

---

## 常见问题

**Q：手机上收不到推送？**
iOS 要求把 SullyOS 以 PWA 方式安装到主屏幕才能收 Web Push；Safari 浏览器内的标签页不支持。
安卓国行手机若无 Google 服务（GMS），Web Push 通道不通，换 Chrome 桌面版测试确认链路，App 内通知走 Capacitor 本地通知不受影响。

**Q：想暂停推送怎么办？**
在 CF 后台把 Worker 暂停（Pause）即可，前端数据不丢。重新启用后恢复正常。

**Q：怎么彻底删除？**
CF 后台 → Workers & Pages → 找到该 Worker → Settings → Delete。
前端在 SullyOS → 设置 → Instant Push 关掉开关即可停止发起请求。

**Q：LLM 调用费用谁出？**
你自己在前端配置的 Chat API（apiKey）—— Worker 用你传进来的 key 和 apiUrl 调 LLM，Worker 本身不持有任何 key。

**Q：CF 的 Git 克隆构建失败、提示找不到依赖？**
检查 Git URL 末尾是否带上了 `tree/master/worker/instant-push` 子目录路径。CF 必须看到子目录里的 `package.json` 和 `wrangler.toml` 才能构建。
