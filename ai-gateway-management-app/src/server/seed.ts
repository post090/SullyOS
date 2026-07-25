import { eq } from "drizzle-orm";
import { db } from "@/db";
import { callLogs, models, providers, tokens, users } from "@/db/schema";
import { buildDemoDataset } from "@/core/demoData";
import { hashPassword } from "./auth";

export const DEMO_USERNAME = "demo";
export const DEMO_PASSWORD = "airp2026";

/** 为某个用户灌入一整套演示数据，让首屏不空。 */
export async function seedUserData(userId: string): Promise<void> {
  const existing = await db.select({ id: providers.id }).from(providers).where(eq(providers.userId, userId)).limit(1);
  if (existing.length > 0) return;

  const dataset = buildDemoDataset();
  const providerRows = await db
    .insert(providers)
    .values(dataset.providers.map(({ key: _key, ...p }) => ({ ...p, userId })))
    .returning({ id: providers.id, name: providers.name });

  const idByKey = new Map<string, string>();
  dataset.providers.forEach((p, i) => idByKey.set(p.key, providerRows[i].id));

  await db.insert(models).values(
    dataset.models.map(({ providerKey, ...m }) => ({
      ...m,
      userId,
      providerId: idByKey.get(providerKey) ?? providerRows[0].id,
    })),
  );

  await db.insert(tokens).values(
    dataset.tokens.map((t) => ({
      userId,
      name: t.name,
      secret: t.secret,
      boundApp: t.boundApp,
      quota: t.quota,
      used: t.used,
      status: t.status,
      allowedModels: t.allowedModels,
      expiresAt: t.expiresAt ? new Date(t.expiresAt) : null,
    })),
  );

  await db.insert(callLogs).values(
    dataset.logs.map((l) => ({
      userId,
      tokenName: l.tokenName,
      providerName: l.providerName,
      modelName: l.modelName,
      promptTokens: l.promptTokens,
      completionTokens: l.completionTokens,
      cost: l.cost,
      latencyMs: l.latencyMs,
      status: l.status,
      errorMessage: l.errorMessage,
      createdAt: l.createdAt ? new Date(l.createdAt) : new Date(),
    })),
  );
}

/** 确保演示账号存在（登录页首次访问时调用）。 */
export async function ensureDemoUser(): Promise<void> {
  try {
    const found = await db.select().from(users).where(eq(users.username, DEMO_USERNAME)).limit(1);
    let userId = found[0]?.id;
    if (!userId) {
      const [row] = await db
        .insert(users)
        .values({
          username: DEMO_USERNAME,
          displayName: "阿糯（演示账号）",
          passwordHash: hashPassword(DEMO_PASSWORD),
        })
        .returning({ id: users.id });
      userId = row.id;
    }
    await seedUserData(userId);
  } catch {
    // 数据库尚未 push schema 时静默跳过，不阻塞页面渲染
  }
}
