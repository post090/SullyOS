import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { GatewayProvider } from "@/features/gateway/store";
import { ConsoleShell } from "@/components/ConsoleShell";

export const dynamic = "force-dynamic";

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <GatewayProvider>
      <ConsoleShell user={user}>{children}</ConsoleShell>
    </GatewayProvider>
  );
}
