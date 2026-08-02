import React, { useEffect, useRef, useState } from 'react';
import Modal from '../os/Modal';
import { ActiveMsg2GlobalConfig, RealtimeConfig } from '../../types';
import { ActiveMsgClient, ActiveMsg2PushStatus, readAmsgFailKind } from '../../utils/activeMsgClient';
import { ActiveMsgStore, maskActiveMsgUserId } from '../../utils/activeMsgStore';
import { cancelAllRemoteAmsgTasks, isWorkerUrlCleared } from '../../utils/amsgStateSync';
import {
  buildCloudflareDashboardUrl,
  isInstantConfigReady,
  loadInstantConfig,
  saveInstantConfig,
} from '../../utils/instantPushClient';
import { generateClientToken } from '../../utils/vapidGen';
import { isAmsgServerVersionAtLeast } from '../../utils/amsgWorkerVersion';
import { trackEvent } from '../../utils/analytics';

// 满血链路吃满这些 worker 特性（amsg-server 2.6.0-next.4+）。探测不到端点（老部署
// 404 → null）或缺任何一项，就亮「重新部署」提示——worker 跑在用户自己的账号里，
// 站点这边发新版不会自动同步过去。
const REQUIRED_WORKER_FEATURES = [
  'client-state',
  'client-state-chunking',
  'agentic-hooks',
  'agentic-scratch',
  // 后台 fire 每轮把 tools 参数带给 LLM（角色在主动消息里用得上用户自配的 MCP 工具）。
  'agentic-fire-tools',
  // hook 载荷自带 readState / writeState，配置级 hook 不用再自己攒一份写口。
  'hook-state-accessors',
  // onAfterSend 拿到本次 fire 的 scratch：自述回写按真正送出去的段数落账。
  'after-send-scratch',
  // 任务身份直接挂在 ctx 和 push 顶层，两条排程路径不用各抄一份 metadata。
  'fire-task-identity',
  'push-task-identity',
  // 库导出信封余量常量，push 体积按「库补完字段之后」的尺寸算。
  'push-envelope-reserved-bytes',
  // 角色自排撞车时回已存在那行的投影，重跑那轮也记得下账。
  'schedule-task-duplicate-row',
  // 循环任务的过期快进也回调，攒下的那几次跳过在面板上看得见。
  'recurring-stale-skip-hook',
  // 任务行带时区，daily / weekly 按角色所在时区的墙钟推进。
  'task-timezone',
  // 推送订阅按用户存一份，排程不再携带；换订阅后已排的任务自动跟上。
  'user-push-subscription',
];
// features 之外还必须比版本：这波依赖的能力大多没发独立 flag，光查 features 分不出新旧。
//   next.5 — GET /messages 投影（charId/clientTaskId）、onBeforeFire 的 { skip } 出口
//   next.6 — 任务占位租约（带工具的 AI 任务常跑过一分钟，没有占位会被相邻 cron tick 重复推）
//   next.7 — hook 的 writeState（大内容旁路存 client_state）、Web Push payload 大小护栏
//   next.8 — fire 循环透传 tools 请求参数（后台调用户自配 MCP 的前置）
//   next.9 — 这一档还兼做「bundle 里有没有自述回写」的判据：角色发完把正文记回
//            client_state、下次到点接着说（fire_pack 的 self_log 槽位），是随本波
//            bundle 一起上去的。旧 bundle 收到带槽位的 fire_pack 只会把
//            `{{AMSG_SELF_LOG}}` 原样发给 LLM，而 SERVER_VERSION 是打包时那份
//            amsg-server 的版本号，正好能把这类旧粘贴认出来。
//   next.11 — 推送订阅改成按用户存一份：这一档起排程不再携带订阅，前端走
//            /push-subscription 端点登记，旧 worker 上这个端点不存在。
//   next.12 — 「角色说过什么」的落盘改挂在 onFireSettled 上（不论这次是发出去了、
//            跳过了还是抛错了都调一次）。旧 worker 认不得这个 hook，会把它当成
//            无关配置直接忽略——而 bundle 这边已经不再用 onAfterSend，表现就是
//            self_log 永远不写：角色到点不知道自己上次说过什么，天天重复同一句。
//            同一档还带 run-tick 的同角色任务串行（serializeBy）。
// 不比版本的话，旧粘贴部署会被误判为最新，问题全在 worker 侧静默发生。
const REQUIRED_WORKER_VERSION = '2.6.0-next.12';

/** 装着打包好的 worker 代码的部署仓库：fork 它 → 在 Cloudflare 连上 → 以后点 Sync fork 更新。 */
const WORKERS_REPO_URL = 'https://github.com/Tosd0/sullyos-workers';
const SETUP_WALKTHROUGH_URL = 'https://github.com/qegj567-cloud/SullyOS/blob/master/docs/amsg2-setup-walkthrough.md';

// 探测结果每次会话只报一次。refresh() 在开面板、连接成功、订阅成功后都会跑一遍，
// 一个连不上、反复点「连接」的人否则能一个人刷出十几条同样的结果，把分布带歪。
let workerCapsReported = false;

/** 刚生成的密钥明文：输入框是 password 型，只能在这一处让用户看见并手动复制。 */
const SecretReveal: React.FC<{ value: string; className?: string }> = ({ value, className = '' }) => (
  <p className={`font-mono text-[10px] leading-relaxed text-slate-500 break-all bg-white border border-slate-200 rounded-xl px-2 py-1.5 ${className}`}>
    {value}
  </p>
);

interface ActiveMsgGlobalSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** 「清除云端状态」清完要立刻把工具凭据补传回去，所以这里需要当前这份配置。 */
  realtimeConfig: RealtimeConfig;
  /** 由 Settings 注入：点「去推送凭据面板」时打开顶层 PushVapidSettingsModal */
  onOpenVapid?: () => void;
}

const ActiveMsgGlobalSettingsModal: React.FC<ActiveMsgGlobalSettingsModalProps> = ({
  isOpen,
  onClose,
  addToast,
  realtimeConfig,
  onOpenVapid,
}) => {
  const [config, setConfig] = useState<ActiveMsg2GlobalConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  // 手动粘贴部署：给没有 GitHub 账号的人留的退路，默认收着不干扰主流程。
  const [pasteFallbackOpen, setPasteFallbackOpen] = useState(false);
  const [pushStatus, setPushStatus] = useState<ActiveMsg2PushStatus | null>(null);
  // 「生成 Master Key」只在本次打开期间展示，前端不落盘——它是 worker 侧密钥，粘进 CF env 即可。
  const [generatedMasterKey, setGeneratedMasterKey] = useState('');
  const [generatedServerToken, setGeneratedServerToken] = useState('');

  const [workerOutdated, setWorkerOutdated] = useState(false);
  // Instant Push 也开着：聊天会走它，2.0 挂在本地那条路上的几样东西全静默失效（见
  // amsg2InstantConflict）。开面板时读一次，用户在这里关掉 instant 后立刻更新。
  const [instantOn, setInstantOn] = useState(false);

  // 特性探测：确认「过老」（端点 404 → null，或缺关键特性）才亮牌；
  // 探测本身失败（断网 / 密钥不对 / 没填地址）不亮，避免误报。
  const probeWorkerCaps = async (workerConfigured: boolean) => {
    // 只有配了地址才报：没填地址时这次探测必然失败，那不是版本问题。
    const shouldReport = workerConfigured && !workerCapsReported;
    if (shouldReport) workerCapsReported = true;
    try {
      const caps = await ActiveMsgClient.getCapabilities();
      const missingFeature = !caps || REQUIRED_WORKER_FEATURES.some((f) => !caps.features.includes(f));
      const versionTooOld = !caps || !isAmsgServerVersionAtLeast(caps.serverVersion, REQUIRED_WORKER_VERSION);
      setWorkerOutdated(missingFeature || versionTooOld);
      // 跑着旧 worker 的表现是**静默错**（自述回写不落盘、任务重复推），用户不会来报，
      // 面板这一句提示是唯一的出口。这里数的就是「有多少人正跑着一个不该跑的版本」。
      if (shouldReport) {
        trackEvent('探测 2.0 Worker 能力', {
          result: !caps ? '端点不存在' : missingFeature ? '缺特性' : versionTooOld ? '版本过旧' : 'ok',
        });
      }
    } catch {
      setWorkerOutdated(false);
      // 探测本身炸了（断网 / 地址不通）不亮牌，免得误报；但它跟「版本旧」是两回事，
      // 单独占一格，看分布时能一眼把这批人排除掉。
      if (shouldReport) trackEvent('探测 2.0 Worker 能力', { result: '探测失败' });
    }
  };

  // 已经存过盘的那个 Worker 地址。清空确认要用它：确认之前不能换地址，
  // 取消远端任务的那几个请求还得发到旧那台上去。
  const savedWorkerUrlRef = useRef('');

  const refresh = async () => {
    const nextConfig = await ActiveMsgClient.getGlobalConfig();
    const nextPushStatus = await ActiveMsgClient.getPushStatus();
    savedWorkerUrlRef.current = nextConfig.workerUrl || '';
    setConfig(nextConfig);
    setPushStatus(nextPushStatus);
    setInstantOn(isInstantConfigReady());
    void probeWorkerCaps(Boolean(nextConfig.workerUrl?.trim()));
  };

  /** 关掉 Instant Push 的开关，worker 地址等配置留着——以后想切回去不用重填。 */
  const disableInstantPush = () => {
    saveInstantConfig({ ...loadInstantConfig(), enabled: false });
    setInstantOn(false);
    addToast('已关闭 Instant Push，聊天回到本地直连。', 'success');
  };

  useEffect(() => {
    if (!isOpen) return;
    setAdvancedOpen(false);
    setDeployOpen(false);
    setPasteFallbackOpen(false);
    // 两个明文密钥都要清：留到下次打开面板还挂在页面上，就是白白多摊一次。
    setGeneratedMasterKey('');
    setGeneratedServerToken('');
    void refresh();
  }, [isOpen]);

  /**
   * 地址被清空时的收尾：先问一句，再拿**旧地址**把远端任务取消干净，最后才存空值。
   *
   * 光存空值的话，前端这边所有同步立刻停摆，D1 里的任务却一条没少：cron 每分钟照常
   * 消费、照烧 LLM、照推送（推送订阅也还在），只是内容永远停在最后一次同步的样子。
   * 用户以为自己关掉了一切，实际只是把自己变成了看不见的那一方。
   */
  const confirmAndClearRemote = async (): Promise<boolean> => {
    const ok = confirm('清空 Worker 地址会把远端还挂着的主动消息任务一并取消，确定吗？\n\n不取消的话，那些任务仍会按时触发并给你推送，而这边已经管不到它们了。');
    if (!ok) return false;
    const { total, failed, listed } = await cancelAllRemoteAmsgTasks();
    if (!listed) {
      addToast('远端任务没能取消，可能还挂在那儿照常触发。建议把地址填回去，到角色的主动消息面板里逐个处理。', 'error');
    } else if (failed > 0) {
      addToast(`还有 ${failed} 个远端任务取消失败，建议恢复地址后在面板处理。`, 'error');
    } else if (total > 0) {
      addToast(`已取消远端 ${total} 个任务。`, 'info');
    }
    return true;
  };

  const persistGlobalConfig = async () => {
    if (!config) return;
    if (isWorkerUrlCleared(savedWorkerUrlRef.current, config.workerUrl)) {
      if (!await confirmAndClearRemote()) {
        // 用户反悔：把地址填回输入框，别留一个「界面空着、库里还存着」的错位。
        patchConfig({ workerUrl: savedWorkerUrlRef.current });
        return;
      }
    }
    await ActiveMsgStore.saveGlobalConfig({
      workerUrl: config.workerUrl,
      serverToken: config.serverToken,
    });
    savedWorkerUrlRef.current = config.workerUrl || '';
  };

  useEffect(() => {
    if (!isOpen || !config) return;
    const timer = setTimeout(() => { void persistGlobalConfig(); }, 1000);
    return () => clearTimeout(timer);
  }, [config?.workerUrl, config?.serverToken, isOpen]);

  const patchConfig = (updates: Partial<ActiveMsg2GlobalConfig>) => {
    setConfig((prev) => ({
      ...(prev || { userId: '', workerUrl: '' }),
      ...updates,
    }));
  };

  const handleCreateSubscription = async () => {
    setLoading(true);
    try {
      await ActiveMsgClient.ensurePushSubscription();
      await refresh();
      addToast('通知权限和推送订阅已准备完成。', 'success');
      trackEvent('开启通知与推送订阅', { result: 'ok' });
    } catch (error: any) {
      addToast(error?.message || '创建推送订阅失败。', 'error');
      // 只报抛错那一刻挂上的代号（源码里写死的枚举）。错误原文可能带 push endpoint，
      // 留在 toast 和 console 里，不进上报。
      trackEvent('开启通知与推送订阅', { result: readAmsgFailKind(error) });
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = async () => {
    if (!config?.workerUrl.trim()) {
      addToast('先把你部署的 Worker 地址填进来。', 'error');
      return;
    }

    setLoading(true);
    try {
      await ActiveMsgStore.saveGlobalConfig({
        workerUrl: config.workerUrl,
        serverToken: config.serverToken,
      });
      await ActiveMsgClient.connect();
      await refresh();
      addToast('已连接成功，主动消息 2.0 可以用了。', 'success');
      // 只报「这次连接成没成 / 卡在哪一类」。连接串 / tenantToken / 错误原文一概不带，
      // 也不报「之前配没配过 tenant」——那等于把两项凭据的配置状态压成一位发出去。
      // 失败代号是抛错时按 HTTP 状态挂上的字面量（见 activeMsgClient 的 AmsgFailKind），
      // 分开是因为「密钥对不上」和「D1 没绑」要用户去改的地方完全不同。
      trackEvent('连接并启用主动消息 2.0', { result: 'ok' });
    } catch (error: any) {
      addToast(error?.message || '连接失败。', 'error');
      trackEvent('连接并启用主动消息 2.0', { result: readAmsgFailKind(error) });
    } finally {
      setLoading(false);
    }
  };

  // 手动粘贴部署用。主流程是 fork sullyos-workers + 在 CF 连 Git，这条是给没有 GitHub
  // 账号的人留的退路，所以在面板里收在折叠区里。
  const handleCopyWorkerBundle = async () => {
    try {
      await ActiveMsgClient.copyWorkerBundleToClipboard();
      addToast('Worker 代码已复制，去 CF 后台的 Edit code 里粘贴覆盖。', 'success');
      trackEvent('复制 2.0 Worker 代码', { result: 'ok' });
    } catch (error: any) {
      addToast(`复制失败（${error?.message || error}）。也可以从仓库 worker/amsg/worker.bundle.js 获取。`, 'error');
      // 剪贴板 API 在非 HTTPS / 部分 WebView 里会直接抛，这条就是那批人的规模。
      trackEvent('复制 2.0 Worker 代码', { result: 'failed' });
    }
  };

  /**
   * 把刚生成的密钥交给用户：存进 state 供展示 + 尽量复制到剪贴板。
   * 输入框是 password 型看不见内容，所以生成时必须把值显示出来，
   * 否则「把同样的值填进 Worker 环境变量」这一步没法做。
   *
   * 复制和展示的都是 `变量名=值` 整行。Cloudflare 的 Variables and secrets
   * 认这个格式：粘一行进去会自动拆成变量名和值两栏，不用自己对着抄名字。
   * 剪贴板不可用时用户是从下方手抄的，所以展示的那份也得带变量名。
   */
  const revealAndCopy = async (value: string, reveal: (v: string) => void, envName: string) => {
    const envLine = `${envName}=${value}`;
    reveal(envLine);
    try {
      await navigator.clipboard.writeText(envLine);
      addToast(`已复制 ${envName} 整行，粘进 Worker 的 Variables 会自动填好名字和值。`, 'success');
    } catch {
      addToast('已生成，请手动从下方复制整行。', 'info');
    }
  };

  const handleGenerateMasterKey = () => {
    // 只报「生成了哪一个」。密钥本体只在这次面板打开期间存在于 state，前端不落盘，
    // 更不会进上报。
    trackEvent('生成 2.0 Worker 密钥', { which: 'master_key' });
    return revealAndCopy(ActiveMsgClient.generateMasterKey(), setGeneratedMasterKey, 'AMSG_MASTER_KEY');
  };

  const handleClearClientState = async () => {
    if (!confirm('确定清空云端状态？Worker D1 里同步的角色上下文（fire_pack）会全部删除。在下一次聊天重新同步之前，已排程的 AI 任务到点会失败；固定消息任务不受影响。')) return;
    setLoading(true);
    try {
      // 工具凭据在清空的同一步就补回去了（见 clearClientState）：它不像角色上下文那样
      // 每轮聊天重传，不当场补的话之后没人会补，AI 任务会一直失败。
      const { deleted, toolConfigRestored } = await ActiveMsgClient.clearClientState(realtimeConfig);
      addToast(
        toolConfigRestored
          ? `已清空云端状态（${deleted} 条）。`
          : `已清空云端状态（${deleted} 条），但工具凭据没能补传回去——请到「实时感知」里重新保存一次配置，否则已排程的 AI 任务会一直失败。`,
        toolConfigRestored ? 'success' : 'error',
      );
    } catch (error: any) {
      addToast(error?.message || '清除云端状态失败。', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateServerToken = () => {
    const token = generateClientToken();
    patchConfig({ serverToken: token });
    trackEvent('生成 2.0 Worker 密钥', { which: 'server_token' });
    return revealAndCopy(token, setGeneratedServerToken, 'AMSG_SERVER_TOKEN');
  };

  if (!config) return null;

  const isConnected = Boolean(config.initializedAt);

  return (
    <Modal
      isOpen={isOpen}
      title="主动消息 2.0"
      onClose={onClose}
      footer={(
        <button
          onClick={onClose}
          className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform"
        >
          关闭
        </button>
      )}
    >
      <div className="space-y-4 text-sm text-slate-600">
        <div className="bg-violet-50 border border-violet-100 rounded-2xl p-4 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="font-bold text-slate-700">连接方式</span>
            <span className="px-3 py-1 rounded-full bg-violet-500 text-white text-xs font-bold">自部署 Worker</span>
          </div>
          <p className="text-xs leading-relaxed text-violet-700">
            角色到点自动给你发消息，App 关着也能收。你自己部署一个 Cloudflare Worker（自带 D1 数据库 + 定时触发），把地址填在下面即可。
          </p>
          <p className="text-[11px] leading-relaxed text-violet-600/80">
            和「Instant Push」不同：Instant 是你发消息才即时回；这个是到点主动推。
          </p>
        </div>

        {/* 两个都开着时聊天走 Instant，2.0 挂在本地那条路上的东西全静默失效。
            没有报错也没有提示，只会表现成「这功能怎么不响」——所以在这儿说清楚。 */}
        {instantOn ? (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 space-y-2">
            <div className="font-bold text-amber-900 text-sm">Instant Push 也开着</div>
            <p className="text-xs leading-relaxed text-amber-800">
              两个都开时聊天走 Instant Push，主动消息 2.0 里挂在聊天上的这三样不会生效：
            </p>
            <ul className="text-xs leading-relaxed text-amber-800 space-y-1 list-disc list-outside pl-4">
              <li>角色在聊天里排任务、取消任务（工具不会跟着请求发出去）</li>
              <li>角色知道自己有哪些任务在排（排程现状同样发不出去）</li>
              <li>
                防打断——你正聊着的时候，到点的主动消息不会自动让路，可能直接弹出来
              </li>
            </ul>
            <p className="text-xs leading-relaxed text-amber-800">
              <strong>到点推送本身照常工作</strong>，受影响的只有上面这些。两边各管一件事：Instant 让「发完消息就关掉 App」
              也能收到回复，2.0 管到点主动找你，所以并不是谁替代谁，按你更需要哪个来留。
            </p>
            <button
              type="button"
              onClick={disableInstantPush}
              className="w-full py-2.5 bg-amber-500 text-white text-xs font-bold rounded-xl active:scale-95 transition-transform"
            >
              关掉 Instant Push（保留它的配置）
            </button>
          </div>
        ) : null}

        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <button
            type="button"
            onClick={() => setDeployOpen((prev) => {
              // 只在展开时记一笔：收起也记的话同一个人会被数两次，漏斗第一格直接虚高一倍。
              if (!prev) trackEvent('展开 2.0 部署指引', { mode: '主流程' });
              return !prev;
            })}
            className="w-full flex items-center justify-between text-left"
          >
            <span className="font-bold text-slate-700">部署 Worker（第一次用先做这个）</span>
            <span className="text-xs font-bold text-slate-400">{deployOpen ? '收起' : '展开'}</span>
          </button>

          {deployOpen ? (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-slate-500">
                全程在网页上点，不用装东西也不用敲命令，大约 15 分钟。第一次做建议直接照着
                <strong>图文教程</strong>走，下面是简版。
              </p>

              <ol className="text-xs leading-relaxed text-slate-500 space-y-1.5 list-decimal list-outside pl-4">
                <li>
                  Fork 后端仓库 <code className="font-mono">sullyos-workers</code>
                  （页面右上角 Fork → Create fork）。
                </li>
                <li>
                  CF 后台 Storage &amp; databases → <strong>D1 SQLite Database</strong> 建一个库，
                  把它的 <strong>Database ID</strong> 复制下来。表不用建，下面点「连接」时会自动建好。
                </li>
                <li>
                  CF 后台 Workers &amp; Pages → <strong>Create application</strong> →
                  <strong> Continue with GitHub</strong>，选中你 fork 的仓库，然后填：
                  <ul className="mt-1 space-y-0.5 list-disc list-outside pl-4">
                    <li>Build command：<code className="font-mono">sh ./deploy-prepare.sh</code></li>
                    <li>Advanced settings → Path：<code className="font-mono">/amsg</code></li>
                    <li>
                      Advanced settings 里加一个构建变量
                      <code className="font-mono"> D1_DATABASE_ID </code>
                      = 上一步的 Database ID（<strong>别点 Encrypt</strong>，构建时要读它）
                    </li>
                  </ul>
                </li>
                <li>部署完在 Settings → Variables and secrets 按下面的清单填密钥，再 Deploy 一次。</li>
              </ol>

              <p className="text-[11px] leading-relaxed text-slate-400">
                D1 绑定和「每分钟检查一次」的定时触发器都写在仓库里，会自动带上，不用手动加。
                以后想更新，回你 fork 的仓库点一下 <strong>Sync fork</strong> 就行，CF 会自动重新部署。
              </p>

              <div className="grid grid-cols-3 gap-2">
                {/* 三个出口合成一个事件带 target 枚举：它们是部署流程同一步的三条岔路，
                    拆成三个事件名只是多占清单行数，看漏斗时还得自己加回去。 */}
                <a
                  href={WORKERS_REPO_URL}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => trackEvent('打开 2.0 部署外链', { target: 'fork仓库' })}
                  className="py-2.5 rounded-xl text-xs font-bold bg-violet-500 text-white text-center active:scale-95 transition-transform"
                >
                  ↗ Fork 仓库
                </a>
                <a
                  href={SETUP_WALKTHROUGH_URL}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => trackEvent('打开 2.0 部署外链', { target: '图文教程' })}
                  className="py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 text-center active:scale-95 transition-transform"
                >
                  ↗ 图文教程
                </a>
                <a
                  href={buildCloudflareDashboardUrl(config.workerUrl.trim() || undefined)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => trackEvent('打开 2.0 部署外链', { target: 'CF面板' })}
                  className="py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 text-center active:scale-95 transition-transform"
                >
                  ↗ CF 面板
                </a>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3 space-y-2.5 text-xs">
                <p className="font-bold text-slate-700">环境变量清单</p>

                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <code className="font-mono text-[11px] text-slate-600">AMSG_MASTER_KEY</code>
                    <button
                      type="button"
                      onClick={() => void handleGenerateMasterKey()}
                      className="shrink-0 px-3 py-1.5 text-[11px] rounded-xl font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
                    >
                      生成并复制
                    </button>
                  </div>
                  {generatedMasterKey ? (
                    <SecretReveal value={generatedMasterKey} />
                  ) : (
                    <p className="text-[11px] text-slate-400">
                      加密任务内容用的密钥，只存在 Worker 侧。复制出来是 <code className="font-mono">变量名=值</code> 整行，
                      粘进 CF 的 Variables 会自动分好两栏。本页不保存。
                    </p>
                  )}
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <code className="font-mono text-[11px] text-slate-600">VAPID_EMAIL / PUBLIC_KEY / PRIVATE_KEY</code>
                    {onOpenVapid ? (
                      <button
                        type="button"
                        onClick={onOpenVapid}
                        className="shrink-0 px-3 py-1.5 text-[11px] rounded-xl font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
                      >
                        去推送凭据面板
                      </button>
                    ) : null}
                  </div>
                  <p className="text-[11px] text-slate-400">
                    必须和「推送凭据 (VAPID)」面板里的是<strong>同一对</strong>（和 Instant Push 共用）——
                    整个站点只有一个浏览器推送订阅，Worker 用别的密钥对签推送会 403。
                  </p>
                </div>

                <div className="space-y-1">
                  <code className="font-mono text-[11px] text-slate-600">AMSG_SERVER_TOKEN（可选）</code>
                  <p className="text-[11px] text-slate-400">
                    防止别人滥用你的 Worker。值 = 下面「共享密钥」填的那串，两边一致即可；不配则端点全开。
                  </p>
                </div>
              </div>

              <div className="border-t border-slate-100 pt-2.5">
                <button
                  type="button"
                  onClick={() => setPasteFallbackOpen((prev) => {
                    if (!prev) trackEvent('展开 2.0 部署指引', { mode: '手动粘贴' });
                    return !prev;
                  })}
                  className="w-full flex items-center justify-between text-left text-[11px] font-bold text-slate-400"
                >
                  <span>没有 GitHub 账号？手动粘贴部署</span>
                  <span>{pasteFallbackOpen ? '收起' : '展开'}</span>
                </button>

                {pasteFallbackOpen ? (
                  <div className="mt-2 space-y-2">
                    <ol className="text-[11px] leading-relaxed text-slate-500 space-y-1.5 list-decimal list-outside pl-4">
                      <li>
                        点下面「复制 Worker 代码」，CF 后台 Create → Worker 建一个空 Worker，
                        进 <strong>Edit code</strong> 全选粘贴覆盖，Deploy。
                      </li>
                      <li>
                        Settings → Bindings 加一个 <strong>D1 database</strong>，
                        变量名必须是 <code className="font-mono">DB</code>。
                      </li>
                      <li>
                        Settings → Trigger Events 加 <strong>Cron Trigger</strong>：
                        <code className="font-mono"> * * * * * </code>（每分钟检查一次到点任务）。
                      </li>
                      <li>Settings → Variables and secrets 按上面的清单填密钥，然后重新 Deploy 一次。</li>
                    </ol>

                    <button
                      type="button"
                      onClick={() => void handleCopyWorkerBundle()}
                      className="w-full py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
                    >
                      复制 Worker 代码
                    </button>

                    <p className="text-[11px] leading-relaxed text-slate-400">
                      这条路每次 Worker 更新都要重新粘一遍，D1 绑定和定时触发器也得自己加，容易漏。
                      能用 GitHub 的话还是走上面的 fork 流程。
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-bold text-slate-700">当前状态</span>
            <span className={`text-xs font-bold ${isConnected ? 'text-emerald-600' : 'text-amber-600'}`}>
              {isConnected ? '已连接' : '未连接'}
            </span>
          </div>

          {workerOutdated ? (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-xs leading-relaxed text-amber-700">
              Worker 上跑的还是旧版代码，缺少新特性（大上下文云端存储、服务端工具循环等）。
              回你 fork 的 <code className="font-mono">sullyos-workers</code> 仓库点一下
              <strong> Sync fork</strong>，CF 会自动重新部署（当初是手动粘贴部署的话，
              去下方「部署 Worker」里重新复制一次代码粘贴覆盖）。已有数据和任务不受影响。
            </div>
          ) : null}

          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">
              Worker 地址
            </label>
            <input
              type="text"
              value={config.workerUrl}
              onChange={(event) => patchConfig({ workerUrl: event.target.value })}
              placeholder="https://amsg.你的账号.workers.dev"
              className="w-full bg-white/70 border border-slate-200 rounded-2xl px-4 py-3 text-xs font-mono"
            />
          </div>

          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">
              共享密钥（可选）
            </label>
            <div className="flex gap-2">
              <input
                type="password"
                value={config.serverToken || ''}
                onChange={(event) => patchConfig({ serverToken: event.target.value })}
                placeholder="worker 配了 AMSG_SERVER_TOKEN 才需要填"
                className="flex-1 bg-white/70 border border-slate-200 rounded-2xl px-4 py-3 text-sm"
              />
              <button
                type="button"
                onClick={() => void handleGenerateServerToken()}
                className="shrink-0 px-3 py-3 text-xs rounded-2xl font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
              >
                随机
              </button>
            </div>
            {generatedServerToken ? (
              <SecretReveal value={generatedServerToken} className="mt-1.5" />
            ) : null}
          </div>

          <button
            onClick={handleConnect}
            disabled={loading}
            className="w-full py-3 bg-slate-900 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50"
          >
            {loading ? '处理中...' : isConnected ? '重新连接并验证' : '连接并启用'}
          </button>

          <p className="text-xs leading-relaxed text-slate-500">
            「连接」会自动在你的 D1 里把表建好（幂等，重复点没关系），不用手动执行 SQL。
          </p>
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-bold text-slate-700">通知权限</span>
            <span className={`text-xs font-bold ${pushStatus?.hasSubscription ? 'text-emerald-600' : 'text-amber-600'}`}>
              {pushStatus?.hasSubscription ? '已开启' : '未开启'}
            </span>
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            这是第二步。只有你真的想让角色在后台主动推送消息时，才需要点。
          </p>
          <p className="text-xs leading-relaxed text-slate-500">
            推送跟着「排程时所在的设备」走：每条任务到点后，推给保存这条排程时用的那台设备。
            换了设备（或者换了浏览器）之后，在新设备上把排程重新保存一次，之后的推送就发到这台。
          </p>
          {pushStatus?.detail ? (
            <p className="text-xs leading-relaxed text-amber-600">{pushStatus.detail}</p>
          ) : null}
          <button
            onClick={handleCreateSubscription}
            disabled={loading}
            className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50"
          >
            {loading ? '处理中...' : '开启通知与推送'}
          </button>
        </div>

        <div className="bg-amber-50 border border-amber-100 rounded-2xl p-4 text-xs leading-relaxed text-amber-700 space-y-2">
          <div className="font-bold text-amber-800">风险说明</div>
          <p>开了 2.0 以后，主动消息内容、提示词、相关配置，都会进入你自己部署的 Worker 及其 D1 数据库。</p>
          <p>这是你自己的 Worker、你自己的库，项目不会额外接一个中心服务器。但只要数据进库，能碰到这台 Worker / 数据库的人（也就是你自己）就能看到这些内容。</p>
          <p>如果你不接受把私密提示词、API Key 放进自己部署的服务，就不要开 2.0。</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <button
            type="button"
            onClick={() => setAdvancedOpen((prev) => !prev)}
            className="w-full flex items-center justify-between text-left"
          >
            <span className="font-bold text-slate-700">高级信息</span>
            <span className="text-xs font-bold text-slate-400">{advancedOpen ? '收起' : '展开'}</span>
          </button>

          {advancedOpen ? (
            <div className="space-y-3 text-xs">
              <div className="bg-violet-50 border border-violet-100 rounded-2xl p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold text-slate-700">X-User-Id</span>
                  <span className="font-mono text-violet-600">{maskActiveMsgUserId(config.userId)}</span>
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">
                Worker 侧的环境变量清单见上面「部署 Worker」一节。发布的 Worker 代码默认 CORS 全开
                （<code className="font-mono">origin: '*'</code>），想收紧就把它改成自己站点的域名再部署。
              </p>
              <div className="bg-rose-50 border border-rose-100 rounded-2xl p-3 space-y-2">
                <div className="font-semibold text-rose-700">清除云端状态</div>
                <p className="text-[11px] leading-relaxed text-rose-600">
                  删除 Worker D1 里同步的角色上下文（角色卡、最近聊天窗口等）。角色靠它到点现场组消息，
                  所以在下次聊天自动重新同步之前，已排程的 AI 任务到点会失败；固定消息任务不受影响。
                </p>
                <button
                  onClick={() => void handleClearClientState()}
                  disabled={loading}
                  className="w-full py-2.5 bg-rose-500 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50"
                >
                  {loading ? '处理中...' : '清除云端状态'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
};

export default React.memo(ActiveMsgGlobalSettingsModal);
