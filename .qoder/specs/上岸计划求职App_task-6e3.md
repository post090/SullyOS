# 上岸计划 3.0：驾驶舱 + 语音面试 + 智能简历档案（修订版）

## 已拍板决策

主页走**海岸隐喻主题**（离岸→上岸漏斗）；语音面试**复用 CallApp 通话管线**、**严肃面试官/轻松陪练两档可切**，视频占位「研发中」（等上游视频通话落地复用）；竞争力档案**用户级单份**；删掉工作台所有单聊入口和右下角 FAB；模拟面试与岗位卡解耦。**本轮新增**：练习附加提示词可存命名模板；**取消自定义临时岗位**（目标只剩综合默认/岗位库）；设置中心加注入控制（简历原文 vs 解析结果三选一等）；主页备注单聊可开上岸计划模式；岗位 tab 加搜索/筛选/排序/分组；**模拟面试独立 API 三路（对话/TTS/STT，复用 ApiConnectionPicker 站点模板）+ 音频理解模型分析说话状态**；**全局「其它 API」区双层化改版（自设简洁视图主展示 + 官方长表单折叠）**；**CallApp 改用通话自己的设置弹窗（STT/音频理解模型两种转写方案同款可配）**。

**设置边界原则（本轮重划 v2）**：**单聊设置 → 上岸计划模式区块** = 模式开关 + 单聊上下文注入控制（管这个模式在单聊里往 prompt 塞什么）；**上岸计划 App 设置中心** = 模拟面试域（练习模板、面试独立 API、音频分析、面试上下文注入）；**角色 API 中枢（CharApiHubModal）** = 该角色在上岸计划 App 内对话用哪个模型（jobHuntApiOverride）。注入配置存储仍是用户级全局一份（简历/档案/岗位是用户级数据），单聊设置里编辑的是同一份，UI 注明全局生效。

**状态：留档待开发**——本计划今日仅存档，不启动实施；连同已推送未 dispatch 的 de6c625（历史卡合并+跳转）一起，等正式开工时统一构建 APK。

## 一、数据模型（types.ts + utils/db.ts）

- `JobPosition` 扩展：`jd?: string`（JD 正文，进 prompt 前截断+脱敏）、`hrName?: string`（**仅本地展示，同 companyNameLocal 待遇，永不进 prompt**——真实人名是隐私铁律）、`projectName?: string`（可进 prompt，面试出题素材）。
- 新增用户级单份 `JobProfile`（id 固定 `'main'`）：`direction`（求职方向一句话）、`strengths: { id; text; source: 'ai'|'user'|'char' }[]`（竞争点）、`gaps: { id; text; kind: 'strategy'|'resume'; source }[]`（可改进点，分求职策略层/简历写法层）、`resumeDigest`（简历结构化摘要 markdown：教育/经历/项目/技能）、`updatedAt`。
- db.ts：`STORE_JOB_PROFILE` 新表 + DB 版本号 +1 + onupgradeneeded 建表；`getJobProfile/saveJobProfile`。
- `JobHuntSettings`（localStorage `os_jobhunt_settings`）扩展：`inject: { resume: 'none'|'raw'|'digest'; profile: boolean; positions: boolean }`（**单聊**注入，默认 digest/true/true，编辑入口在单聊设置）+ `interviewInject: { profile: boolean; resumeDigest: boolean }`（**面试**出题素材注入，默认双 true，编辑在 App 设置）+ `practiceTemplates: { id; name; text }[]`（练习附加提示词命名模板）+ `api: { chat: ApiTriple|null; stt: ApiTriple|null; ttsProvider: 'follow'|TtsProvider; audio: ApiTriple|null; audioAnalysis: boolean; transcribeMode: 'stt'|'audioModel' }`（面试独立 API，null=跟随全局，默认全跟随、audioAnalysis 关、transcribeMode='stt'）。
- `CharacterProfile` 加 `jobHuntApiOverride?: ApiTriple`（角色级：该角色在上岸计划 App 内对话用的模型，编辑入口在角色 API 中枢）。

## 二、简历解析 + 竞争力分析（新建 utils/jobProfileGen.ts）

- `parseResumeIntoProfile(resume, apiConfig)`：照 assetGen callJsonLLM 模式（resilientFetch 120s+重试）。输入 = 脱敏 rawText 再过 codifyCompanies；输出 JSON：`{ direction, digest(教育/经历/项目/技能), strengths[], gaps: {strategy[], resume[]} }`，合并进 JobProfile（新条目标 source:'ai'，不覆盖用户手改的条目）。
- `buildInterviewCallContext(target, mode, profile, char, extraPrompt?)`：语音面试场景注入文本——面试官人设段（strict）/陪练段（coach）+ JD 或综合档案 + 出题规则（一次一题、口语化、可追问）+ 用户附加提示词段（练习模块偏好/扮演要求，放在最后）。
- 简历库每项加「解析进档案」按钮（loading 态）；解析完成 toast + 驾驶舱档案卡刷新。

## 三、JOB 指令扩展 + 注入控制（jobHuntParser.ts + jobDirectives.ts + chatPrompts）

- 新指令（照现有原子指令风格）：`[[JOB_EDGE_ADD:文本]]`、`[[JOB_EDGE_DEL:关键词]]`、`[[JOB_GAP_ADD:strategy|resume|文本]]`、`[[JOB_GAP_DEL:关键词]]`、`[[JOB_DIRECTION:一句话]]`（改方向）。改=删+加，不单设 edit。
- `applyJobDirectives` 落 JobProfile（source:'char'）；聚合卡 `JobCardPayload` 加对应 jobKind，MessageItem 聚合卡渲染新行（绿点竞争点/橙点改进点）、`describeJobBatch` 同步。
- `JOB_COMMAND_GUIDE` 更新；`buildJobHuntPromptBlock` **按注入设置拼装**：竞争力档案段（inject.profile 开时：方向+竞争点+改进点）、简历段（inject.resume：none 不拼 / raw 拼脱敏原文截断 ~1500 字 / digest 拼 resumeDigest 截断 ~600 字）、岗位段（inject.positions 开时：岗位行带 projectName 和 JD 摘要截断 200 字）。hrName 永不出现。

## 四、驾驶舱主页（apps/JobHuntApp.tsx 工作台 tab 重做）

- **Hero 海岸区**：深蓝→浅蓝→沙白渐变，大字总览（在投 X · 面试中 Y · Offer Z），五段漏斗条（观望→投递→笔试→面试→上岸），毛玻璃质感。
- **下一步清单**：全岗位 nextStep 拉平成行动列表（点行跳岗位 tab）。
- **竞争力档案卡**：方向一行 + 竞争点绿 chips + 改进点橙 chips（带 strategy/resume 小标），点开编辑弹窗——条目增删改、方向编辑、chips 点击改文本。
- **模拟练习入口卡**：大按钮 → 练习设置弹窗（第五节）；下方保留面试记录列表。
- **单聊模式备注卡**（页底小字）：「日常想和角色聊求职？在单聊里开启上岸计划模式即可」——补上删掉跳转按钮后的路径说明。
- 删右下角 FAB（岗位 tab 头部加「+ 新建岗位」按钮补位）；删「和角色聊求职→去单聊」按钮、岗位卡「聊这个岗位→单聊」按钮、整个 showNewSession 弹窗。

## 五、模拟练习设置区（面试与岗位解耦）

- 新弹窗「练习设置」：①选角色（默认顶栏所选）②选目标：**综合模式**（默认，按 direction+档案出题）/ 岗位库任选（显示 code·title，有 JD 标记）——**自定义临时岗位已取消**③选形态：文字 / 语音 / 视频（disabled 灰卡「研发中 · 视频通话上线后开放」）④语音时选两档：严肃面试官 / 轻松陪练⑤**附加提示词**（选填 textarea：想练的模块、对角色的扮演要求）+ **模板管理**：下拉选已存模板、「存为模板」弹名字输入、模板可删；存 JobHuntSettings.practiceTemplates。
- 文字面试改造：`bootstrapInterview`/`buildSystemPrompt` 接受 `target: { kind: 'position'|'comprehensive'; positionId? }` + `extraPrompt?`，出题素材=JD 或综合档案；`JobSession` 加 `practiceTarget?` 元数据，`positionId` 允许空。
- 岗位卡上「模拟面试」按钮删除，统一走练习入口。

## 六、语音面试（CallApp 集成，照 openDateWithChar 先例）

- OSContext：`callAutoStart: { charId; sceneContext: string; sceneLabel?: string; apiOverride?: ApiTriple|null; sttOverride?: ApiTriple|null; ttsProviderOverride?: TtsProvider|null; audioAnalysis?: { api: ApiTriple; enabled: boolean } } | null` + `openCallWithChar(charId, scene)` + `consumeCallAutoStart()`（挂 context value）。
- CallApp 挂载 effect：检测 callAutoStart → 选中角色直接进 in-call；`requestAssistantReply` 把 sceneContext 拼在 coreContext 前，且 apiOverride 存在时 LLM 请求改用 override 的 baseUrl/key/model；sttOverride 存在时 sttCfg 改用 override（provider 固定 cloud）；ttsProviderOverride 覆盖 resolveTtsProvider 结果（密钥仍用全局那份，账号级不单配）；场景状态存本地 state，挂断即清。
- 开场白提示词在面试场景下换成「面试电话拨通，你先自报身份和岗位再开始」；sceneLabel 显示在通话界面顶部小字。
- 通话记录照旧落单聊（source='call'），挂断后日程修订钩子不动。

## 七、笔记本人工编辑 + 防误触

- viewingNote 弹窗加「编辑」→ 编辑态（标题 input + 正文 textarea）→ 保存 `DB.saveJobNote`。
- 删除按钮**撤离右上角 X 旁**：移到弹窗底部左侧红字「删除这篇笔记」（保留 confirm）。

## 八、岗位表单 + 多岗位浏览（分组/筛选/排序）

- 新建/编辑岗位弹窗加：JD textarea、HR 名（选填，标注仅本机）、项目名（选填）。
- 岗位卡：有 JD 时「查看 JD」展开/收起；hrName/projectName 小字行（hrName 标注仅本机可见）。
- **岗位 tab 浏览工具条**（岗位多时好用）：搜索框（匹配 code/title/公司/项目名）+ 阶段筛选 chips（观望/投递/笔试/面试/Offer/挂了，多选）+ 排序下拉（最近更新↓ / 阶段进度 / 公司名）+「按阶段分组」开关（开时各段折叠面板显示计数，默认展开非空段）。纯前端内存过滤排序，不动数据层。

## 九、设置体系（三处分工：单聊设置 / App 设置中心 / 角色 API 中枢）

- **单聊设置 → 上岸计划模式区块**：模式开关保持原位；开关打开时下方展开单聊上下文注入三项（简历不注入/原文/解析结果 segmented + 竞争力档案开关 + 岗位摘要开关），存全局 jhSettings.inject，小字注明「注入选项全局生效，影响所有开启此模式的角色」。
- **App 设置中心（renderSettingsModal）= 模拟面试域**：①「练习模板」区：列出 practiceTemplates（名字+预览）可删，新建入口在练习设置弹窗（存为模板）②「面试上下文」区：interviewInject 两开关（出题吃不吃竞争力档案/简历摘要）③「面试 API」区（复用 ApiConnectionPicker）：对话 LLM（「跟随主 API」）、云端 STT（「跟随全局 STT」）、TTS 服务商四选一 chips（密钥沿用全局）、音频理解模型 Picker + 「说话状态分析」开关 + 「转写方式」STT/音频模型一体 segmented（第十节）。
- **角色 API 中枢（CharApiHubModal）**：现有三块（聊天主 API/热点图片/主动消息副 API）后加第四块「上岸计划对话」：ApiConnectionPicker（followLabel「跟随聊天主 API」），存 character.jobHuntApiOverride，onSave 一并落 updateCharacter。
- 排查现状：若单聊设置里已有其它求职域配置项，按上述分工归位。

## 十、面试独立 API 三路 + 音频说话状态分析

- **对话 LLM 优先级链**：普通/岗位会话 = char.jobHuntApiOverride > char.chatApiOverride > 全局 apiConfig；面试会话（含语音）= jhSettings.api.chat > char.jobHuntApiOverride > char.chatApiOverride > 全局（面试是场景属性，优先于角色属性）；语音面试经 callAutoStart.apiOverride 透传给 CallApp（第六节）。
- **STT**：`jhSettings.api.stt` 存在时，JobHuntApp 文字面试的语音输入和语音面试的 sttCfg 都改用它（provider 固定 cloud）；未配跟随全局 stt* 字段。
- **TTS**：仅服务商选择可 override（follow/minimax/fishaudio/elevenlabs），密钥是账号级沿用全局——不单配 key。
- **转写方式两档（transcribeMode）**：
  - `'stt'`（默认，双轨）：专职 STT 秒出转写走主链路，音频模型后台异步分析——转写快、分析失败不影响面试。
  - `'audioModel'`（一体）：录音 Blob 直接交音频模型，一次调用同时返回 `transcript` + 分析——少配一路 STT，代价是转写要等完整 LLM 推理且依赖单点；仅在配了音频模型时可选，一体模式下面试内不再调 STT 识别接口（录音仍用 MediaRecorder 那套管线）。
- **说话状态分析（音频多模态，全仓首例）**：
  - 硬约束：仅云端 STT 模式可用（系统识别时麦被 RecognitionService 占用拿不到音频流），开关在非云端 STT 时灰显并提示。
  - `speechToText.ts`：`SttCallbacks` 加可选 `onAudioBlob?: (blob: Blob) => void`，startCloud 的 recorder.onstop 里在识别之外额外回传录音 Blob（不影响现有调用方，未传则零开销）。
  - 新建 `utils/interviewAudioAnalysis.ts`：`analyzeAnswerAudio(blob, api, questionText, wantTranscript?)` —— Blob 转 base64，POST OpenAI 兼容 chat/completions，content 用 `input_audio` 内容块（format 按录音 mime 填 webm/mp4），输出 JSON：`{ transcript?: string, clarity: 1-5, pace: 'ok'|'fast'|'slow', confidence: 1-5, note: 一句话建议 }`（wantTranscript 仅一体模式传 true）；resilientFetch 120s+1retry，双轨模式下失败静默跳过不阻断面试，一体模式下失败提示重说。分析 prompt 只谈表达状态，不带岗位/公司信息。本地不转码，格式兼容性依赖所选服务商（推荐 Qwen-Omni 类支持 webm/opus 的，UI 小字提示）。
  - 消费链路：语音面试中每轮用户回答的 Blob 后台异步分析，结果存通话本地 state 并在界面出小卡（如「清晰度 4/5 · 语速偏快」，毛玻璃小浮条，可点收）；挂断时若有 ≥2 轮分析结果，汇总成一篇「面试表达复盘」自动落 JobNote 笔记本（逐题清晰度/语速/建议 + 总评）。
  - 隐私：录音只发往用户自己配置的音频 API，不落盘不上传其它任何地方，分析完即丢。

## 十一、全局「其它 API」区双层化改版 + 通话独立设置

- **其它 API 区改版（Settings.tsx，照主 API 双层先例：站点视图主展示 + 官方胶囊墙折叠）**：
  - 上层简洁视图：每个能力一张紧凑玻璃卡（STT / TTS / MiniMax 语音 / AceStep 写歌…），卡上只放当前状态一行（如「云端 · SenseVoice · 已配 Key」）+ 展开后的关键选择项；视觉对齐主 API 站点区（GlassSelect/chips，毛玻璃）。
  - **STT 卡升级**：云端模式下站点下拉（复用 deriveStations，选站带出 baseUrl+Key，也保留手填自定义）+ **模型预置可改下拉**（FunAudioLLM/SenseVoiceSmall · whisper-large-v3 · 自定义输入），替掉现在埋在长表单里的三个裸 input（现有 sttModel 手填框 L2599 废弃进折叠层）。
  - 官方长表单整体收进「详细配置（官方视图）」折叠面板，一个字段不删；底层数据不动（仍写 apiConfig 的 stt*/tts* 等字段），纯 UI 改版，两套视图写同一份数据。
- **CallApp 通话独立设置**：齿轮按钮从 `openApp(AppID.Settings)` 改为弹通话自己的毛玻璃设置弹窗（bottom sheet），存 localStorage `os_call_settings`：
  - 云端 STT Picker（ApiConnectionPicker，followLabel「跟随全局 STT」）+ 音频理解模型 Picker + 「转写方式」两档 segmented（专职 STT / 音频模型一体，与上岸计划同款交互）。
  - 普通通话的一体模式只做转写（transcript 进 draftInput），不做面试分析卡；录音仍走 MediaRecorder 管线，同样仅云端模式可用。
  - STT 取值链：callAutoStart.sttOverride（面试）> os_call_settings.stt > 全局 stt* 字段；转写方式链同理。
  - 弹窗底部留一行「更多全局 API 配置 → 系统设置」跳转（原跳转能力不丢）。

## 测试计划

- tsc --noEmit 零错误；pnpm build 通过；vitest run 既有测试不回归（4 项旧账失败除外）。
- 离线自测：指令解析新增五指令的正则单测脚本（.tmp 自测后删）；JobProfile 合并逻辑（AI 解析不覆盖 user/char 条目）；注入设置三态拼装结果（none/raw/digest 各验一次）；音频分析 payload 拼装（base64+input_audio 结构）离线验；其它 API 双层视图数据一致性（简洁视图改完折叠层读到同值）。
- UI 浏览器测试按约定跳过；提交推送 + dispatch APK（连同已推未 dispatch 的 de6c625 一起）。

## 明确不做

- 视频面试实现（仅占位）；多简历对比（已拍板单份档案）；文字面试旧会话数据迁移（practiceTarget 缺省按旧 positionId 解释）；岗位手动自定义分组（先用阶段分组，真有需要再加标签系统）；本地音频转码（分析格式兼容性交给服务商选型）；TTS 密钥单配（账号级，只 override 服务商选择）；语音面试挂断后自动生成岗位维度评价归档（表达复盘除外，岗位内容评价后续版本）。