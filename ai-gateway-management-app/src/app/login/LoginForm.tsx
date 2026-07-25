"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleNotch, Lightning, SignIn, UserPlus } from "@phosphor-icons/react";
import { Button, Card, Field, cx, inputClass } from "@/components/ui";
import { useToast } from "@/components/toast";

export function LoginForm({
  demoUsername,
  demoPassword,
}: {
  demoUsername: string;
  demoPassword: string;
}) {
  const router = useRouter();
  const { push } = useToast();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(user: string, pass: string, mode2: "login" | "register", name?: string) {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/${mode2}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user, password: pass, displayName: name }),
      });
      const body = (await res.json()) as { error?: string; displayName?: string };
      if (!res.ok) {
        setError(body.error ?? "操作失败");
        setPending(false);
        return;
      }
      push(`欢迎回来，${body.displayName ?? user}`);
      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("网络异常，请稍后再试");
      setPending(false);
    }
  }

  return (
    <Card className="p-6 sm:p-8">
      <div className="mb-6 flex rounded-xl border border-white/10 bg-slate-950/50 p-1 text-sm">
        {(["login", "register"] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              setError(null);
            }}
            className={cx(
              "flex-1 rounded-lg py-2 font-medium transition",
              mode === m ? "bg-violet-500/20 text-violet-200" : "text-slate-400 hover:text-slate-200",
            )}
          >
            {m === "login" ? "登录" : "注册新账号"}
          </button>
        ))}
      </div>

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(username, password, mode, displayName);
        }}
      >
        <Field label="用户名">
          <input
            className={inputClass}
            value={username}
            autoComplete="username"
            onChange={(e) => setUsername(e.target.value)}
            placeholder="你的登录名，如 nuomi"
          />
        </Field>
        {mode === "register" ? (
          <Field label="昵称" hint="展示在侧边栏">
            <input
              className={inputClass}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="随便取，比如 咕咕的猫猫"
            />
          </Field>
        ) : null}
        <Field label="密码" hint={mode === "register" ? "至少 6 位" : undefined} error={error ?? undefined}>
          <input
            className={inputClass}
            type="password"
            value={password}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </Field>

        <Button type="submit" disabled={pending} className="w-full">
          {pending ? (
            <CircleNotch size={16} className="animate-spin" />
          ) : mode === "login" ? (
            <SignIn size={16} weight="bold" />
          ) : (
            <UserPlus size={16} weight="bold" />
          )}
          {pending ? "处理中…" : mode === "login" ? "登录控制台" : "注册并进入"}
        </Button>
      </form>

      <div className="mt-5 rounded-xl border border-white/10 bg-slate-950/40 p-3">
        <p className="text-xs text-slate-400">
          想直接看效果？演示账号 <code className="text-violet-300">{demoUsername}</code> /{" "}
          <code className="text-violet-300">{demoPassword}</code>，已灌满一周的真实感数据。
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 w-full"
          disabled={pending}
          onClick={() => {
            setUsername(demoUsername);
            setPassword(demoPassword);
            void submit(demoUsername, demoPassword, "login");
          }}
        >
          <Lightning size={14} weight="fill" /> 一键体验演示账号
        </Button>
      </div>
    </Card>
  );
}
