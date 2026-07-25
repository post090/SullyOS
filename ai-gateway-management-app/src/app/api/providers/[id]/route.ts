import { withUser } from "@/server/auth";
import { serverRepo } from "@/server/repository";
import type { ProviderInput } from "@/core/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Ctx) {
  const { id } = await params;
  const body = (await request.json()) as Partial<ProviderInput>;
  return withUser((user) => serverRepo.updateProvider(user.id, id, body));
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const { id } = await params;
  return withUser(async (user) => {
    await serverRepo.deleteProvider(user.id, id);
    return null;
  });
}
