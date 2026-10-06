/** Supabase 项目配置与身份常量。所有值来自 Worker 环境变量。 */
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  /** 乙方案：/device/verify 表单密码，同时也是 GoTrue 唯一用户的密码 */
  AUTH_PASSWORD: string;
  /** 唯一用户的 UUID（auth.users.id），与 mcp_*.user_id 对应 */
  USER_ID: string;
  /** 唯一用户的邮箱，用于 password grant 换 GoTrue token */
  USER_EMAIL: string;

  /** `@cloudflare/workers-oauth-provider` 的 KV 绑定（client/grant/token 记录） */
  OAUTH_KV: KVNamespace;
  /** provider 在分发到 defaultHandler/apiHandler 之前注入的 OAuth 助手 */
  OAUTH_PROVIDER?: OAuthHelpers;
}

export function requireEnv(env: Env): void {
  const missing = (["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_PUBLISHABLE_KEY", "AUTH_PASSWORD", "USER_ID", "USER_EMAIL"] as const)
    .filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Missing env: ${missing.join(", ")}`);
  }
  if (!env.OAUTH_KV) throw new Error("Missing binding: OAUTH_KV");
}
