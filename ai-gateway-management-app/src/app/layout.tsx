import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ToastProvider } from "@/components/toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "糯米网关 · AI Gateway Console",
  description: "面向中文 AIRP 玩家的 AI 网关管理台：渠道、模型路由、令牌额度与调用日志一站式管理。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(1000px_500px_at_15%_-10%,rgba(139,92,246,0.18),transparent),radial-gradient(800px_400px_at_85%_10%,rgba(34,211,238,0.12),transparent)]" />
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
