import React, { useEffect, useState } from 'react';
import Modal from '../os/Modal';
import { useOS } from '../../context/OSContext';
import { generateClientToken } from '../../utils/vapidGen';
import {
  loadInstantConfig,
  saveInstantConfig,
  getOrCreateInstantSubscription,
  sendTestInstantPush,
} from '../../utils/instantPushClient';
import { isPushVapidReady } from '../../utils/pushVapid';
import { InstantPushConfig } from '../../types';

interface InstantPushSettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** 由 Settings 注入: 点"去配置 VAPID"时打开顶层 PushVapidSettingsModal */
  onOpenVapid?: () => void;
}

export const InstantPushSettingsModal: React.FC<InstantPushSettingsModalProps> = ({
  open,
  onClose,
  onOpenVapid,
}) => {
  const { apiConfig, addToast } = useOS();

  const [workerUrl, setWorkerUrl] = useState('');
  const [clientToken, setClientToken] = useState('');
  const [enabled, setEnabled] = useState(false);

  const [vapidReady, setVapidReady] = useState(false);

  const [testStatus, setTestStatus] = useState('');
  const [testBusy, setTestBusy] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const [gitUrlStatus, setGitUrlStatus] = useState('');

  const INSTANT_PUSH_GIT_URL =
    'https://github.com/qegj567-cloud/SullyOS/tree/master/worker/instant-push';

  useEffect(() => {
    if (!open) return;
    const cfg = loadInstantConfig();
    setWorkerUrl(cfg.workerUrl);
    setClientToken(cfg.clientToken ?? '');
    setEnabled(cfg.enabled);
    setVapidReady(isPushVapidReady());
    setTestStatus('');
    setCopyStatus('');
  }, [open]);

  const currentCfg = (): InstantPushConfig => ({
    enabled,
    workerUrl: workerUrl.trim().replace(/\/+$/, ''),
    clientToken: clientToken.trim() || undefined,
  });

  const handleGenerateToken = () => {
    setClientToken(generateClientToken());
  };

  const handleCopyWorkerCode = async () => {
    setCopyStatus('加载中…');
    try {
      const res = await fetch('/instant-worker.bundle.js');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      setCopyStatus('已复制');
      setTimeout(() => setCopyStatus(''), 2000);
    } catch (e) {
      const err = e as { message?: string } | null;
      setCopyStatus('');
      addToast(`复制失败：${err?.message ?? '未知错误'}`, 'error');
    }
  };

  const handleCopyGitUrl = async () => {
    try {
      await navigator.clipboard.writeText(INSTANT_PUSH_GIT_URL);
      setGitUrlStatus('已复制');
      setTimeout(() => setGitUrlStatus(''), 2000);
    } catch (e) {
      const err = e as { message?: string } | null;
      addToast(`复制失败：${err?.message ?? '未知错误'}`, 'error');
    }
  };

  const handleOpenCF = () => {
    window.open('https://dash.cloudflare.com/?to=/:account/workers-and-pages/create', '_blank');
  };

  const handleTest = async () => {
    if (testBusy) return;
    if (!isPushVapidReady()) {
      setTestStatus('请先到「推送凭据 (VAPID)」生成密钥对');
      return;
    }
    const cfg = currentCfg();
    saveInstantConfig(cfg);
    setTestBusy(true);
    setTestStatus('正在获取订阅…');
    try {
      const { sub, reason } = await getOrCreateInstantSubscription();
      if (!sub) {
        setTestStatus(`订阅失败：${reason ?? '未知'}`);
        return;
      }
      setTestStatus('调用 LLM 并推送中…');
      const result = await sendTestInstantPush(apiConfig);
      if (result.ok) {
        setTestStatus('推送已发出，请查看系统通知');
      } else {
        setTestStatus(`失败：${result.error ?? '未知错误'}`);
      }
    } catch (e) {
      const err = e as { message?: string } | null;
      setTestStatus(`错误：${err?.message ?? String(e)}`);
    } finally {
      setTestBusy(false);
    }
  };

  const handleSave = () => {
    saveInstantConfig(currentCfg());
    addToast('Instant Push 配置已保存', 'success');
    onClose();
  };

  const testStatusColor = testStatus.includes('推送已发出')
    ? 'text-emerald-600'
    : testStatus.includes('失败') || testStatus.includes('错误') || testStatus.includes('请先到')
    ? 'text-rose-500'
    : 'text-slate-500';

  return (
    <Modal
      isOpen={open}
      title="Instant Push 配置"
      onClose={onClose}
      footer={
        <div className="flex gap-2 w-full">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl text-sm"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="flex-1 py-3 bg-indigo-500 text-white font-bold rounded-2xl shadow-lg shadow-indigo-200 text-sm"
          >
            保存
          </button>
        </div>
      }
    >
      <div className="space-y-5 text-sm">

        {/* VAPID 状态横条 */}
        <div className={`rounded-2xl p-3 border ${vapidReady ? 'bg-emerald-50 border-emerald-200' : 'bg-rose-50 border-rose-200'}`}>
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] leading-relaxed">
              <p className={`font-bold ${vapidReady ? 'text-emerald-700' : 'text-rose-700'}`}>
                {vapidReady ? 'VAPID 已配置' : 'VAPID 未配置'}
              </p>
              <p className={vapidReady ? 'text-emerald-600' : 'text-rose-600'}>
                {vapidReady
                  ? '与 Proactive Push 共用同一份。改了之后两边的订阅都会续上。'
                  : '需要先生成 VAPID 密钥对，Worker env 也要同步填进去。'}
              </p>
            </div>
            {onOpenVapid && (
              <button
                type="button"
                onClick={onOpenVapid}
                className={`shrink-0 px-3 py-2 text-[11px] rounded-xl font-bold ${vapidReady ? 'bg-white text-emerald-700 border border-emerald-300 hover:bg-emerald-50' : 'bg-rose-500 text-white hover:bg-rose-600'}`}
              >
                {vapidReady ? '查看 / 重生成' : '去生成 →'}
              </button>
            )}
          </div>
        </div>

        {/* ① Worker 配置 */}
        <div className="bg-slate-50 rounded-2xl p-4 space-y-3">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">① Worker 配置</p>

          <div className="space-y-1">
            <label className="text-[11px] text-slate-500 font-medium">Worker URL</label>
            <input
              type="url"
              value={workerUrl}
              onChange={(e) => setWorkerUrl(e.target.value)}
              placeholder="https://instant-push.xxx.workers.dev"
              className="w-full text-xs bg-white border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-400"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-slate-500 font-medium">Client Token（可选，防止他人滥用 Worker）</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={clientToken}
                onChange={(e) => setClientToken(e.target.value)}
                placeholder="留空则裸跑"
                className="flex-1 text-[11px] font-mono bg-white border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-400"
              />
              <button
                type="button"
                onClick={handleGenerateToken}
                className="shrink-0 px-3 py-2 text-[11px] bg-white border border-slate-200 rounded-xl text-slate-600 hover:bg-slate-50 font-medium"
              >
                随机
              </button>
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="accent-indigo-500"
            />
            <span className="text-[12px] text-slate-600 font-medium">启用 Instant Push</span>
          </label>
        </div>

        {/* ② 部署 Worker */}
        <div className="bg-slate-50 rounded-2xl p-4 space-y-2">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">② 部署 Worker</p>
          <p className="text-[11px] text-slate-500 leading-relaxed">
            在 CF 后台选「Clone a public repository via Git URL」，粘贴下面的 Git URL；
            VAPID 公钥/私钥到「推送凭据 (VAPID)」面板复制 env 清单，再粘进 Worker 的 Variables。
          </p>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => void handleCopyGitUrl()}
              className="py-2 rounded-xl text-[11px] font-bold bg-indigo-500 text-white hover:bg-indigo-600"
            >
              {gitUrlStatus || '复制 Git URL'}
            </button>
            <button
              type="button"
              onClick={handleOpenCF}
              className="py-2 rounded-xl text-[11px] font-bold bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
            >
              ↗ CF Dashboard
            </button>
          </div>

          <div className="flex items-center justify-end pt-1">
            <button
              type="button"
              onClick={() => void handleCopyWorkerCode()}
              className="text-[11px] text-slate-400 hover:text-slate-600 underline-offset-2 hover:underline"
            >
              {copyStatus ? `备用方案：${copyStatus}` : '备用方案：复制 worker.bundle.js 手动粘贴'}
            </button>
          </div>
        </div>

        {/* ③ 测试推送 */}
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={testBusy}
            className={`w-full py-3 rounded-xl text-sm font-bold ${testBusy ? 'bg-slate-200 text-slate-400' : 'bg-emerald-500 text-white hover:bg-emerald-600'}`}
          >
            {testBusy ? '测试中…' : '🔔 发送测试推送'}
          </button>
          {testStatus && (
            <p className={`text-[11px] text-center ${testStatusColor}`}>{testStatus}</p>
          )}
          {!apiConfig.baseUrl && (
            <p className="text-[11px] text-amber-600 text-center">请先在 Settings → API 配置 Chat API，测试推送会复用它</p>
          )}
          <p className="text-[11px] text-slate-400 text-center leading-relaxed">
            测试推送带 <code>metadata.test=true</code> 标记，SW 收到后即使 app 在前台也会强制弹系统通知 —— 真实消息照旧前台静默由 in-app UI 兜底。
          </p>
        </div>

      </div>
    </Modal>
  );
};
