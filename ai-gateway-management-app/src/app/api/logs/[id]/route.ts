import { withUser } from "@/server/auth";
import { serverRepo } from "@/server/repository";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, { params }: Ctx) {
  const { id } = await params;
  return withUser(async (user) => {
    await serverRepo.deleteLog(user.id, id);
    return null;
  });
}
