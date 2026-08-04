import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installTranslateCrashGuard } from './utils/translateCrashGuard';
import { ActiveMsgRuntime } from './utils/activeMsgRuntime';
import { KeepAlive } from './utils/keepAlive';
import { ProactiveChat } from './utils/proactiveChat';
import { VRScheduler } from './utils/vrWorld/scheduler';
import { installIOSStandaloneWorkaround } from './utils/iosStandalone';
import { installWakeListener } from './utils/proactivePushConfig';
import { initAnalytics } from './utils/analytics';
import { Capacitor } from '@capacitor/core';

// 默认构建不开启时 Rollup 会整段裁掉；普通浏览器/PWA 不加载原生插件、不申请权限。
if (import.meta.env.VITE_AMSG_NATIVE_PUSH === 'true' && Capacitor.isNativePlatform()) {
  void import('./utils/nativeAmsgPush').then(({ initNativeAmsgPush }) => initNativeAmsgPush());
}

// Register the keep-alive Service Worker early so it's ready before any AI calls
KeepAlive.init().then(() => {
  // Resume any active proactive schedule after SW is ready
  ProactiveChat.resume();
  // Resume 「彼方」 autonomous-login schedules
  VRScheduler.resume();
  void ActiveMsgRuntime.init();
  // Record every wake the SW reports so the diagnostic panel can show "last received".
  installWakeListener();
});

installIOSStandaloneWorkaround();

// 使用统计。构建时没配 VITE_UMAMI_* 就整个不生效，自部署实例默认如此。
// 用户关掉开关、或浏览器开了 DNT，同样在这里就返回，连脚本都不会挂上去。
initAnalytics();

// 浏览器自动翻译 (Chrome/Edge 等) 会改动 React 托管的 DOM，导致 reconcile 时
// insertBefore/removeChild 抛 NotFoundError 白屏。挂载前先打护栏。详见该 util 注释。
installTranslateCrashGuard();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
