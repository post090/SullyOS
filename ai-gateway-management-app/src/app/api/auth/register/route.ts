import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { createSession, hashPassword } from "@/server/auth";
import { seedUserData } from "@/server/seed";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    username?: string;
    password?: string;
    displayName?: string;
  };
  const username = (body.username ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const displayName = (body.displayName ?? "").trim() || username;

  if (username.length < 3) return Response.json({ error: "用户名至少 3 位" }, { status: 400 });
  if (password.length < 6) return Response.json({ error: "密码至少 6 位" }, { status: 400 });

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
  if (existing.length > 0) return Response.json({ error: "该用户名已被占用" }, { status: 409 });

  const [user] = await db
    .insert(users)
    .values({ username, displayName, passwordHash: hashPassword(password) })
    .returning();

  await createSession(user.id);
  // 新账号也灌一套演示数据，首屏不空
  await seedUserData(user.id);
  return Response.json({ id: user.id, username: user.username, displayName: user.displayName });
}
