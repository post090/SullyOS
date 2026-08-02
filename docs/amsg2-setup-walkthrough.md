# 主动消息 2.0 · 从零开始的部署手册

「主动消息 2.0」让角色到点自己给你发消息——App 关着、手机锁屏也能收到。

它需要一个只属于你的小后端（一个 Cloudflare Worker + 一个数据库）。这份手册把整个过程拆成六步，**全程只在网页上点，不用装任何东西、不用敲命令**。跟着做大约 15 分钟。

需要先准备好两个免费账号：**GitHub（用邮箱就能注册）** 和 **Cloudflare（用GitHub/邮箱就能注册）**。

> 没有 GitHub 账号也能装，看文末的[附录 · 不用 GitHub 怎么装](#附录--不用-github-怎么装)——那条路只要 Cloudflare 一个账号。

---

## 第一步 · 把后端仓库 fork 一份

1. 打开 <https://github.com/Tosd0/sullyos-workers>
2. 点页面右上角的 **Fork** → 保持默认 → **Create fork**

完成后你的账号下就多了一个同名仓库。以后上游有更新，你回到这个页面点一下 **Sync fork** 就行，Cloudflare 会自动重新部署。

---

## 第二步 · 建一个数据库

角色的定时任务要存在数据库里。

1. 打开 <https://dash.cloudflare.com> 并登录
2. 左侧菜单 **Storage & databases** → **D1 SQLite Database**
3. 右上角 **Create Database**
4. **Name** 填 `sullyos-amsg`，其余保持默认，点 **Create**
5. 建好后会自动跳进这个库的 Overview 页。页面上方有一串像 `6d726bb3-6ea3-45dd-80d8-72ad6bd49446` 的编号，这就是 **Database ID**。点它右边的复制按钮，先存在记事本里，下一步要用。

> 表结构不用管，后面在 SullyOS 里点「连接」时会自动建好。

---

## 第三步 · 用刚才的仓库创建 Worker

1. Cloudflare 左侧菜单 **Compute** → **Workers & Pages**
2. 右上角 **Create application**
3. 选 **Continue with GitHub**（第一次用会跳到 GitHub 让你授权，同意即可）
4. 在出现的仓库列表里选中第一步 fork 的 **sullyos-workers**，点右下角 **Next**
5. 页面往下滚，进入 **Set up your application**，按下面填：

   | 位置 | 填什么 |
   |------|--------|
   | Project name | `sullyos-amsg` |
   | Build command | `sh ./deploy-prepare.sh` |
   | Deploy command | 保持默认的 `npx wrangler deploy` |

6. 点下方的 **Advanced settings** 展开，继续填：

   | 位置 | 填什么 |
   |------|--------|
   | Path | `/amsg` |
   | API token | 下拉选 **Create new token**，然后在出现的 **API token name** 里随便起个名字（比如 `sullyos-amsg build token`）；它会显示「A new token will be created automatically」 |
   | Variable name | `D1_DATABASE_ID` |
   | Variable value | 粘贴第二步复制的那串 Database ID |

   > Variable value 旁边有个 **Encrypt** 按钮，**不要点**——这个值需要在构建时被读出来。

7. 点右下角 **Deploy**

页面会跳到构建进度。**这个页面不会自动刷新**，看起来一直卡在 Initializing 是正常的，手动刷新一下就能看到真实状态。顺利的话 30 秒左右完成，日志里会出现这两行：

```
[deploy-prepare] 已把 D1 database_id 填进 wrangler.toml。
env.DB (sullyos-amsg)   D1 Database
```

![构建成功](./images/amsg2-setup/build-success.png)

> 数据库绑定和「每分钟检查一次」的定时触发器都写在仓库里，会自动带上，不用手动加。

---

## 第四步 · 填钥匙（Secrets）

这一步要在 SullyOS 和 Cloudflare 之间来回一次，先把 SullyOS 那边的值生成出来。

### 4a. 在 SullyOS 里生成两组值

打开 SullyOS → 底部齿轮 **系统设置** → 往下滚到最底部。

**先做「推送凭据 (VAPID)」**（这是浏览器推送用的签名密钥，全站共用一对）：

1. 点标题右边的小箭头展开 → 点 **生成 VAPID 密钥对 →**
2. 弹窗里点 **生成新密钥对**，会出现「VAPID 公钥」和「VAPID 私钥」两段
3. 点 **保存**
4. 再点开一次，用每一栏右上角的 **复制** 分别把公钥、私钥存到记事本

**再做「主动消息 2.0」**：

1. 点这一节右边的 **配置**
2. 弹窗里点 **部署 Worker（第一次用先做这个）** 右边的 **展开**
3. 找到 **AMSG_MASTER_KEY** → 点 **生成并复制**，屏幕上会显示 `AMSG_MASTER_KEY=` 加一串 64 位字符，整行存进记事本
4. 往下滚到 **共享密钥（可选）** → 点右边的 **随机**，它会生成一串密码自动填进输入框，下方显示 `AMSG_SERVER_TOKEN=` 开头的整行并复制到剪贴板。**这一串等下也要填到 Cloudflare**，同样整行存进记事本（输入框是密码框看不见内容，下方那行就是给你抄的）

> 「共享密钥」的作用：填了以后，别人光知道你的 Worker 地址也调不动它。

### 4b. 回 Cloudflare 填进去

1. 回到 Cloudflare 的 Worker 页面（Workers & Pages → `sullyos-amsg`）
2. 顶部选 **Settings**
3. 最上面一块就是 **Variables and secrets**，点右边的 **+ Add**
4. 右侧滑出的面板里，每一条都是「Type / Variable name / Value」三格。记事本里 `变量名=值` 那样的整行可以直接粘进去，Cloudflare 会自动拆开填好名字和值两格。填完一条点下面的 **Add variable** 加下一条，一共五条：

   | Type | Variable name | Value |
   |------|---------------|-------|
   | Secret | `AMSG_MASTER_KEY` | 4a 生成的那串 64 位字符 |
   | Secret | `VAPID_PUBLIC_KEY` | VAPID 公钥 |
   | Secret | `VAPID_PRIVATE_KEY` | VAPID 私钥 |
   | Text | `VAPID_EMAIL` | `mailto:你的邮箱` |
   | Secret | `AMSG_SERVER_TOKEN` | 4a 那串「共享密钥」 |

5. 五条都填完，点右下角 **Deploy**

> ⚠️ VAPID 那两条**必须**和 SullyOS 面板里的是同一对。整个站点只有一个浏览器推送订阅，Worker 用别的密钥对去签名，推送会被浏览器直接丢掉——表现就是「哪儿都显示正常，就是收不到消息」。

填完可以顺手确认两件事（都在同一个 Settings 页往下滚）：

- **Trigger events** 里有一条 `Cron / scheduled() / * * * * *`
- 顶部 **Bindings** 标签里有一个名为 `DB` 的 D1 database

### 4c. 复制 Worker 地址

回到 Worker 的 **Overview** 页，标题下面那个 `https://xxx.workers.dev` 就是地址，复制它。

---

## 第五步 · 回 SullyOS 连上

**系统设置** → **主动消息 2.0** → **配置**，滚到「当前状态」这一块：

1. **WORKER 地址** 粘贴上一步复制的地址
2. **共享密钥（可选）** 确认里面就是 4a 生成的那串（如果空了就重新粘一次）
3. 点 **连接并启用**

右上角变成绿色的 **已连接** 就成功了——数据库表也是这一下自动建好的。

4. 继续往下，点 **开启通知与推送**，浏览器会弹出通知权限请求，选「允许」

「通知权限」显示 **已开启** 之后，后端部分就全部完成了。

---

## 第六步 · 给角色排第一条主动消息

1. 回到桌面，进入任意角色的聊天页
2. 点输入框左边的 **＋**
3. 在弹出的功能面板里找到 **主动消息 2.0**（面板有好几页，可以左右翻）
4. 把 **启用主动消息 2.0** 的开关打开，下面就会出现任务列表和新建表单

![任务面板](./images/amsg2-setup/task-panel.jpg)

新建一个任务要选三样东西：

**① 消息怎么来**

| 类型 | 说明 |
|------|------|
| 固定 | 到点直接发你写好的那段话，不经过 AI |
| 自动 | 到点让角色按人设和最近的聊天自己想一句 |
| 提示词 | 你给个方向（比如「提醒我喝水」），角色围绕它自由发挥 |

**② 什么时候发**

「首次发送时间」选日期时间，「重复方式」选 一次 / 每天 / 每周。

**③ 到点时如果你正在聊天怎么办**（选「自动」或「提示词」时才会出现）

| 选项 | 行为 |
|------|------|
| 自动作废 | 你刚刚还在跟角色聊，这条就不发了，避免答非所问 |
| 强制发送 | 闹钟型，不管你在不在聊都照发 |

填好点 **新建任务**。到点后消息会以系统通知的形式弹出来，同时落进聊天记录里：

![收到的主动消息](./images/amsg2-setup/received-messages.jpg)

任务列表里每条都能单独 **编辑** 或 **取消**。

---

## 出问题时怎么查

**排好的任务到点没反应**

1. Cloudflare → 你的 Worker → **Settings** → 往下找 **Trigger events**，确认有 `* * * * *` 那条。没有的话：连仓库装的多半是第三步 Path 填错、没指到 `amsg` 目录；照附录手动贴代码装的，就是那条定时触发器还没加（附录 E）。
2. 还是不行就开日志：同一页往下找 **Observability** → **Logs** 那一行右边的铅笔 → 把开关打开 → **Deploy**。之后到 顶部 **Observability** 标签就能看到每分钟一条的 `* * * * *`，点开能看到那次运行有没有报错。

**看起来都正常，就是收不到消息**

九成是 VAPID 对不上。回第四步核对：Cloudflare 里的 `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` 必须和 SullyOS「推送凭据 (VAPID)」面板里显示的完全一致。改过之后要在 SullyOS 里重新点一次「开启通知与推送」。

**SullyOS 里点「连接」失败**

- 地址是不是抄全了（要带 `https://`，末尾不要多斜杠）
- 「共享密钥」和 Cloudflare 里的 `AMSG_SERVER_TOKEN` 是不是一模一样
- 直接在浏览器打开 `你的地址/capabilities`：如果返回一段 JSON，说明后端活着；如果返回 `INVALID_CLIENT_TOKEN`，说明后端也活着，只是这个地址需要密钥才能访问——两种都算正常，问题在密钥没对上。什么都打不开才是后端没起来，去看第三步的构建日志。

**打开 `你的地址/capabilities` 返回 `INTERNAL_ERROR`**

后端起来了，但钥匙没填全——最常见的是漏了 `AMSG_MASTER_KEY`。回第四步核对那几条。想知道到底缺哪个，去 Worker 顶部的 **Observability** 标签，日志里会直接写出来（形如 `config.masterKey is required`）。

**构建失败，日志里写 `D1_DATABASE_ID 是空的`**

那个变量没设，或者设的时候点了 Encrypt。回到 Worker → **Settings** → 往下找 **Build** → **Variables**，加一个 `D1_DATABASE_ID`（普通变量，不加密），值是第二步的 Database ID，然后重新部署。

---

## 以后怎么更新

上游发了新版本之后：

1. 打开你 fork 的那个仓库
2. 点 **Sync fork** → **Update branch**

完事。Cloudflare 检测到新提交会自动重新部署，你填的密钥、数据库绑定、Database ID 都不会丢。

> 照附录手动贴代码装的，更新方式见附录最后一节。

---

## 附录 · 不用 GitHub 怎么装

主线那条路先 fork 一个仓库，图的是以后更新只用点一下 **Sync fork**。没有 GitHub 账号也能装：后端代码就是一个文件，从网页上复制下来、贴进 Cloudflare 的在线编辑器就行（GitHub 上的公开文件不登录也能看、也能复制）。代价是**以后每次更新都要重新复制粘贴一遍**。

这条路只替换主线的第一步和第三步，其余步骤——第二步建数据库、第四步填钥匙、第五步连回 SullyOS、第六步排任务——完全一样。

> **先看设备**：这份代码有二十多万个字符。电脑上复制粘贴很轻松；手机浏览器就不一定吃得住，卡住或者贴不进去都有可能。手边只有手机的话，注册个 GitHub 账号走主线反而更省事——那边手机上要做的只是点两下 **Fork**。

### A · 建数据库

照第二步做，但**不用复制 Database ID**：这条路是在面板上按名字挑库，不填 ID。

### B · 建一个空 Worker

1. Cloudflare 左侧 **Compute** → **Workers & Pages** → 右上角 **Create application**
2. 选 **Start with Hello World!**（这一屏上面那两个是连 GitHub / GitLab 的，跳过）
3. **Worker name** 填 `sullyos-amsg`——这个名字就是你以后的地址：`sullyos-amsg.xxx.workers.dev`
4. 点右下角 **Deploy**

十几秒就好。这会儿它还只会回一句 Hello World，下一步把真代码换进去。

### C · 复制后端代码

浏览器打开（不用登录）：<https://github.com/Tosd0/sullyos-workers/blob/main/amsg/worker.bundle.js>

文件上方那排按钮里，**Raw** 右边那个「两个方块叠在一起」的图标就是复制，点它，整份代码就进剪贴板了。

### D · 贴进 Worker

1. 回到刚建好的 Worker 页面，点右上角 **Edit code**
2. 编辑器里打开的是一个 `worker.js`，在代码区里点一下，全选（Cmd / Ctrl + A）删掉
3. 粘贴刚才复制的代码
4. 点右上角的 **Deploy**

### E · 补上数据库和定时器

主线那条路里，数据库绑定和「每分钟检查一次」的定时触发器写在仓库的配置文件里、会自动带上。手动贴代码没有那个文件，这两样要自己加。

**数据库绑定**：Worker 页面顶部 **Bindings** → **Add binding** → 左边列表选 **D1 database** → **Add Binding**，然后：

| 位置 | 填什么 |
|------|--------|
| Variable name | `DB`（就这两个字母，别改） |
| D1 database | 下拉选 A 步建的那个库 |

再点 **Add Binding**。加好后表格里会出现一行 `D1 database / DB / 你的库名`。

**定时触发器**：Worker 页面 **Settings** → 往下找 **Trigger events** → **Add** → 选 **Cron triggers**，然后：

- **Schedule** 那栏：Execute Worker every → 单位选 **Minute(s)**，数字填 `1`
- 也可以切到 **Cron expression** 直接填 `* * * * *`，一个意思

点 **Add**。加好后 Trigger events 表格里会出现一条 `Cron / scheduled() / * * * * *`。

这两条加完，回主线第四步填钥匙。

> 这样建出来的 Worker，日志默认就是开的——出问题直接去顶部 **Observability** 标签看，不用再去打开什么开关。

### 这条路以后怎么更新

上游发了新版本之后，重做 C、D 两步：复制新代码 → **Edit code** → 全选替换 → **Deploy**。

数据库绑定、定时触发器、填过的钥匙都不会跟着丢，换掉的只有代码。
