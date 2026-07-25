import { withUser } from "@/server/auth";
import { serverRepo } from "@/server/repository";
import type { ModelRouteInput } from "@/core/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return withUser((user) => serverRepo.listModels(user.id));
}

export async function POST(request: Request) {
  const body = (await request.json()) as ModelRouteInput;
  return withUser((user) => serverRepo.createModel(user.id, body));
}
