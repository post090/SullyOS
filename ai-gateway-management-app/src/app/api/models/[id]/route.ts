import { withUser } from "@/server/auth";
import { serverRepo } from "@/server/repository";
import type { ModelRouteInput } from "@/core/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Ctx) {
  const { id } = await params;
  const body = (await request.json()) as Partial<ModelRouteInput>;
  return withUser((user) => serverRepo.updateModel(user.id, id, body));
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const { id } = await params;
  return withUser(async (user) => {
    await serverRepo.deleteModel(user.id, id);
    return null;
  });
}
