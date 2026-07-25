import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * 数据表定义（仅 Next.js/Postgres 部署形态使用）。
 * 迁移到 SullyOS（local-first / IndexedDB）时，这一层会被替换为
 * `src/core/port.ts` 的另一个实现，业务与 UI 层不需要改动。
 */

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const sessions = pgTable(
  "sessions",
  {
    token: text("token").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);

/** 上游渠道（供应商接入点） */
export const providers = pgTable(
  "providers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    vendor: text("vendor").notNull(),
    baseUrl: text("base_url").notNull(),
    apiKey: text("api_key").notNull(),
    status: text("status").notNull().default("active"),
    priority: integer("priority").notNull().default(10),
    weight: integer("weight").notNull().default(50),
    rpmLimit: integer("rpm_limit").notNull().default(60),
    monthlyBudget: doublePrecision("monthly_budget").notNull().default(100),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("providers_user_idx").on(table.userId)],
);

/** 模型路由映射（对外模型名 -> 上游模型名） */
export const models = pgTable(
  "models",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    upstreamModel: text("upstream_model").notNull(),
    contextWindow: integer("context_window").notNull().default(32000),
    inputPrice: doublePrecision("input_price").notNull().default(0),
    outputPrice: doublePrecision("output_price").notNull().default(0),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("models_user_idx").on(table.userId)],
);

/** 访问令牌（发给酒馆 / SullyOS / 其他前端使用） */
export const tokens = pgTable(
  "tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    secret: text("secret").notNull(),
    boundApp: text("bound_app").notNull().default("其他"),
    quota: doublePrecision("quota").notNull().default(50),
    used: doublePrecision("used").notNull().default(0),
    status: text("status").notNull().default("active"),
    allowedModels: jsonb("allowed_models").$type<string[]>().notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("tokens_user_idx").on(table.userId)],
);

/** 调用日志 */
export const callLogs = pgTable(
  "call_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenName: text("token_name").notNull(),
    providerName: text("provider_name").notNull(),
    modelName: text("model_name").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    cost: doublePrecision("cost").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    status: text("status").notNull().default("success"),
    errorMessage: text("error_message").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("call_logs_user_idx").on(table.userId, table.createdAt)],
);
