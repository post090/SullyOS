# amsg2 后台支持用户自配 MCP — 实施计划（v2：上游透传 tools）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 定时主动消息（amsg2）到点时，worker 能直连用户自配的 MCP 服务器调工具，结果进最终推送——前台关着也一样。

**Architecture:** 三处断点三段修：① MCP 服务器清单（含凭证）作为 `tool_config.mcpServers` 随既有加密通道上云；② worker 在 fire 时刻从 tool_config 现场生成工具说明块拼进 prompt（提示词与凭据同源同拍）；③ **上游 amsg-server 补上 `tools` 请求体透传**（它的循环早就会给 assistant 消息补 tool_calls、配对 role:tool 结果，唯独请求体不会声明 tools——这次补齐这个不对称），worker 以 native function calling 为主路，正文协议 `tool_name({...})` 为第二层兜底（与前台聊天的双层设计完全对齐，由同一个「兼容模式」开关控制）。为此先把 mcpClient/mcpToolBridge 里的纯逻辑抽成环境无关叶子 `utils/mcpFireCore.ts`。

**Tech Stack:** TypeScript、vitest（`pnpm vitest run`）、node:test（ReiStandard）、esbuild worker bundle（`pnpm build:workers`）、node:http e2e harness（`node scripts/amsg2-e2e-harness.mjs`，Node 22+）。

---

## 方案取舍（已定，执行者不需要再选）

上一版计划选了「纯正文协议、不改上游」；经权衡改为**上游透传 + 双层**。对比：

| | 纯正文协议（v1 方案） | 上游透传 tools + 正文兜底（本方案） |
|---|---|---|
| 上游改动 | 无 | `llm.js` 透传 + `normalizeBeforeFireResult` 两字段 + 循环一行 + assistant 补章改合并，约 30 行 + 测试 |
| 部署联动 | 无 | **只是 bundle 内自带**：amsg-server 被 esbuild 打进 worker.bundle.js，升级 = 发预发版 + bump + 重新粘贴，走的就是 2.6.0-next.x 一路走来的熟路 |
| 参数可靠性 | 三形态容错解析，嵌套参数靠模型手写 JSON | native FC 结构化传参为主，正文解析降为第二层 |
| 与前台一致性 | 后台单独一套「只教正文协议」 | 与前台完全同构：native 优先 + 兼容模式兜底，同一个 `useNativeTools` 开关管两端 |
| 部署版本歪斜 | **静默**：老 worker 忽略 mcpServers，无从察觉 | capabilities 新增 `agentic-fire-tools` + 版本门槛，设置页照现有模式亮「重新粘贴」牌 |
| 库的合理性 | 绕开库的缺口 | 修根因：循环已实现 FC 协议的下半场，补上上半场对任何宿主都通用 |

**其余已定决策（与 v1 相同）：**
- 提示词块 worker fire 时生成，不进 fire_pack——没有陈旧窗口。
- 上云的服务器**不带 proxyUrl/proxyKey**（worker 直连、无 CORS），**带 token/customHeaders**（走 client_state 端到端加密通道，与 notion/飞书凭据同一信任模型）。
- localhost / 私网地址的服务器不上云（CF worker 打不通）。
- worker 侧工具名统一 `mcp__` 前缀（native 声明时就带上），杜绝与内置工具（recall/search/…）重名歧义。
- 前台聊天路径一字不动；instant-push worker 不在本计划范围。
- 中转拒 tools（4xx）的用户：前台早就会遇到并把「兼容模式」开关拨到关（`aetheros.mcp.useNativeTools='0'`），该开关随 tool_config 上云，worker 同样退到正文协议——不做 fire 内的 4xx 自动重试（库没有该 hook，且这类拒绝是确定性的）。

## 文件地图

| 文件 | 动作 | 职责 |
|---|---|---|
| **ReiStandard** `packages/rei-standard-amsg/server/src/server/lib/llm.js` | 改 | `buildAiRequestBody` 透传 tools/tool_choice |
| **ReiStandard** `…/lib/agentic-fire.js` | 改 | onBeforeFire 返回值收 tools；每轮 callLlm 带上；assistant 补章改「native+合成」合并 |
| **ReiStandard** `…/handlers/capabilities.js`、`.changeset/` | 改 | feature `agentic-fire-tools`；版本走 changeset（机器人发版，预计 next.8+） |
| **ReiStandard** `…/test/agentic-fire.test.mjs`、`…/test/message-processor.test.mjs` | 改 | 透传与合并的回归测试 |
| `utils/mcpFireCore.ts` | 新建 | 环境无关 MCP 核心：类型、名映射、传输、假调用解析、结果格式化、fire 块、fire tools 数组 |
| `utils/mcpFireCore.test.ts` | 新建 | 上述纯函数单测 |
| `utils/mcpClient.ts` | 改 | 浏览器侧保留（localStorage/代理/发现），传输委托 core；新增 `collectMcpFireServers` |
| `utils/mcpToolBridge.ts` | 改 | 名映射/解析委托 core，原导出名全保留 |
| `utils/amsgToolPack.ts` | 改 | `mcpServers` + `mcpUseNativeTools` 字段 |
| `utils/activeMsgClient.ts` | 改 | `buildToolConfigEntry` 咽喉带上 MCP 配置 |
| `components/settings/ActiveMsgGlobalSettingsModal.tsx` | 改 | REQUIRED_WORKER_VERSION / FEATURES 抬门槛 |
| `apps/Settings.tsx` | 改 | MCP 卡片保存后触发 tool_config 重传 |
| `worker/amsg/src/agentic.ts` | 改 | processLLMRound：native 归并 + 正文第二层 |
| `worker/amsg/src/index.ts` | 改 | fire 时注入块与 tools；executeToolCalls 按 `mcp__` 分流；`runMcpFireTool` |
| `scripts/amsg2-e2e-harness.mjs` | 改 | S8 native 场景 + S8b 正文兜底场景 |
| `docs/mcp-user-guide.md`、`docs/mcp-client.md` | 改 | 文档 |

分支：SullyOS 在 `feat/amsg2-multitask-gate` 上继续；ReiStandard 按其仓库惯例开分支、加 changeset（发版由用户合并 PR 后经 Changesets 机器人完成）。**禁用 `link:../ReiStandard` 联调后直接提交 lockfile**（有 Netlify frozen install 挂掉的前科）——提交前 `grep ReiStandard pnpm-lock.yaml` 自查。

---

### Task 0: 上游 amsg-server 透传 tools（ReiStandard 仓库）

**Files:**
- Modify: `packages/rei-standard-amsg/server/src/server/lib/llm.js:82-118`
- Modify: `packages/rei-standard-amsg/server/src/server/lib/agentic-fire.js:119-134, 301-335, 及 assistant 补章处`
- Modify: `packages/rei-standard-amsg/server/src/server/handlers/capabilities.js:19-27`
- Modify: `packages/rei-standard-amsg/server/src/server/lib/version.js`、`package.json`
- Test: `packages/rei-standard-amsg/server/test/message-processor.test.mjs`、`test/agentic-fire.test.mjs`

- [ ] **Step 1: 写失败测试（buildAiRequestBody 透传）**

追加到 `test/message-processor.test.mjs`（`buildAiRequestBody` 已是具名导出）：

```js
test('buildAiRequestBody forwards tools/tool_choice verbatim; absent when not provided', () => {
  const tools = [{ type: 'function', function: { name: 'mcp__x', parameters: { type: 'object' } } }];
  const withTools = buildAiRequestBody({ primaryModel: 'm', messages: [{ role: 'user', content: 'hi' }], tools, toolChoice: 'auto' });
  assert.deepEqual(withTools.tools, tools);
  assert.equal(withTools.tool_choice, 'auto');

  const without = buildAiRequestBody({ primaryModel: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal('tools' in without, false);
  assert.equal('tool_choice' in without, false);

  // 空数组不透传（避免部分中转把 tools: [] 当协议错误拒掉）
  const empty = buildAiRequestBody({ primaryModel: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] });
  assert.equal('tools' in empty, false);
});
```

- [ ] **Step 2: 写失败测试（循环逐轮携带 + assistant 合并补章）**

追加到 `test/agentic-fire.test.mjs` 的 `agentic fire loop` describe（沿用文件里现成的 `makeTask` / `makeCtx` / `stubLlm` / `TOOL_CALL`）：

```js
test('onBeforeFire may return { messages, tools }: every round carries them', async () => {
  const { task } = await makeTask();
  const tools = [{ type: 'function', function: { name: 'mcp__probe', parameters: { type: 'object', properties: {} } } }];
  const decisions = [
    { decision: 'tool-request', toolCalls: [TOOL_CALL] },
    { decision: 'finish', pushPayloads: [{ messageKind: 'content', message: 'done' }] },
  ];
  let i = 0;
  const hooks = {
    onBeforeFire: async () => ({ messages: [{ role: 'user', content: 'U' }], tools }),
    onLLMOutput: async () => decisions[i++],
    executeToolCalls: async () => [{ tool_call_id: 'call_1', role: 'tool', content: '{}' }],
  };
  const llm = stubLlm([toolRound, finishRound]);
  try {
    await processSingleMessage(task, makeCtx({ hooks, pushSpy: () => {} }));
    assert.deepEqual(llm.calls[0].body.tools, tools);   // 第 1 轮带 tools
    assert.deepEqual(llm.calls[1].body.tools, tools);   // 工具轮之后同样带
  } finally { llm.restore(); }
});

test('assistant stamping merges native tool_calls with synthesized ones (no orphan role:tool)', async () => {
  const { task } = await makeTask();
  const nativeCall = { id: 'call_native', type: 'function', function: { name: 'mcp__probe', arguments: '{}' } };
  const synthesized = { id: 'call_tag', type: 'function', function: { name: 'recall', arguments: '{"month":"2026-06"}' } };
  const decisions = [
    { decision: 'tool-request', toolCalls: [nativeCall, synthesized] },  // 同轮 native + 文本合成
    { decision: 'finish', pushPayloads: [{ messageKind: 'content', message: 'done' }] },
  ];
  let i = 0;
  const hooks = {
    onBeforeFire: async () => [{ role: 'user', content: 'U' }],
    onLLMOutput: async () => decisions[i++],
    executeToolCalls: async (calls) => calls.map((c) => ({ tool_call_id: c.id, role: 'tool', content: '{}' })),
  };
  // 第 1 轮响应里 assistant 自带 native tool_calls
  const nativeRound = { choices: [{ message: { role: 'assistant', content: '旁白', tool_calls: [nativeCall] } }] };
  const llm = stubLlm([nativeRound, finishRound]);
  try {
    await processSingleMessage(task, makeCtx({ hooks, pushSpy: () => {} }));
    const round2 = llm.calls[1].body.messages;
    const assistant = round2.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    // native + 合成的都在 assistant.tool_calls 里，两条 role:tool 都有归属
    assert.deepEqual(assistant.tool_calls.map((tc) => tc.id).sort(), ['call_native', 'call_tag']);
  } finally { llm.restore(); }
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd ../ReiStandard/packages/rei-standard-amsg/server && node --test test/`
Expected: 新用例 FAIL

- [ ] **Step 4: 实现 llm.js 透传**

`buildAiRequestBody` 中 `requestBody` 组好之后、`maxTokens` 段之前插入：

```js
  // tools mode (added in v2.6.0): forward the caller's OpenAI tools array
  // verbatim — same philosophy as messages mode above. The agentic loop
  // already appends assistant tool_calls + role:'tool' results; this is
  // the request-side half of the same protocol.
  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    requestBody.tools = payload.tools;
    if (payload.toolChoice !== undefined && payload.toolChoice !== null) {
      requestBody.tool_choice = payload.toolChoice;
    }
  }
```

- [ ] **Step 5: 实现 agentic-fire.js 三处**

`normalizeBeforeFireResult`（119 行）对象分支加两字段（报错文案同步提及 tools）：

```js
    return {
      messages: result.messages,
      maxToolIterations: result.maxToolIterations,
      totalTimeoutMs: result.totalTimeoutMs,
      tools: Array.isArray(result.tools) && result.tools.length > 0 ? result.tools : undefined,
      toolChoice: result.toolChoice,
    };
```

每轮 callLlm（326 行）带上：

```js
    const { response: llmResponse } = await callLlm(
      {
        ...decryptedPayload,
        messages,
        ...(normalized.tools ? { tools: normalized.tools, toolChoice: normalized.toolChoice } : {}),
      },
      { requireContent: false, timeoutMs: roundTimeoutMs }
    );
```

assistant 补章处（现为「native 有就原样、没有才盖合成的」二选一）改为**按 id 合并**——native 与文本合成同轮并存时，两边的 role:'tool' 结果都要有归属，否则严格中转会拒第 2 轮：

```js
    const nativeCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];
    const nativeIds = new Set(nativeCalls.map((tc) => tc && tc.id));
    const synthesized = toolCalls.filter((tc) => !nativeIds.has(tc && tc.id));
    const assistantWithTools = synthesized.length === 0
      ? assistantMessage
      : { ...assistantMessage, tool_calls: [...nativeCalls, ...synthesized] };
```

- [ ] **Step 6: capabilities + 版本**

`capabilities.js` 的 `SERVER_FEATURES` 追加 `'agentic-fire-tools'`。

版本：**不手改** `version.js` / `package.json`——该仓库版本由 Changesets 机器人 PR 抬（`version.js` 是 tsup 构建期注入），手改会跟机器人打架。按仓库先例（`79da9e4`）添加 `.changeset/*.md`（minor），实际发版号由发版时的机器人 PR 决定（main 已在 next.7，预计 next.8+）。

- [ ] **Step 7: 跑测试确认通过**

Run: `node --test test/`
Expected: 全 PASS（既有用例全绿 = 合并补章不回归）

- [ ] **Step 8: Commit + 发版 + SullyOS bump**

```bash
# ReiStandard 仓库内：只 git add 明确改过的文件（仓库可能有无关脏改动），开分支提交、开 PR。
# 不发版——发版 = 用户合并 PR + Changesets 机器人 PR，发出来的号记为 <released>（≥ 2.6.0-next.8）。
# 用户发版之后，回到 SullyOS:
pnpm update @rei-standard/amsg-server
grep -c ReiStandard pnpm-lock.yaml   # 必须为 0（link: 污染自查）
pnpm build:workers && pnpm vitest run
git add package.json pnpm-lock.yaml worker/amsg/worker.bundle.js public/amsg-worker.bundle.js
git commit -m "chore(amsg2): amsg-server 升 <released>（fire 支持 tools 透传）"
```

---

### Task 1: mcpFireCore 骨架 — 类型与工具名映射

**Files:**
- Create: `utils/mcpFireCore.ts`
- Create: `utils/mcpFireCore.test.ts`
- Modify: `utils/mcpToolBridge.ts:27-63`（sanitize/slug/映射逻辑改为委托）

- [ ] **Step 1: 写失败测试**

`utils/mcpFireCore.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { buildMcpNameMap, filterMcpServersForChar, type McpFireServer } from './mcpFireCore';

const srv = (over: Partial<McpFireServer>): McpFireServer => ({
  id: 's1', name: '服务器A', url: 'https://a.example.com/mcp',
  tools: [{ name: 'get_weather' }],
  ...over,
});

describe('buildMcpNameMap', () => {
  it('工具名 sanitize 成 OpenAI 允许的字符集', () => {
    const map = buildMcpNameMap([srv({ tools: [{ name: 'ns.get/weather' }] })]);
    expect([...map.keys()]).toEqual(['ns_get_weather']);
    expect(map.get('ns_get_weather')).toMatchObject({ toolName: 'ns.get/weather' });
  });

  it('跨服务器重名时后者加服务器前缀', () => {
    const map = buildMcpNameMap([
      srv({ id: 's1', name: 'AAA', tools: [{ name: 'search' }] }),
      srv({ id: 's2', name: 'BBB', tools: [{ name: 'search' }] }),
    ]);
    expect([...map.keys()]).toEqual(['search', 'BBB_search']);
    expect(map.get('BBB_search')?.server.id).toBe('s2');
  });
});

describe('filterMcpServersForChar', () => {
  it('charIds 为空 = 通用；非空 = 只对绑定角色可见', () => {
    const servers = [
      srv({ id: 'g', charIds: undefined }),
      srv({ id: 'bound', charIds: ['char-1'] }),
      srv({ id: 'other', charIds: ['char-2'] }),
    ];
    expect(filterMcpServersForChar(servers, 'char-1').map((s) => s.id)).toEqual(['g', 'bound']);
  });

  it('没有 url 或没发现工具的不进清单; 入参 undefined 得空数组', () => {
    expect(filterMcpServersForChar([srv({ url: '' }), srv({ tools: [] })], 'c')).toEqual([]);
    expect(filterMcpServersForChar(undefined, 'c')).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run utils/mcpFireCore.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 mcpFireCore 第一段**

`utils/mcpFireCore.ts`：

```ts
/**
 * mcpFireCore — 通用 MCP 的环境无关核心（浏览器 / amsg worker 共用叶子）。
 *
 * mcpClient.ts 管浏览器侧的事（localStorage 配置、代理包装、发现流程）；
 * 这里只放两端都要跑的纯逻辑：工具名映射、JSON-RPC 传输、正文假调用解析、
 * 结果格式化、后台 fire 的提示词块与 tools 数组。
 *
 * 环境无关叶子模块：不 import 任何带浏览器依赖的东西（会进 worker bundle）。
 */

export interface McpFireToolDef {
  name: string;
  description?: string;
  inputSchema?: any;
}

/**
 * 上云 / 进 worker 的服务器形状：McpServerConfig 的结构子集
 * （没有 proxyUrl/proxyKey——worker 侧 fetch 没有 CORS，直连 url）。
 */
export interface McpFireServer {
  id: string;
  name: string;
  url: string;
  /** Bearer Token，可选（Authorization: Bearer <token>） */
  token?: string;
  customHeaders?: Array<{ name: string; value: string }>;
  /** 空/缺省 = 通用；非空 = 只有这些角色可见（与 mcpClient.getEnabledMcpServers 同语义） */
  charIds?: string[];
  tools?: McpFireToolDef[];
}

export interface McpResolvedToolCore<S extends McpFireServer = McpFireServer> {
  server: S;
  toolName: string;
}

// OpenAI 工具名只允许 [A-Za-z0-9_-]，最长 64；MCP 工具名可能带点号等
export const sanitizeMcpToolName = (name: string): string =>
  (name || 'tool').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'tool';

const serverSlug = (server: McpFireServer): string =>
  sanitizeMcpToolName(server.name).slice(0, 20) || 'srv';

/**
 * 暴露名 → 真实工具 的映射。暴露名默认用工具原名（sanitize 后）；
 * 跨服务器重名时后者加 <服务器名>_ 前缀。前台 buildMcpOpenAITools 与
 * worker fire 路径都用这一份，保证两端看到同一套名字。
 */
export const buildMcpNameMap = <S extends McpFireServer>(
  servers: S[],
): Map<string, McpResolvedToolCore<S>> => {
  const resolve = new Map<string, McpResolvedToolCore<S>>();
  for (const server of servers) {
    for (const t of server.tools || []) {
      let exposed = sanitizeMcpToolName(t.name);
      if (resolve.has(exposed)) {
        exposed = sanitizeMcpToolName(`${serverSlug(server)}_${t.name}`);
        let i = 2;
        while (resolve.has(exposed)) exposed = sanitizeMcpToolName(`${serverSlug(server)}_${t.name}_${i++}`);
      }
      resolve.set(exposed, { server, toolName: t.name });
    }
  }
  return resolve;
};

/** fire 时按角色过滤可见服务器（与 getEnabledMcpServers 的 charIds 语义一致）。 */
export const filterMcpServersForChar = <S extends McpFireServer>(
  servers: S[] | undefined,
  charId: string,
): S[] =>
  (servers || []).filter((s) =>
    !!s.url && (s.tools?.length || 0) > 0 &&
    (!s.charIds?.length || s.charIds.includes(charId)),
  );
```

- [ ] **Step 4: mcpToolBridge 委托给 core**

`utils/mcpToolBridge.ts`：删掉本地的 `sanitizeToolName`（27-29 行）与 `serverSlug`（31-32 行），`buildMcpOpenAITools`（39-63 行）改为：

```ts
import { buildMcpNameMap } from './mcpFireCore';
// ResolvedMcpTool 保持原导出形状（server: McpServerConfig），调用方零改动
export const buildMcpOpenAITools = (charId?: string): { tools: OpenAIMcpTool[]; resolve: Map<string, ResolvedMcpTool> } => {
    const servers = getEnabledMcpServers(charId);
    const resolve = buildMcpNameMap(servers);
    const tools: OpenAIMcpTool[] = [];
    for (const [exposed, { server, toolName }] of resolve) {
        const t = (server.tools || []).find((d) => d.name === toolName);
        if (!t) continue;
        tools.push({
            type: 'function',
            function: {
                name: exposed,
                description: buildToolDescription(server, t, servers.length > 1),
                parameters: t.inputSchema || { type: 'object', properties: {} },
            },
        });
    }
    return { tools, resolve };
};
```

- [ ] **Step 5: 跑测试确认通过（含既有回归）**

Run: `pnpm vitest run utils/mcpFireCore.test.ts utils/mcpClient.test.ts`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
git add utils/mcpFireCore.ts utils/mcpFireCore.test.ts utils/mcpToolBridge.ts
git commit -m "refactor(mcp): 工具名映射抽进环境无关核心 mcpFireCore"
```

---

### Task 2: 正文假调用解析迁入 core

**Files:**
- Modify: `utils/mcpFireCore.ts`（追加）
- Modify: `utils/mcpToolBridge.ts:125-351`（解析段整体迁走，re-export 保名）

- [ ] **Step 1: 迁移（纯搬家，逻辑零改动）**

把 `utils/mcpToolBridge.ts` 中以下符号**原样搬**到 `utils/mcpFireCore.ts`（含注释）：

- `escapeRegExp`（204 行）、`stripQuotes`（206-210）、`positionalKeys`（213-217）、`coerceBySchema`（219-231）、`splitTopLevel`（234-251）、`parseFakedArgs`（254-285）
- `stripTextFakedMcpCalls`（144-148）、`extractTextFakedMcpCalls`（291-351）
- `FakedMcpCall` 接口（135-141）
- `MCP_RESULT_MAX_CHARS`（78）、`formatMcpToolResult`（80-86）

类型上唯一的改动：泛型化——

```ts
export interface FakedMcpCall<S extends McpFireServer = McpFireServer> {
    exposedName: string;
    server: S;
    toolName: string;
    args: Record<string, any>;
    matched: string;
}

export const extractTextFakedMcpCalls = <S extends McpFireServer>(
    content: string,
    resolve: Map<string, McpResolvedToolCore<S>>,
): FakedMcpCall<S>[] => { /* 函数体原样 */ };

export const stripTextFakedMcpCalls = (content: string, calls: Array<{ matched: string }>): string => { /* 原样 */ };
```

- [ ] **Step 2: mcpToolBridge 改为 re-export（原导出名一个不少）**

```ts
export {
    MCP_RESULT_MAX_CHARS,
    formatMcpToolResult,
    stripTextFakedMcpCalls,
    extractTextFakedMcpCalls,
} from './mcpFireCore';
export type { FakedMcpCall } from './mcpFireCore';
```

- [ ] **Step 3: 跑全量 MCP 相关测试**

Run: `pnpm vitest run utils/mcpClient.test.ts utils/mcpFireCore.test.ts utils/xhsMcpClient.concurrency.test.ts`
Expected: 全 PASS

- [ ] **Step 4: Commit**

```bash
git add utils/mcpFireCore.ts utils/mcpToolBridge.ts
git commit -m "refactor(mcp): 正文假调用解析迁入 mcpFireCore"
```

---

### Task 3: JSON-RPC 传输层迁入 core

**Files:**
- Modify: `utils/mcpFireCore.ts`（追加传输段）
- Modify: `utils/mcpClient.ts:130-534`（session/post/initialize/callMcpTool 委托给 core）

- [ ] **Step 1: core 传输层公开面**

在 `utils/mcpFireCore.ts` 追加。**搬家部分**（从 `utils/mcpClient.ts` 原样搬，含注释）：`parseSse`（214-224）、`parseResp`（226-236）、`readSseResponse`（238-274）、`normalizeMcpValueBySchema` 一族（394-474，含 `isRecord`/`resolveLocalSchemaRef`/`schemaAccepts`/`normalizeMcpToolArguments`）、`McpToolResult` 接口（51-56）、`MCP_PROTOCOL_VERSION`（60）、`MCP_REQUEST_TIMEOUT_MS`（63）。

**新写部分**（把绑死 localStorage 配置和模块级 session Map 的机制改成显式传参）：

```ts
/** 一个 MCP 服务器连接的会话状态。持有者自己决定生命周期：
 *  浏览器 = 模块级 Map（跨轮复用）；worker = 挂在单次 fire 的 stash 上。 */
export interface McpSessionState {
  sessionId: string | null;
  initialized: boolean;
  initPromise: Promise<void> | null;
  nextId: number;
}
export const createMcpSessionState = (): McpSessionState =>
  ({ sessionId: null, initialized: false, initPromise: null, nextId: 0 });

/** 一次请求的目标：最终 URL + 请求头构造。浏览器侧包代理，worker 侧直连。 */
export interface McpTransportTarget {
  url: string;
  headers: (sessionId: string | null) => Headers | Record<string, string>;
}

const buildRpcRequest = (session: McpSessionState, method: string, params?: any, isNotification = false) => {
  const req: { jsonrpc: '2.0'; method: string; params?: any; id?: number } = { jsonrpc: '2.0', method, params };
  if (!isNotification) req.id = ++session.nextId;
  return req;
};

const postCore = async (
  target: McpTransportTarget,
  session: McpSessionState,
  body: ReturnType<typeof buildRpcRequest>,
  timeoutMs: number,
  expectResponse = true,
) => { /* mcpClient.ts post() 276-345 的函数体原样搬入，机械替换：
         - buildMcpFetchUrl(server) → target.url
         - buildMcpRequestHeaders(server, session.sessionId) → target.headers(session.sessionId)
         - MCP_REQUEST_TIMEOUT_MS → timeoutMs（报错文案里的秒数同步换算）
         - CORS 提示分支话术保持原文（浏览器仍是主要用户） */ };

const initializeCore = async (target: McpTransportTarget, session: McpSessionState, timeoutMs: number): Promise<void> => {
  /* doInitialize 347-363 原样搬入：post→postCore，clientInfo 不变（SullyOS-MCP/1.0.0） */
};

const ensureInitializedCore = async (target: McpTransportTarget, session: McpSessionState, timeoutMs: number): Promise<void> => {
  /* ensureInitialized 365-375 原样搬入 */
};

/** 握手 + tools/list（浏览器发现流程用；worker 不需要——工具清单随 tool_config 上云）。 */
export const discoverMcpToolsCore = async (
  target: McpTransportTarget,
  session: McpSessionState,
  timeoutMs: number,
): Promise<McpFireToolDef[]> => { /* discoverMcpTools 380-392 函数体原样搬入 */ };

/**
 * 调一个工具（自动补握手；HTTP 400/404 视为 session 失效，重握手一次）。
 * inputSchema 用于把中转双重编码的参数按 schema 还原（normalizeMcpToolArguments）。
 */
export const callMcpToolCore = async (
  target: McpTransportTarget,
  session: McpSessionState,
  toolName: string,
  args: Record<string, any>,
  opts: { timeoutMs?: number; inputSchema?: any; resetSession?: () => void } = {},
): Promise<McpToolResult> => {
  /* callMcpTool 477-534 的 try 块原样搬入，机械替换：
     - server.tools 查 schema → opts.inputSchema
     - post → postCore(target, session, ..., timeoutMs)
     - resetMcpSession(server.id); await ensureInitialized(server)
       → (opts.resetSession ?? (() => { Object.assign(session, createMcpSessionState()); }))();
         await ensureInitializedCore(target, session, timeoutMs)
     - finish() 里的 console.info 日志保留（server 名换成 target.url 的 host） */
};

/** worker 直连请求头（浏览器侧的代理头逻辑留在 mcpClient.buildMcpRequestHeaders）。 */
export const buildMcpDirectHeaders = (
  server: McpFireServer,
  sessionId: string | null,
): Record<string, string> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  for (const item of server.customHeaders || []) {
    const name = String(item?.name || '').trim();
    const value = String(item?.value || '').trim();
    if (name && value) headers[name] = value;
  }
  if (server.token) headers['Authorization'] = `Bearer ${server.token}`;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  return headers;
};
```

- [ ] **Step 2: mcpClient 委托**

`utils/mcpClient.ts` 删掉已搬走的实现，浏览器侧薄壳：

```ts
import {
    callMcpToolCore, createMcpSessionState, discoverMcpToolsCore, normalizeMcpToolArguments,
    MCP_REQUEST_TIMEOUT_MS, type McpSessionState, type McpToolResult,
} from './mcpFireCore';
export { MCP_REQUEST_TIMEOUT_MS, normalizeMcpToolArguments };
export type { McpToolResult };

const sessions = new Map<string, McpSessionState>();
const getSession = (serverId: string): McpSessionState => {
    let s = sessions.get(serverId);
    if (!s) { s = createMcpSessionState(); sessions.set(serverId, s); }
    return s;
};
export const resetMcpSession = (serverId: string): void => { sessions.delete(serverId); };

const targetFor = (server: McpServerConfig) => ({
    url: buildMcpFetchUrl(server),
    headers: (sessionId: string | null) => buildMcpRequestHeaders(server, sessionId),
});

export const callMcpTool = async (
    server: McpServerConfig,
    toolName: string,
    args: Record<string, any> = {},
): Promise<McpToolResult> =>
    callMcpToolCore(targetFor(server), getSession(server.id), toolName, args, {
        inputSchema: (server.tools || []).find((t) => t.name === toolName)?.inputSchema,
        resetSession: () => { sessions.set(server.id, createMcpSessionState()); },
    });

export const discoverMcpTools = async (server: McpServerConfig): Promise<McpToolDef[]> => {
    resetMcpSession(server.id);
    return discoverMcpToolsCore(targetFor(server), getSession(server.id), MCP_REQUEST_TIMEOUT_MS);
};
```

`buildMcpFetchUrl` / `buildMcpRequestHeaders` / 配置 CRUD / 导入导出 / `testMcpConnection` 留在 mcpClient 不动。

- [ ] **Step 3: 跑全量既有测试（重构不回归的硬门槛）**

Run: `pnpm vitest run utils/mcpClient.test.ts utils/mcpFireCore.test.ts`
Expected: 全 PASS（SSE 解析、双重编码还原、fallback body 的既有用例绿了才算搬干净）

- [ ] **Step 4: Commit**

```bash
git add utils/mcpFireCore.ts utils/mcpClient.ts
git commit -m "refactor(mcp): JSON-RPC 传输层迁入 mcpFireCore, 浏览器侧委托"
```

---

### Task 4: fire 的提示词块与 tools 数组

**Files:**
- Modify: `utils/mcpFireCore.ts`（追加 `buildMcpFireBlock` + `buildMcpFireTools`）
- Modify: `utils/mcpFireCore.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `utils/mcpFireCore.test.ts`：

```ts
import { buildMcpFireBlock, buildMcpFireTools } from './mcpFireCore';

describe('buildMcpFireBlock / buildMcpFireTools', () => {
  const servers = [srv({
    tools: [{
      name: 'get_weather',
      description: '查天气',
      inputSchema: { type: 'object', properties: { city: { type: 'string' }, days: { type: 'number' } }, required: ['city'] },
    }],
  })];
  const map = buildMcpNameMap(servers);

  it('native 模式：只讲纪律，不教正文协议', () => {
    const block = buildMcpFireBlock(map, { mode: 'native' });
    expect(block).toContain('get_weather');
    expect(block).toContain('不要编造结果');
    expect(block).not.toContain('tool_name({"参数":"值"})');
  });

  it('text 模式：签名含必填星标与类型，教正文协议', () => {
    const block = buildMcpFireBlock(map, { mode: 'text' });
    expect(block).toContain('get_weather(city*:string, days:number)');
    expect(block).toContain('tool_name({"参数":"值"})');
  });

  it('空映射返回空串', () => {
    expect(buildMcpFireBlock(new Map(), { mode: 'native' })).toBe('');
  });

  it('fire tools 数组带 mcp__ 前缀与来源标注', () => {
    const tools = buildMcpFireTools(map);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      type: 'function',
      function: { name: 'mcp__get_weather', description: '[服务器A] 查天气' },
    });
    expect((tools[0].function as any).parameters.required).toEqual(['city']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run utils/mcpFireCore.test.ts`
Expected: FAIL（未导出）

- [ ] **Step 3: 实现**

（勘误：下面参考代码里的来源标注/描述前缀判据 `resolve.size > 1` 应为「按 server.id 去重后的台数 > 1」，
与前台 buildToolDescription 的 servers.length > 1 对齐；返回类型具名为 `McpFireOpenAITool`。
以 Task 4 修正轮的实际代码为准。）

追加到 `utils/mcpFireCore.ts`：

```ts
/**
 * fire 请求的 tools 数组（native 模式）。暴露名直接带 mcp__ 前缀——模型按这个名字
 * 调回来，executeToolCalls 零歧义分流，不会撞内置工具（recall/search/…）的名字。
 */
export const buildMcpFireTools = <S extends McpFireServer>(
  resolve: Map<string, McpResolvedToolCore<S>>,
): Array<{ type: 'function'; function: { name: string; description: string; parameters: any } }> => {
  const tools = [];
  // Task 1 修正轮后 McpResolvedToolCore 自带 tool 定义，不再 find 反查（同服务器
  // 重名工具不会串台）。resolve 必须是用 { maxNameLen: 59 } 建的（见 Task 6）——
  // 拼上 mcp__ 前缀后不超 OpenAI 的 64 字符工具名上限。
  for (const [exposed, { server, tool }] of resolve) {
    tools.push({
      type: 'function' as const,
      function: {
        name: `mcp__${exposed}`,
        description: `[${server.name}] ${(tool.description || '').trim()}`.trim(),
        parameters: tool.inputSchema || { type: 'object', properties: {} },
      },
    });
  }
  return tools;
};

/**
 * 后台 fire 的 MCP 工具说明块（worker 到点拼进 user prompt 尾部）。
 *
 * native 模式（默认）：tools 参数已随请求声明，这里只列来源和纪律——与前台
 * buildMcpSystemBlock 的口径一致，不教正文语法（教了反而勾引模型往正文里写）。
 * text 模式（用户在设置里关掉「兼容模式」开关 = 中转拒 tools 时）：请求不带
 * tools 参数，这里教正文协议 tool_name({...})，签名格式与前台
 * buildMcpRejectedToolsFallbackBody 对齐——同一个模型两端见到的长一个样。
 */
export const buildMcpFireBlock = <S extends McpFireServer>(
  resolve: Map<string, McpResolvedToolCore<S>>,
  opts: { mode: 'native' | 'text'; userName?: string },
): string => {
  if (!resolve.size) return '';
  const userName = opts.userName || '用户';
  const lines: string[] = [];
  for (const [exposed, { server, tool }] of resolve) {
    const desc = (tool.description || '').trim();
    if (opts.mode === 'native') {
      lines.push(`- ${exposed}${desc ? `：${desc}` : ''}${resolve.size > 1 ? `（来源: ${server.name}）` : ''}`);
      continue;
    }
    const schema = tool.inputSchema || {};
    const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
    const args = Object.entries(schema.properties || {}).map(([name, d]: [string, any]) =>
      `${name}${required.has(name) ? '*' : ''}:${d?.type || 'any'}`);
    lines.push(`- ${exposed}(${args.join(', ')})${desc ? `：${desc}` : ''}${resolve.size > 1 ? `（来源: ${server.name}）` : ''}`);
  }
  const howTo = opts.mode === 'native'
    ? '需要时直接通过系统的工具调用接口发起（系统会自动执行并把结果给你），不要把工具名和参数写进正文。'
    : '需要工具时，单独输出一行 tool_name({"参数":"值"})，系统会代为执行并把结果给你，然后你继续写。* 表示必填参数。';
  return [
    '',
    '---',
    `【外部工具 —— ${userName} 在设置里给你连了 MCP 工具服务器，主动消息里也可以用】`,
    howTo,
    '纪律：不需要就别硬调；没收到系统返回前不要声称工具成功，也不要编造结果；工具失败就换个方式或如实带过；结果只挑相关部分用角色语气转述，别复读 JSON。',
    '可用工具：',
    ...lines,
    '---',
  ].join('\n');
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run utils/mcpFireCore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add utils/mcpFireCore.ts utils/mcpFireCore.test.ts
git commit -m "feat(amsg2): fire 的 MCP 提示词块（native/text 双模）与 tools 数组"
```

---

### Task 5: MCP 配置随 tool_config 上云

**Files:**
- Modify: `utils/amsgToolPack.ts`（`mcpServers` + `mcpUseNativeTools` 字段）
- Modify: `utils/mcpClient.ts`（新增 `collectMcpFireServers`）
- Modify: `utils/activeMsgClient.ts:457-465`（buildToolConfigEntry 咽喉）
- Modify: `apps/Settings.tsx`（保存钩子）
- Test: `utils/amsgToolPack.test.ts`、`utils/mcpClient.test.ts`

- [ ] **Step 1: 写失败测试（amsgToolPack）**

追加到 `utils/amsgToolPack.test.ts` 的 `buildToolConfig / parseToolConfig` describe：

```ts
it('mcp 配置随 tool_config 往返, 坏条目被丢弃', () => {
  const servers = [{
    id: 's1', name: '探针', url: 'https://probe.example.com',
    token: 'tok', tools: [{ name: 'get_secret' }],
  }];
  const config = buildToolConfig(undefined, { servers, useNativeTools: false });
  const parsed = parseToolConfig(JSON.stringify(config));
  expect(parsed?.mcpServers).toEqual(servers);
  expect(parsed?.mcpUseNativeTools).toBe(false);

  const dirty = { ...config, mcpServers: [servers[0], { id: 'bad' }, null, { name: 'x', url: 'u' }] };
  expect(parseToolConfig(JSON.stringify(dirty))?.mcpServers).toEqual(servers);
});

it('不传 mcp 配置时两个字段都不出现（老 worker 解析零影响）', () => {
  const config = buildToolConfig(undefined);
  expect('mcpServers' in config).toBe(false);
  expect('mcpUseNativeTools' in config).toBe(false);
});
```

- [ ] **Step 2: 写失败测试（collectMcpFireServers）**

追加到 `utils/mcpClient.test.ts`（沿用文件现成的 localStorage 清理）：

```ts
import { collectMcpFireServers } from './mcpClient';

describe('collectMcpFireServers', () => {
  it('只带 enabled + 已发现工具 + 公网地址; 剥代理字段、留 token', () => {
    localStorage.setItem('aetheros.mcp.servers', JSON.stringify([
      { id: 'a', name: 'ok', url: 'https://mcp.example.com', enabled: true, token: 'tok', proxyUrl: 'https://proxy.x', proxyKey: 'pk', charIds: ['c1'], tools: [{ name: 't1', inputSchema: { type: 'object' } }], updatedAt: 1 },
      { id: 'b', name: 'disabled', url: 'https://x.com', enabled: false, tools: [{ name: 't' }], updatedAt: 1 },
      { id: 'c', name: 'no-tools', url: 'https://y.com', enabled: true, tools: [], updatedAt: 1 },
      { id: 'd', name: 'local', url: 'http://localhost:18061/mcp', enabled: true, tools: [{ name: 't' }], updatedAt: 1 },
      { id: 'e', name: 'lan', url: 'http://192.168.1.5/mcp', enabled: true, tools: [{ name: 't' }], updatedAt: 1 },
    ]));
    const out = collectMcpFireServers();
    expect(out.map((s) => s.id)).toEqual(['a']);
    expect(out[0]).toEqual({
      id: 'a', name: 'ok', url: 'https://mcp.example.com', token: 'tok',
      charIds: ['c1'], tools: [{ name: 't1', description: undefined, inputSchema: { type: 'object' } }],
    });
    expect('proxyUrl' in out[0]).toBe(false);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run utils/amsgToolPack.test.ts utils/mcpClient.test.ts`
Expected: 新用例 FAIL

- [ ] **Step 4: 实现 amsgToolPack 侧**

`utils/amsgToolPack.ts`：

```ts
import type { McpFireServer } from './mcpFireCore';   // type-only, 不碰运行时

// AmsgToolConfig 追加字段：
export interface AmsgToolConfig extends AgenticToolRealtimeConfig {
  // …既有字段不动…
  /**
   * 用户自配的通用 MCP 服务器（enabled 且已发现工具、worker 够得着的那部分，
   * 见 mcpClient.collectMcpFireServers）。代理字段不上云——worker 直连没有 CORS。
   */
  mcpServers?: McpFireServer[];
  /** 前台「兼容模式」同款开关：false = 中转拒 tools，worker 退到正文协议。缺省按 true。 */
  mcpUseNativeTools?: boolean;
}

// buildToolConfig 加可选参（不读 localStorage, 保持环境无关；由浏览器侧调用方传入）：
export const buildToolConfig = (
  realtimeConfig: RealtimeConfig | undefined,
  mcp?: { servers: McpFireServer[]; useNativeTools: boolean },
): AmsgToolConfig => {
  // …函数体不动，返回对象末尾加：
  //   ...(mcp?.servers.length ? { mcpServers: mcp.servers, mcpUseNativeTools: mcp.useNativeTools } : {}),
};

// parseToolConfig 里 return 前加轻校验（坏条目丢弃，不炸 fire 链）：
const cleaned = Array.isArray(parsed.mcpServers)
  ? parsed.mcpServers.filter((s: any) =>
      s && typeof s === 'object' &&
      typeof s.id === 'string' && typeof s.name === 'string' &&
      typeof s.url === 'string' && Array.isArray(s.tools))
  : undefined;
if (cleaned?.length) parsed.mcpServers = cleaned; else delete parsed.mcpServers;
```

- [ ] **Step 5: 实现 collectMcpFireServers（mcpClient.ts）**

```ts
import type { McpFireServer } from './mcpFireCore';

/** CF worker 直连打不通的地址（localhost/私网）不上云——上了只会教角色用一个必失败的工具。 */
const isWorkerReachableUrl = (url: string): boolean => {
    try {
        const u = new URL(url);
        if (!/^https?:$/.test(u.protocol)) return false;
        const h = u.hostname;
        return !(h === 'localhost' || h === '127.0.0.1' || h === '[::1]' ||
            /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h));
    } catch { return false; }
};

/**
 * 上云给 amsg worker 用的服务器子集。注意不走 getEnabledMcpServers：
 * 那个函数缺 charId 时只回通用服务器，而这里要的是全部 enabled（含绑定角色的），
 * charIds 原样带上、由 worker 在 fire 时按角色过滤。
 */
export const collectMcpFireServers = (): McpFireServer[] =>
    loadMcpServers()
        .filter((s) => s.enabled && s.url && (s.tools?.length || 0) > 0 && isWorkerReachableUrl(s.url))
        .map((s) => ({
            id: s.id, name: s.name, url: s.url,
            ...(s.token ? { token: s.token } : {}),
            ...(s.customHeaders?.length ? { customHeaders: s.customHeaders } : {}),
            ...(s.charIds?.length ? { charIds: s.charIds } : {}),
            tools: (s.tools || []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        }));
```

- [ ] **Step 6: 咽喉接线（activeMsgClient.ts:457）**

```ts
import { collectMcpFireServers, getMcpUseNativeTools } from './mcpClient';

const buildToolConfigEntry = (
  realtimeConfig: RealtimeConfig | undefined,
  updatedAt: number,
) => ({
  namespace: AMSG_GLOBAL_NAMESPACE,
  key: AMSG_TOOL_CONFIG_KEY,
  // MCP 配置在这里现读现带：三条上传路径（排程 / fire_pack 冲刷 / 设置保存）
  // 全走这个咽喉，不会出现某条路漏带的版本分叉。
  value: JSON.stringify(buildToolConfig(realtimeConfig, {
    servers: collectMcpFireServers(),
    useNativeTools: getMcpUseNativeTools(),
  })),
  updatedAt,
});
```

- [ ] **Step 7: 设置页保存钩子（apps/Settings.tsx）**

`McpServersCard`（107 行起）加可选 prop，persist（117 行 saveMcpServers 处）与「兼容模式」开关切换（setMcpUseNativeTools 调用处）之后都调它：

```tsx
const McpServersCard: React.FC<{ addToast: (msg: string, type?: any) => void; onMcpConfigChanged?: () => void }> =
    ({ addToast, onMcpConfigChanged }) => {
    // persist 内 saveMcpServers(next) 之后、以及 setMcpUseNativeTools(...) 之后追加：
    //   onMcpConfigChanged?.();
```

父组件（3097 行）传入：

```tsx
<McpServersCard addToast={addToast} onMcpConfigChanged={() => {
    // MCP 配置变更只需重传 tool_config：提示词块与 tools 数组由 worker 在 fire 时
    // 从 tool_config 现场生成（见 mcpFireCore），不经过 fire_pack，没有陈旧问题，
    // 所以不用像实时感知那样连提示词一起刷（syncAmsgToolConfigAndPrompts）。
    // 没配 amsg2 时 ensureWorkerReady 会抛，吞掉即可——与 amsgStateSync:157 同款。
    ActiveMsgClient.syncToolConfig(realtimeConfig).catch(() => {});
}} />
```

（`ActiveMsgClient` 若未在 Settings.tsx import，则从 `../utils/activeMsgClient` 引入。）

- [ ] **Step 8: 跑测试确认通过**

Run: `pnpm vitest run utils/amsgToolPack.test.ts utils/mcpClient.test.ts utils/activeMsgClient.test.ts`
Expected: 全 PASS

- [ ] **Step 9: Commit**

```bash
git add utils/amsgToolPack.ts utils/mcpClient.ts utils/activeMsgClient.ts apps/Settings.tsx utils/amsgToolPack.test.ts utils/mcpClient.test.ts
git commit -m "feat(amsg2): 自配 MCP 配置随 tool_config 上云"
```

---

### Task 6: worker fire 时注入工具块与 tools，版本门槛抬升

**Files:**
- Modify: `worker/amsg/src/index.ts`（FireStash + onBeforeFire）
- Modify: `components/settings/ActiveMsgGlobalSettingsModal.tsx`（REQUIRED_WORKER_VERSION / FEATURES）

- [ ] **Step 1: FireStash 扩容与注入**

`worker/amsg/src/index.ts`：

imports 追加：

```ts
import {
  buildMcpFireBlock, buildMcpFireTools, buildMcpNameMap, createMcpSessionState, filterMcpServersForChar,
  type McpResolvedToolCore, type McpSessionState,
} from '../../../utils/mcpFireCore';
```

`FireStash`（141-148 行）追加：

```ts
interface FireStash {
  // …既有字段不动…
  /** 通用 MCP：暴露名 → 服务器/工具。tool_config 里没配（或对该角色不可见）时为 null。 */
  mcpResolve: Map<string, McpResolvedToolCore> | null;
  /** 每服务器一份连接会话，单次 fire 内跨轮复用，fire 结束随 scratch 丢弃。 */
  mcpSessions: Map<string, McpSessionState>;
}
```

`onBeforeFire` 里 `buildToolCtx` 调用（405 行）之后、返回处：

```ts
    // 通用 MCP：提示词块 / tools 数组与凭据同源同拍（都来自这一行 tool_config），
    // 不存在「教了角色用、凭据却没到」的窗口。charIds 过滤与前台同语义。
    // mcpUseNativeTools=false = 用户的中转拒 tools（前台兼容模式同款开关），
    // 请求不带 tools 参数、提示词块教正文协议，识别走 processLLMRound 第二层。
    const mcpServers = filterMcpServersForChar(toolConfig.mcpServers, charId);
    // maxNameLen 59：暴露名后面要拼 mcp__ 前缀（5 字符），总长不能超 OpenAI 的 64。
    const mcpResolve = mcpServers.length ? buildMcpNameMap(mcpServers, { maxNameLen: 59 }) : null;
    const mcpNative = toolConfig.mcpUseNativeTools !== false;

    const { toolCtx, proxyWorkerUrl, xhsCookie } = buildToolCtx(toolPack, toolConfig);
    ctx.scratch.fire = {
      session: createFireSessionState(),
      toolCtx,
      proxyWorkerUrl,
      xhsCookie,
      occurrenceMs,
      mcpResolve,
      mcpSessions: new Map(),
    } satisfies FireStash;

    // fire_pack v2：「本次任务」指令随任务 metadata 走，这里填槽。
    // MCP 块拼在渲染好的 prompt 之后（同一条 user 消息）。
    const prompt = renderFirePack(pack, ctx.now.getTime(), taskMeta.amsgTaskInstruction)
      + (mcpResolve ? buildMcpFireBlock(mcpResolve, { mode: mcpNative ? 'native' : 'text' }) : '');
    return {
      messages: [{ role: 'user' as const, content: prompt }],
      // amsg-server 带 agentic-fire-tools feature 的版本起透传给每轮 LLM 请求；
      // 老 bundle 里不会走到这（tools 是随本次 bundle 一起升上去的）。
      ...(mcpResolve && mcpNative ? { tools: buildMcpFireTools(mcpResolve) } : {}),
    };
```

- [ ] **Step 2: 设置页版本门槛**

`REQUIRED_WORKER_VERSION` 已在依赖升级提交（`chore(amsg2): amsg-server 升 2.6.0-next.8`）里同步抬到 `2.6.0-next.8`——仓库有守卫测试钉着「门槛 = package.json 声明版本」，升依赖时就已被迫同步，这一步不用再动它。可选：`REQUIRED_WORKER_FEATURES` 追加 `'agentic-fire-tools'` 作显式语义（版本比对已覆盖判定，加 feature 只是让意图更可读）。旧粘贴部署会照现有模式亮「重新粘贴 worker」的牌子，MCP 静默失效变成看得见的提示（部署一致性优先于前端兜底）。

- [ ] **Step 3: 编译确认**

Run: `pnpm build:workers && pnpm vitest run worker/amsg/src/index.test.ts`
Expected: 构建成功、既有测试绿

- [ ] **Step 4: Commit**

```bash
git add worker/amsg/src/index.ts components/settings/ActiveMsgGlobalSettingsModal.tsx worker/amsg/worker.bundle.js public/amsg-worker.bundle.js
git commit -m "feat(amsg2): fire 时注入 MCP 工具块与 tools 声明, 版本门槛抬至 next.6"
```

---

### Task 7: 工具循环归并 native 调用 + 正文第二层

**Files:**
- Modify: `worker/amsg/src/agentic.ts`（processLLMRound）
- Modify: `worker/amsg/src/index.ts:439-459`（onLLMOutput 提取 native tool_calls）
- Test: `worker/amsg/src/agentic.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `worker/amsg/src/agentic.test.ts`（`buildInput()` 若文件里没有现成构造器，按既有 PushBuildInput 字面量补一个最小工厂）：

```ts
import { buildMcpNameMap, type McpFireServer } from '../../../utils/mcpFireCore';

const mcpSrv: McpFireServer = {
  id: 's1', name: '探针', url: 'https://probe.example.com',
  tools: [{ name: 'get_secret', inputSchema: { type: 'object', properties: { who: { type: 'string' } } } }],
};
const mcpResolve = buildMcpNameMap([mcpSrv]);
const nativeCall = (args = '{}') => ({
  id: 'call_n1', type: 'function' as const,
  function: { name: 'mcp__get_secret', arguments: args },
});

describe('processLLMRound + MCP', () => {
  it('native tool_calls → tool-request 原样透传, 正文全文入旁白', () => {
    const state = createFireSessionState();
    const d = processLLMRound(state, '我去问问暗号。', buildInput(),
      { resolve: mcpResolve, nativeToolCalls: [nativeCall('{"who":"小满"}')] });
    expect(d.decision).toBe('tool-request');
    if (d.decision !== 'tool-request') return;
    expect(d.toolCalls).toEqual([nativeCall('{"who":"小满"}')]);
    expect(state.narrations.join('')).toContain('我去问问暗号');
  });

  it('第二层：无 native 时识别正文假调用, 名字带 mcp__ 前缀, 旁白剥净语法', () => {
    const state = createFireSessionState();
    const d = processLLMRound(state, '我去问问暗号。\nget_secret({"who":"小满"})', buildInput(),
      { resolve: mcpResolve });
    expect(d.decision).toBe('tool-request');
    if (d.decision !== 'tool-request') return;
    expect(d.toolCalls[0].function.name).toBe('mcp__get_secret');
    expect(JSON.parse(d.toolCalls[0].function.arguments)).toEqual({ who: '小满' });
    expect(state.narrations.join('')).not.toContain('get_secret(');
  });

  it('模型把带前缀的名字写进正文（native 模式掉格式）也认', () => {
    const state = createFireSessionState();
    const d = processLLMRound(state, 'mcp__get_secret({"who":"小满"})', buildInput(), { resolve: mcpResolve });
    expect(d.decision).toBe('tool-request');
    if (d.decision !== 'tool-request') return;
    expect(d.toolCalls[0].function.name).toBe('mcp__get_secret');   // 不出现 mcp__mcp__
  });

  it('native 与数据标签同轮 → 合并进同一个 tool-request', () => {
    const state = createFireSessionState();
    const d = processLLMRound(state, '[[RECALL: 2026-06]]', buildInput(),
      { resolve: mcpResolve, nativeToolCalls: [nativeCall()] });
    expect(d.decision).toBe('tool-request');
    if (d.decision !== 'tool-request') return;
    const names = d.toolCalls.map((tc) => tc.function.name);
    expect(names).toContain('recall');
    expect(names).toContain('mcp__get_secret');
  });

  it('无 MCP 参与时行为与不传第 4 参完全一致（回归）', () => {
    const a = processLLMRound(createFireSessionState(), '正常收尾文本。', buildInput(), { resolve: mcpResolve });
    const b = processLLMRound(createFireSessionState(), '正常收尾文本。', buildInput());
    expect(a).toEqual(b);
  });

  it('finish 后最终推送正文不含调用语法（防泄漏回归守卫）', () => {
    const state = createFireSessionState();
    processLLMRound(state, '先问暗号。\nget_secret({})', buildInput(), { resolve: mcpResolve });
    const d = processLLMRound(state, '拿到了，暗号是 X。', buildInput(), { resolve: mcpResolve });
    expect(d.decision).toBe('finish');
    if (d.decision !== 'finish') return;
    const all = d.pushPayloads.map((p) => String(p.message)).join('\n');
    expect(all).toContain('先问暗号');
    expect(all).not.toContain('get_secret(');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run worker/amsg/src/agentic.test.ts`
Expected: 新用例 FAIL

- [ ] **Step 3: 实现 processLLMRound**

`worker/amsg/src/agentic.ts`：

imports 追加：

```ts
import {
  extractTextFakedMcpCalls, stripTextFakedMcpCalls,
  type McpFireServer, type McpResolvedToolCore,
} from '../../../utils/mcpFireCore';
```

签名与函数体开头：

```ts
export interface McpRoundInput {
  resolve: Map<string, McpResolvedToolCore<McpFireServer>>;
  /** 本轮 LLM 响应里已按 mcp__ 前缀过滤好的 native tool_calls；文本模式/无调用时缺省。 */
  nativeToolCalls?: ToolCall[];
}

export function processLLMRound(
  state: FireSessionState,
  llmOutputText: string,
  build: PushBuildInput,
  mcp?: McpRoundInput | null,
): RoundDecision {
  // 通用 MCP 两层识别（与前台同构）：native tool_calls 优先；没有 native 时
  // 用前台「兼容模式」同一个解析器从正文里抠 tool_name({...})。两种来源都可能
  // 与数据标签同轮出现，最终合并成同一个 tool-request，executeToolCalls 按
  // mcp__ 前缀分流。正文里出现过的调用语法一律剥掉——它不能进旁白/推送。
  //
  // 正文解析认 mcp__ 前缀名（native 模式下模型在 tools 数组里见到的名字带前缀，
  // 掉格式写进正文时写的也是它）——core 的 alsoMatchPrefix 选项负责，exposedName 回裸名。
  const nativeToolCalls = mcp?.nativeToolCalls ?? [];
  const textCalls = mcp?.resolve.size
    ? extractTextFakedMcpCalls(llmOutputText, mcp.resolve, { alsoMatchPrefix: 'mcp__' })
    : [];
  const scanText = textCalls.length ? stripTextFakedMcpCalls(llmOutputText, textCalls) : llmOutputText;
  // native 在场时正文抠出来的不再入列（同一意图大概率两处都写了；而且库只给
  // assistant 消息合并 decision 里的 toolCalls，native 已含语义）。语法照剥。
  const mcpToolCalls: ToolCall[] = nativeToolCalls.length > 0
    ? nativeToolCalls
    : textCalls.map((c, i) => ({
        // id 只需在一轮的 assistant/tool 消息配对里唯一；用累计工具数做轮间区分度。
        id: `mcp_${state.toolCalls.length}_${i}`,
        type: 'function',
        // exposedName 恒为裸名（alsoMatchPrefix 的命中也回裸名），统一补前缀即可。
        function: { name: `mcp__${c.exposedName}`, arguments: JSON.stringify(c.args) },
      }));

  const result = classifyLLMOutput(scanText);
  const isToolRound = result.kind === 'tool-request' || mcpToolCalls.length > 0;

  if (isToolRound) {
    // MCP-only 轮没有数据标签，整段剥净后的文本都是旁白（与 tag 轮的 prefix 同角色）。
    const narration = result.kind === 'tool-request' ? result.prefix : scanText;
    if (narration.trim()) state.narrations.push(narration);
    if (state.duplicateToolCalls < MAX_DUPLICATE_TOOL_CALLS) {
      return {
        decision: 'tool-request',
        toolCalls: result.kind === 'tool-request' ? [...result.toolCalls, ...mcpToolCalls] : mcpToolCalls,
      };
    }
  }

  // ↓ 原有 finish 段仅两处机械替换：
  //   const thisRound = result.kind === 'tool-request' ? '' : llmOutputText;
  //     → const thisRound = isToolRound ? '' : scanText;
  //   const finalScan = fullText === llmOutputText ? result : classifyLLMOutput(fullText);
  //     → const finalScan = fullText === scanText ? result : classifyLLMOutput(fullText);
  //   （result 是在 scanText 上算的，比对基准跟着换；无 MCP 时 scanText === llmOutputText，行为不变。）
```



- [ ] **Step 4: index.ts onLLMOutput 提取 native**

`worker/amsg/src/index.ts` 的 `processLLMRound(session, content, {...})`（445 行）调用处之前：

```ts
    // native tool_calls：只认 tools 数组里声明过的 mcp__ 名字。模型幻觉出的
    // 未声明调用（比如给 tag 工具编一个 native 调用）丢弃并留日志——直接透传
    // 会让 executeToolCalls 撞上没有 stash 映射的名字。
    const rawToolCalls = (ctx.llmResponse as { choices?: Array<{ message?: { tool_calls?: unknown } }> })
      ?.choices?.[0]?.message?.tool_calls;
    const nativeMcpCalls = (Array.isArray(rawToolCalls) ? rawToolCalls : []).filter((tc: any) => {
      const n = tc?.function?.name;
      const hit = typeof n === 'string' && n.startsWith('mcp__') && !!stash.mcpResolve?.has(n.slice('mcp__'.length));
      if (!hit && tc) console.warn('[amsg:agentic] 丢弃未声明的 native tool_call', { name: tc?.function?.name });
      return hit;
    });
```

调用改为：

```ts
    const decision = processLLMRound(session, content, {
      /* …build 入参不动… */
    }, stash.mcpResolve ? { resolve: stash.mcpResolve, nativeToolCalls: nativeMcpCalls } : null);
```

- [ ] **Step 5: 跑测试 + 构建**

Run: `pnpm vitest run worker/amsg/src/agentic.test.ts && pnpm build:workers`
Expected: 全 PASS + 构建成功

- [ ] **Step 6: Commit**

```bash
git add worker/amsg/src/agentic.ts worker/amsg/src/index.ts worker/amsg/src/agentic.test.ts worker/amsg/worker.bundle.js public/amsg-worker.bundle.js
git commit -m "feat(amsg2): 工具循环归并 native MCP 调用, 正文协议作第二层"
```

---

### Task 8: worker 直连执行 MCP 工具

**Files:**
- Modify: `worker/amsg/src/index.ts`（runMcpFireTool + executeToolCalls 分流）
- Test: `worker/amsg/src/index.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `worker/amsg/src/index.test.ts`：

```ts
import { vi, describe, it, expect, afterEach } from 'vitest';
import { runMcpFireTool } from './index';
import { buildMcpNameMap, createMcpSessionState, type McpFireServer } from '../../../utils/mcpFireCore';

const probe: McpFireServer = {
  id: 's1', name: '探针', url: 'https://probe.example.com/mcp',
  token: 'tok-1', tools: [{ name: 'get_secret', inputSchema: { type: 'object', properties: {} } }],
};
const stashFragment = () => ({ mcpResolve: buildMcpNameMap([probe]), mcpSessions: new Map() });

const rpcOk = (id: number, result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('runMcpFireTool', () => {
  it('握手 + tools/call 直连 server.url, 带 Bearer, 结果 ok', async () => {
    const seen: Array<{ url: string; body: any; auth: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => {
      const body = JSON.parse(init.body);
      seen.push({ url: String(input), body, auth: new Headers(init.headers).get('Authorization') });
      if (body.method === 'initialize') return rpcOk(body.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'p', version: '1' } });
      if (String(body.method).startsWith('notifications/')) return new Response(null, { status: 202 });
      return rpcOk(body.id, { content: [{ type: 'text', text: '暗号 MARKER-123' }] });
    }));
    const result = await runMcpFireTool(stashFragment() as any, 'mcp__get_secret', {});
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).toContain('MARKER-123');
    expect(seen.every((s) => s.url.startsWith('https://probe.example.com/mcp'))).toBe(true);
    expect(seen.every((s) => s.auth === 'Bearer tok-1')).toBe(true);
    expect(seen.map((s) => s.body.method)).toContain('tools/call');
  });

  it('未配置的工具名 → ok:false 而不是抛错（回喂给模型圆场）', async () => {
    const result = await runMcpFireTool(stashFragment() as any, 'mcp__nope', {});
    expect(result).toMatchObject({ ok: false, reason: 'unknown_tool' });
  });

  it('服务器错误 → ok:false 带原因（不炸 fire 链）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const result = await runMcpFireTool(stashFragment() as any, 'mcp__get_secret', {});
    expect(result).toMatchObject({ ok: false });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run worker/amsg/src/index.test.ts`
Expected: 新用例 FAIL（runMcpFireTool 未导出）

- [ ] **Step 3: 实现**

`worker/amsg/src/index.ts`：imports 补 `buildMcpDirectHeaders, callMcpToolCore, formatMcpToolResult`（mcpFireCore）。新增（放在 `amsgHooks` 之前）：

```ts
/**
 * 单个 MCP 调用的超时。总 fire 预算 240s / 最多 5 轮，一个慢服务器不能吃光
 * 整条链（浏览器侧是 60s，那边没有轮次预算压力）。
 */
const MCP_CALL_TIMEOUT_MS = 25_000;

/**
 * 执行一个 mcp__ 前缀的工具调用。永不抛错——失败也以 ok:false 回喂给 LLM
 * 圆场（与 dispatchAgenticTool 的失败语义对齐）。export 只为单测。
 */
export const runMcpFireTool = async (
  stash: Pick<FireStash, 'mcpResolve' | 'mcpSessions'>,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const exposed = name.slice('mcp__'.length);
  const hit = stash.mcpResolve?.get(exposed);
  if (!hit) {
    return { ok: false, reason: 'unknown_tool', message: `未配置的 MCP 工具: ${exposed}` };
  }
  let session = stash.mcpSessions.get(hit.server.id);
  if (!session) {
    session = createMcpSessionState();
    stash.mcpSessions.set(hit.server.id, session);
  }
  const result = await callMcpToolCore(
    { url: hit.server.url, headers: (sid) => buildMcpDirectHeaders(hit.server, sid) },
    session,
    hit.toolName,
    args as Record<string, any>,
    {
      timeoutMs: MCP_CALL_TIMEOUT_MS,
      inputSchema: (hit.server.tools || []).find((t) => t.name === hit.toolName)?.inputSchema,
    },
  );
  return result.success
    ? { ok: true, source: hit.server.name, data: formatMcpToolResult(result.data) }
    : { ok: false, reason: 'mcp_error', source: hit.server.name, message: result.error };
};
```

`executeToolCalls` 里 549 行的一行调用改成分流（dup 闸、toolCalls 记账、回喂沿用原位代码）：

```ts
        const result = name.startsWith('mcp__')
          ? await runMcpFireTool(stash, name, args)
          : await dispatchAgenticTool(name, args, stash.toolCtx);
```

- [ ] **Step 4: 跑测试 + 构建**

Run: `pnpm vitest run worker/amsg/src/index.test.ts worker/amsg/src/agentic.test.ts && pnpm build:workers`
Expected: 全 PASS + 构建成功

- [ ] **Step 5: Commit**

```bash
git add worker/amsg/src/index.ts worker/amsg/src/index.test.ts worker/amsg/worker.bundle.js public/amsg-worker.bundle.js
git commit -m "feat(amsg2): worker 直连执行自配 MCP 工具"
```

---

### Task 9: e2e harness S8（native）+ S8b（正文兜底）

**Files:**
- Modify: `scripts/amsg2-e2e-harness.mjs`

- [ ] **Step 1: 起 mock MCP 服务器（真 HTTP，worker bundle 直连）**

放在既有 worker http 桥之后：

```js
// ─── S8 的 mock MCP 服务器（真 HTTP；worker 直连，不走 fetch 拦截） ───
const MCP_PASSPHRASE = 'HARNESS-MCP-7731';
const mcpSeen = [];
const mcpServer = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  mcpSeen.push(body.method);
  const reply = (obj, extra = {}) => {
    res.writeHead(200, { 'content-type': 'application/json', ...extra });
    res.end(JSON.stringify(obj));
  };
  if (body.method === 'initialize') {
    return reply(
      { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'harness-mcp', version: '1.0.0' } } },
      { 'Mcp-Session-Id': 'harness-session' },
    );
  }
  if (String(body.method).startsWith('notifications/')) { res.writeHead(202); return res.end(); }
  if (body.method === 'tools/call' && body.params?.name === 'get_secret_word') {
    return reply({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `暗号是 ${MCP_PASSPHRASE}` }] } });
  }
  reply({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `method not found: ${body.method}` } });
});
await new Promise((r) => mcpServer.listen(0, '127.0.0.1', r));
const MCP_URL = `http://127.0.0.1:${mcpServer.address().port}`;
const MCP_TOOL_CONFIG = (useNative) => JSON.stringify({
  v: 1, proxyWorkerUrl: '', newsEnabled: false, notionEnabled: false, feishuEnabled: false,
  mcpUseNativeTools: useNative,
  mcpServers: [{
    id: 'srv1', name: '暗号服务器', url: MCP_URL,
    tools: [{ name: 'get_secret_word', description: '取回今日暗号', inputSchema: { type: 'object', properties: { asked_by: { type: 'string' } } } }],
  }],
});
```

末尾收尾处补 `mcpServer.close()`。

- [ ] **Step 2: mock LLM 加路由分支（native 回 tool_calls，text 回正文调用）**

在 llm.test 分支里（`FROZEN_char-frozen` 之前）插入；注意 native 分支返回的是**完整 message 对象**：

```js
    } else if (all.includes('FIREPACK_FRESH_char-mcp-native') && !hasToolResult) {
      return new Response(JSON.stringify({ choices: [{ message: {
        role: 'assistant', content: '我问问那边今天的暗号。',
        tool_calls: [{ id: 'call_mcp_1', type: 'function', function: { name: 'mcp__get_secret_word', arguments: '{"asked_by":"小满"}' } }],
      } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    } else if (all.includes('FIREPACK_FRESH_char-mcp-native') && hasToolResult) {
      const toolText = req.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');
      const m = toolText.match(/HARNESS-MCP-\w+/);
      content = `拿到了，今天的暗号是 ${m ? m[0] : '（工具结果里没找到）'}。`;
    } else if (all.includes('FIREPACK_FRESH_char-mcp-text') && !hasToolResult) {
      content = '我问问那边今天的暗号。\nget_secret_word({"asked_by":"小满"})';
    } else if (all.includes('FIREPACK_FRESH_char-mcp-text') && hasToolResult) {
      const toolText = req.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');
      const m = toolText.match(/HARNESS-MCP-\w+/);
      content = `拿到了，暗号是 ${m ? m[0] : '（没找到）'}。`;
```

- [ ] **Step 3: S8 + S8b 场景（照 S3 的 helper 用法）**

放在 S7 之后：

```js
  section('S8 通用 MCP（native）：tools 声明 → native tool_calls → worker 直连 → 暗号进 push');
  {
    const now = Date.now();
    await putState([
      { namespace: NS('char-mcp-native'), key: 'fire_pack', value: JSON.stringify(firePack('FIREPACK_FRESH_char-mcp-native', now - 3600_000)), updatedAt: now },
      { namespace: NS('char-mcp-native'), key: 'tool_pack', value: JSON.stringify(toolPack('小满')), updatedAt: now },
      { namespace: 'amsg:global', key: 'tool_config', value: MCP_TOOL_CONFIG(true), updatedAt: now },
    ]);
    const fireAt = new Date(now + 1000);
    const { payload } = aiTaskPayload({
      charId: 'char-mcp-native', charName: '小满', mode: 'auto',
      firstSendTime: fireAt.toISOString(), recurrenceType: 'none', expirePolicy: 'force',
      anchorMs: now - 3600_000, taskInstruction: '把今天的暗号告诉用户。',
      frozenPrompt: 'FROZEN_char-mcp-native（不应被用到）',
    });
    const sched = await scheduleTask(payload);
    check('schedule(MCP native) 成功', sched?.success === true, JSON.stringify(sched?.error || sched));
    const llmBefore = llmRequests.length;
    const seenBefore = mcpSeen.length;
    await sleep(1400);
    await runCron();

    const reqs = llmRequests.slice(llmBefore);
    check('native 场景走了 2 轮 LLM', reqs.length === 2, `got ${reqs.length}`);
    check('第 1 轮请求体声明 tools（mcp__ 前缀）',
      Array.isArray(reqs[0]?.tools) && reqs[0].tools.some((t) => t?.function?.name === 'mcp__get_secret_word'),
      JSON.stringify(reqs[0]?.tools));
    const r1c = reqs[0]?.messages?.map((m) => String(m.content)).join('\n') || '';
    check('native 模式提示词块不教正文协议', r1c.includes('暗号服务器') && !r1c.includes('tool_name({"参数":"值"})'));
    const rpc = mcpSeen.slice(seenBefore);
    check('worker 对 MCP 服务器完成 initialize + tools/call', rpc.includes('initialize') && rpc.includes('tools/call'), JSON.stringify(rpc));
    const round2 = reqs[1]?.messages || [];
    const assistant = round2.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    check('第 2 轮 assistant 带 native tool_calls（配对完整）', assistant?.tool_calls?.[0]?.id === 'call_mcp_1');
    const toolMsg = round2.find((m) => m.role === 'tool');
    check('第 2 轮回喂含 MCP 结果', String(toolMsg?.content || '').includes(MCP_PASSPHRASE), String(toolMsg?.content || '').slice(0, 160));
    const mine = pushes.filter((p) => p.tag === 'char-mcp-native');
    check('最终 push 携带 MCP 取回的暗号',
      mine.some((m) => String(m.payload?.message || '').includes(MCP_PASSPHRASE)),
      JSON.stringify(mine.map((m) => m.payload?.message)));
    check('旁白保序进 push', mine.some((m) => String(m.payload?.message || '').includes('问问那边')));
  }

  section('S8b 通用 MCP（正文兜底）：mcpUseNativeTools=false → 请求不带 tools → 正文协议');
  {
    const now = Date.now();
    await putState([
      { namespace: NS('char-mcp-text'), key: 'fire_pack', value: JSON.stringify(firePack('FIREPACK_FRESH_char-mcp-text', now - 3600_000)), updatedAt: now },
      { namespace: NS('char-mcp-text'), key: 'tool_pack', value: JSON.stringify(toolPack('小满')), updatedAt: now },
      { namespace: 'amsg:global', key: 'tool_config', value: MCP_TOOL_CONFIG(false), updatedAt: now },
    ]);
    const fireAt = new Date(now + 1000);
    const { payload } = aiTaskPayload({
      charId: 'char-mcp-text', charName: '小满', mode: 'auto',
      firstSendTime: fireAt.toISOString(), recurrenceType: 'none', expirePolicy: 'force',
      anchorMs: now - 3600_000, taskInstruction: '把今天的暗号告诉用户。',
      frozenPrompt: 'FROZEN_char-mcp-text（不应被用到）',
    });
    const sched = await scheduleTask(payload);
    check('schedule(MCP text) 成功', sched?.success === true, JSON.stringify(sched?.error || sched));
    const llmBefore = llmRequests.length;
    await sleep(1400);
    await runCron();

    const reqs = llmRequests.slice(llmBefore);
    check('text 场景走了 2 轮 LLM', reqs.length === 2, `got ${reqs.length}`);
    check('请求体不带 tools', reqs.every((r) => !('tools' in r)), JSON.stringify(Object.keys(reqs[0] || {})));
    const r1c = reqs[0]?.messages?.map((m) => String(m.content)).join('\n') || '';
    check('text 模式提示词块教正文协议', r1c.includes('get_secret_word(') && r1c.includes('tool_name({"参数":"值"})'));
    const mine = pushes.filter((p) => p.tag === 'char-mcp-text');
    check('最终 push 携带暗号且无调用语法残留',
      mine.some((m) => String(m.payload?.message || '').includes(MCP_PASSPHRASE)) &&
      mine.every((m) => !String(m.payload?.message || '').includes('get_secret_word(')),
      JSON.stringify(mine.map((m) => m.payload?.message)));
  }
```

- [ ] **Step 4: 全量跑 harness + 单测**

Run: `pnpm build:workers && node scripts/amsg2-e2e-harness.mjs && pnpm vitest run`
Expected: S0–S8b 全 ✅（S0–S7 绿 = 零回归），单测全 PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/amsg2-e2e-harness.mjs
git commit -m "test(amsg2): e2e harness 补通用 MCP 场景（native + 正文兜底）"
```

---

### Task 10: 文档同步

**Files:**
- Modify: `docs/mcp-user-guide.md`
- Modify: `docs/mcp-client.md`

- [ ] **Step 1: 用户教程补一节**

`docs/mcp-user-guide.md` 末尾追加（平铺直叙，未发布特性不写迁移叙述）：

```markdown
## 主动消息里也能用

配好的 MCP 工具在定时主动消息（主动消息 2.0）里同样可用：角色到点想用工具时，
由你部署的 amsg worker 直接连你的 MCP 服务器，不需要浏览器开着。

需要满足的条件：
- amsg worker 是较新的部署（设置页会在版本过旧时提示重新粘贴）；
- 服务器地址是公网可访问的（`localhost` 或局域网地址只有你的浏览器够得着，
  worker 连不上，这类服务器不会带进主动消息）；
- 服务器在设置里处于启用状态、且已「发现工具」。

代理设置对主动消息不生效：worker 在服务端直连你填的服务器地址，没有浏览器的
跨域限制，所以不需要代理。绑定聊天的设置照常生效——绑定了角色的服务器只有
那个角色的主动消息能用。「兼容模式」开关也照常生效：关掉后主动消息同样改用
正文方式调工具，适合拒绝 tools 参数的中转。

改动 MCP 配置后会自动同步到云端；下一次到点的主动消息用的就是新配置。
```

- [ ] **Step 2: 开发者文档补一节**

`docs/mcp-client.md` 追加：

```markdown
## amsg2 后台路径

主动消息 2.0 的 worker 到点调 MCP 走与前台不同的一条链：

- 配置：`mcpClient.collectMcpFireServers()` 把 enabled + 已发现工具 + 公网地址的
  服务器（含 token/customHeaders，剥代理字段）与「兼容模式」开关一起作为
  `tool_config.mcpServers` / `mcpUseNativeTools` 随 client_state 加密通道上云
  （`activeMsgClient.buildToolConfigEntry` 唯一咽喉）。
- 提示词与 tools：worker 在 onBeforeFire 用 `mcpFireCore.buildMcpFireBlock` /
  `buildMcpFireTools` 从 tool_config 现场生成——与凭据同源，不经过 fire_pack。
  amsg-server 带 `agentic-fire-tools` feature 的版本起，fire 循环透传 tools 请求参数。
- 调用识别（与前台同构的两层）：native tool_calls 优先；没有 native 时用前台
  「兼容模式」同一个解析器（`extractTextFakedMcpCalls`）从正文抠
  `tool_name({...})`。统一 `mcp__` 前缀路由。
- 执行：`executeToolCalls` 按前缀分流到 `runMcpFireTool`，worker 直连
  `server.url`（服务端 fetch 无 CORS），单次调用超时 25s。
- 纯逻辑都在 `utils/mcpFireCore.ts`（环境无关叶子，进 worker bundle，禁加浏览器
  依赖）；浏览器侧 mcpClient/mcpToolBridge 委托同一份实现。
- 版本歪斜可见：capabilities 的 `agentic-fire-tools` + 设置页版本门槛，
  老 worker 不会静默吞掉 MCP 配置。

回归守卫：`scripts/amsg2-e2e-harness.mjs` S8/S8b + `worker/amsg/src/agentic.test.ts`、
`index.test.ts`、`utils/mcpFireCore.test.ts` + ReiStandard `agentic-fire.test.mjs`。
```

- [ ] **Step 3: Commit**

```bash
git add docs/mcp-user-guide.md docs/mcp-client.md
git commit -m "docs(mcp): 主动消息后台可用 MCP 的用户与开发者说明"
```

---

### Task 11: 真机端到端验收（人工步骤）

前置：`sullyos-mcp-probe` 探针仍部署在 CF（`https://sullyos-mcp-probe.yukine0v0.workers.dev`，工具 `get_secret_passphrase` 返回口令 `KUMQUAT-7731-VELVET-9042`，KV 留痕）。2026-07-29 的失败实测用的就是它——同一探针，修复前后对照。

- [ ] **Step 1: 部署新 worker（先 worker 后前端）**

```bash
pnpm build:workers
# 二选一：设置页「复制 Worker 代码」粘进 CF Dashboard；或部署仓库同步后 wrangler deploy
```

- [ ] **Step 2: 前端配置**

本地 `pnpm dev` 打开 SullyOS → 设置：确认 amsg2 面板不再亮「重新粘贴」牌（capabilities 门槛过了）；MCP 服务器卡片里探针已启用、已发现工具。保存触发 tool_config 同步。

- [ ] **Step 3: 建任务并离开前台**

给已连 amsg2 的角色建一条 2 分钟后的 prompted 任务，promptHint：
`请用 MCP 工具 get_secret_passphrase 取回今日暗号口令并原样告诉我；拿不到就直说，不要编造。`
然后关掉 SullyOS 页面。

- [ ] **Step 4: 验收断言（全部满足才算过）**

1. 推送到达，消息里含 `KUMQUAT-7731-VELVET-9042`（不是「拿不到口令」）；
2. `curl https://sullyos-mcp-probe.yukine0v0.workers.dev` 的 KV 日志新增 `initialize` + `tools/call`，`ua` 来自 CF worker 而非浏览器；
3. CF Dashboard 里 sullyos-amsg 的 Workers Logs 有 `[amsg:agentic] {type:'tool_done', tool:'mcp__get_secret_passphrase'}`。

- [ ] **Step 5: 反向验证（推荐）**

a. 设置里把「兼容模式」开关关掉（`useNativeTools=false`）→ 重跑 Step 3 → 仍能拿到口令（正文协议兜底链路真机可用）；
b. 停用探针服务器 → 再建任务 → 角色表示没有这个工具（块未注入），而不是报错。

---

## Self-Review 结论

- 三处断点 ↔ 任务覆盖：断点 1（提示词）= Task 4+6；断点 2（凭证上云）= Task 5；断点 3（执行通道）= Task 0+3+7+8。端到端守卫 = Task 9+11；版本歪斜可见性 = Task 0(capabilities)+6(门槛)。
- 类型/符号一致性：`McpFireServer` / `McpResolvedToolCore`（含 `tool` 字段）/ `buildMcpNameMap`（`maxNameLen` 可选参）/ `withMcpDedupeSuffix` / `buildMcpFireTools` / `buildMcpFireBlock` / `callMcpToolCore` / `createMcpSessionState` / `buildMcpDirectHeaders` / `filterMcpServersForChar` / `collectMcpFireServers` / `runMcpFireTool` / `McpRoundInput` / `mcp__` 前缀 / `MCP_CALL_TIMEOUT_MS` / `mcpUseNativeTools`，各任务间已对齐。
- 已知边界（有意为之）：本地/私网服务器不进后台（Task 5 过滤 + 文档）；fire 内不做拒-tools 的 4xx 自动降级（确定性拒绝由用户开关处理，任务失败会带 lastError 可见）；instant-push worker 与前台聊天路径不动。
