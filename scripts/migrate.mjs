#!/usr/bin/env node
/**
 * 迁移执行器：把 supabase/migrations/*.sql 按文件名顺序跑进 DATABASE_URL 指向的库。
 *
 *   node scripts/migrate.mjs            # 跑所有未执行的迁移
 *   node scripts/migrate.mjs --status   # 只看状态
 *
 * 依赖 .env（已 gitignore）里的 DATABASE_URL。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "pg";

const { Client } = pkg;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

// 极简 .env 读取（不引第三方依赖）
function loadEnv() {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

async function main() {
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("缺少 DATABASE_URL：请在 .env 中填写（见 .env.example）");
    process.exit(1);
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  await client.query(
    `create table if not exists public.schema_migrations (
       name text primary key,
       applied_at timestamptz not null default now()
     )`
  );

  const { rows } = await client.query("select name from schema_migrations");
  const applied = new Set(rows.map((r) => r.name));
  const statusOnly = process.argv.includes("--status");

  let ran = 0;
  for (const f of files) {
    if (applied.has(f)) {
      console.log(`  ✓ ${f} (已应用)`);
      continue;
    }
    if (statusOnly) {
      console.log(`  … ${f} (待执行)`);
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    console.log(`→ 应用 ${f} ...`);
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations(name) values ($1)", [f]);
      await client.query("commit");
      console.log(`  ✓ ${f} 完成`);
      ran++;
    } catch (err) {
      await client.query("rollback");
      console.error(`  ✗ ${f} 失败: ${err.message}`);
      await client.end();
      process.exit(1);
    }
  }

  await client.end();
  console.log(statusOnly ? "状态如上。" : `本次新执行 ${ran} 个迁移。`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
