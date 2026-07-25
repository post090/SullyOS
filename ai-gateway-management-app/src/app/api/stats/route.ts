import { withUser } from "@/server/auth";
import { serverRepo } from "@/server/repository";

export const dynamic = "force-dynamic";

export async function GET() {
  return withUser((user) => serverRepo.getStats(user.id));
}
