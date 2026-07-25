import { withUser } from "@/server/auth";
import { serverRepo } from "@/server/repository";
import type { AccessTokenInput } from "@/core/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return withUser((user) => serverRepo.listTokens(user.id));
}

export async function POST(request: Request) {
  const body = (await request.json()) as AccessTokenInput;
  return withUser((user) => serverRepo.createToken(user.id, body));
}
