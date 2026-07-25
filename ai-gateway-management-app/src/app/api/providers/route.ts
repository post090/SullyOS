import { withUser } from "@/server/auth";
import { serverRepo } from "@/server/repository";
import type { ProviderInput } from "@/core/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return withUser((user) => serverRepo.listProviders(user.id));
}

export async function POST(request: Request) {
  const body = (await request.json()) as ProviderInput;
  return withUser((user) => serverRepo.createProvider(user.id, body));
}
