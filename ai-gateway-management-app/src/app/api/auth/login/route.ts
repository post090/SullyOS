import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { createSession, verifyPassword } from "@/server/auth";
import { seedUserData } from "@/server/seed";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json()) as { username?: string; password?: string };
  const username = (body.username ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  if (!username || !password) {
    return Response.json({ error: "请输入用户名和密码" }, { status: 400 });
  }
  const rows = await db.select().from(users).where(eq(users.username, username)).limit(1);
  const user = rows[0];
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return Response.json({ error: "用户名或密码不正确" }, { status: 401 });
  }
  await createSession(user.id);
  await seedUserData(user.id);
  return Response.json({ id: user.id, username: user.username, displayName: user.displayName });
}
