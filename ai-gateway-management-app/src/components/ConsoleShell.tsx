"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ChartLineUp,
  Key,
  List,
  PlugsConnected,
  Robot,
  ScrollIcon,
  SignOut,
  Stack,
  X,
} from "@phosphor-icons/react";
import type { CurrentUser } from "@/core/types";
import { cx } from "./ui";

const NAV = [
  { href: "/dashboard", label: "总览", icon: ChartLineUp, desc: "用量与健康度" },
  { href: "/providers", label: "渠道管理", icon: PlugsConnected, desc: "上游供应商" },
  { href: "/models", label: "模型路由", icon: Robot, desc: "别名映射" },
  { href: "/tokens", label: "访问令牌", icon: Key, desc: "额度与绑定" },
  { href: "/logs", label: "调用日志", icon: ScrollIcon, desc: "账单明细" },
  { href: "/handover", label: "交接说明", icon: Stack, desc: "迁移 SullyOS" },
];

export function ConsoleShell({ user, children }: { user: CurrentUser; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const nav = (
    <nav className="flex flex-1 flex-col gap-1">
      {NAV.map((item) => {
        const active = pathname === item.href;
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setOpen(false)}
            className={cx(
              "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition",
              active
                ? "bg-gradient-to-r from-violet-500/25 to-fuchsia-500/10 text-violet-100 shadow-inner shadow-violet-500/10"
                : "text-slate-400 hover:bg-white/5 hover:text-slate-100",
            )}
          >
            <Icon size={18} weight={active ? "fill" : "regular"} />
            <span className="flex-1">
              <span className="block font-medium">{item.label}</span>
              <span className="block text-[11px] text-slate-500">{item.desc}</span>
            </span>
            {active ? <span className="h-1.5 w-1.5 rounded-full bg-violet-400" /> : null}
          </Link>
        );
      })}
    </nav>
  );

  const brand = (
    <div className="flex items-center gap-2.5 px-1 py-1">
      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 text-sm font-black text-white shadow-lg shadow-violet-900/40">
        糯
      </div>
      <div>
        <p className="text-sm font-semibold text-slate-100">糯米网关</p>
        <p className="text-[11px] text-slate-500">AI Gateway Console</p>
      </div>
    </div>
  );

  const footer = (
    <div className="space-y-2 border-t border-white/10 pt-3">
      <div className="flex items-center gap-2.5 px-1">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-xs font-semibold text-slate-200">
          {user.displayName.slice(0, 1)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-slate-200">{user.displayName}</p>
          <p className="truncate text-[11px] text-slate-500">@{user.username}</p>
        </div>
        <button
          onClick={() => void logout()}
          title="退出登录"
          className="rounded-lg p-1.5 text-slate-500 transition hover:bg-rose-500/10 hover:text-rose-300"
        >
          <SignOut size={16} />
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col gap-4 border-r border-white/10 bg-slate-950/60 p-4 backdrop-blur-xl lg:flex">
        {brand}
        {nav}
        {footer}
      </aside>

      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <aside className="relative flex h-full w-72 flex-col gap-4 border-r border-white/10 bg-slate-900/95 p-4">
            <div className="flex items-center justify-between">
              {brand}
              <button onClick={() => setOpen(false)} className="rounded-lg p-1 text-slate-400">
                <X size={18} />
              </button>
            </div>
            {nav}
            {footer}
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-white/10 bg-slate-950/70 px-4 py-3 backdrop-blur-xl lg:hidden">
          <button onClick={() => setOpen(true)} className="rounded-lg border border-white/10 p-2 text-slate-300">
            <List size={18} />
          </button>
          <span className="text-sm font-semibold">糯米网关</span>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
