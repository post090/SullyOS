import { withUser } from "@/server/auth";
import { serverRepo } from "@/server/repository";
import type { CallLogInput } from "@/core/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? 100);
  return withUser((user) => serverRepo.listLogs(user.id, Number.isFinite(limit) ? limit : 100));
}

export async function POST(request: Request) {
  const body = (await request.json()) as CallLogInput;
  return withUser((user) => serverRepo.createLog(user.id, body));
}

export async function DELETE() {
  return withUser(async (user) => {
    await serverRepo.clearLogs(user.id);
    return null;
  });
}
