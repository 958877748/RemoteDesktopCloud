/**
 * Step 3 — OAuth 2.1 入口：`@cloudflare/workers-oauth-provider` 的组装 + `/authorize` 密码页。
 *
 * provider 内建：`/.well-known/oauth-authorization-server`、`/.well-known/oauth-protected-resource`、
 * `POST /token`、`POST /register`（RFC 7591 DCR）、`/mcp` 的 Bearer 校验。
 * 不内建的只有 `/authorize` —— 由本文件用 `OAuthHelpers` 自己实现（乙方案：单一密码页）。
 *
 * 两个兼容垫片（ChatGPT 硬要求，见 README §7）：
 *   1. `resource` 归一化：客户端可能把 `resource` 报成 `origin/mcp`，而我们配置的是 `origin`
 *      （与原版一致），两处（/authorize 的 query、/token 的 form body）都归一到 `origin`。
 *   2. DCR 兜底：`/authorize` 收到没注册过的 `client_id` 时，按请求里的 `redirect_uri`
 *      直接在 KV 里补一条 client 记录。
 */
import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { constantTimeEquals, escapeHtml, page } from "./device-auth.js";
import type { Env } from "./env.js";

export type FetchHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
};

/** 与原版对齐：AS 与 PRM 都通告这组 scope。 */
const SCOPES = ["mcp:tools", "desktop:auth"];
const DEFAULT_SCOPE = "mcp:tools";

/**
 * 按 origin 惰性构造并缓存。
 * `resourceMetadata.resource` 必须是绝对 URI，而本地 `http://localhost:8787` 与
 * 线上 `https://*.workers.dev` 不同，所以不能在模块顶层写死。
 */
const providers = new Map<string, OAuthProvider<Env>>();

export function getProvider(origin: string, apiHandler: FetchHandler, defaultHandler: FetchHandler): OAuthProvider<Env> {
  const hit = providers.get(origin);
  if (hit) return hit;

  const provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler,
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    resourceMetadata: {
      resource: origin,
      resource_name: "RemoteDesktopCloud",
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
    },
    requiredScopes: SCOPES,
    scopesSupported: SCOPES,
    allowPrivateUseRedirectUris: false,
  });
  providers.set(origin, provider);
  return provider;
}

// ---------------------------------------------------------------------------
// resource 垫片
// ---------------------------------------------------------------------------

function normalizeResourceValue(value: string, origin: string): string {
  return value === `${origin}/mcp` || value === `${origin}/mcp/` ? origin : value;
}

/** 归一化 query 里的 `resource`；返回一个新 URL（不改原对象）。 */
function normalizeResourceQuery(request: Request): { url: URL; changed: boolean } {
  const url = new URL(request.url);
  const before = url.searchParams.getAll("resource");
  if (!before.length) return { url, changed: false };
  const after = before.map((v) => normalizeResourceValue(v, url.origin));
  if (after.every((v, i) => v === before[i])) return { url, changed: false };
  url.searchParams.delete("resource");
  for (const v of new Set(after)) url.searchParams.append("resource", v);
  return { url, changed: true };
}

/** 归一化 token 端点 form body 里的 `resource`（需要读 body，故单独拆出来）。 */
async function normalizeTokenBody(request: Request, origin: string): Promise<Request> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) return request;
  const raw = await request.text();
  const params = new URLSearchParams(raw);
  const before = params.getAll("resource");
  if (!before.length) return new Request(request.url, { method: request.method, headers: request.headers, body: raw });
  const after = before.map((v) => normalizeResourceValue(v, origin));
  params.delete("resource");
  for (const v of new Set(after)) params.append("resource", v);
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, { method: request.method, headers, body: params.toString() });
}

/** 包一层 `OAuthProvider.fetch`：只做 token 端点的 resource 归一化，其余原样透传。 */
export function wrapProvider(provider: OAuthProvider<Env>): FetchHandler {
  return {
    async fetch(request, env, ctx) {
      const origin = new URL(request.url).origin;
      const url = new URL(request.url);
      // RFC 9728 的 `/mcp` 后缀变体：provider 只服务配置的精确路径，这里补一个别名
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        const canonical = new Request(`${origin}/.well-known/oauth-protected-resource${url.search}`, request);
        return provider.fetch(canonical, env, ctx);
      }
      if (url.pathname === "/token" && request.method === "POST") {
        return provider.fetch(await normalizeTokenBody(request, origin), env, ctx);
      }
      return provider.fetch(request, env, ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// /authorize — 密码页 + completeAuthorization
// ---------------------------------------------------------------------------

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127\./.test(hostname);
}

/** DCR 兜底只接受 https 或 loopback 的 redirect_uri，避免变成开放重定向器。 */
function isAcceptableRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:") return isLoopbackHost(u.hostname);
    return false;
  } catch {
    return false;
  }
}

/** `/authorize` 收到没注册过的 `client_id` 时补一条 client 记录。 */
async function ensureClient(helpers: OAuthHelpers, env: Env, url: URL): Promise<void> {
  const clientId = url.searchParams.get("client_id");
  if (!clientId) return;
  try {
    if (await helpers.lookupClient(clientId)) return;
  } catch {
    return; // KV 故障时让 parseAuthRequest 自己报错
  }
  const redirectUri = url.searchParams.get("redirect_uri");
  if (!redirectUri || !isAcceptableRedirectUri(redirectUri)) return;

  await env.OAUTH_KV.put(
    `client:${clientId}`,
    JSON.stringify({
      clientId,
      redirectUris: [redirectUri],
      clientName: "MCP Client",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      registrationDate: Math.floor(Date.now() / 1000),
      tokenEndpointAuthMethod: "none",
    }),
  );
}

function passwordForm(action: string, fields: { error?: string; clientName?: string; scope?: string[] }): string {
  const scope = fields.scope?.length ? fields.scope.join(" ") : DEFAULT_SCOPE;
  return `<h1>授权远程访问</h1>
<p>应用 <strong style="color:#e8e8e8">${escapeHtml(fields.clientName ?? "MCP Client")}</strong>
请求访问你的远程机器。输入密码以继续。</p>
<form method="POST" action="${escapeHtml(action)}">
  <label>申请的权限</label>
  <input value="${escapeHtml(scope)}" readonly>
  <label>密码</label>
  <input type="password" name="password" placeholder="访问密码" required autocomplete="current-password">
  <button type="submit">允许访问</button>
</form>
${fields.error ? `<p class="err">${escapeHtml(fields.error)}</p>` : ""}`;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { code?: string; error?: string; error_description?: string; description?: string; message?: string };
    const code = e.code ?? e.error;
    const desc = e.description ?? e.error_description ?? e.message;
    if (code || desc) return [code, desc].filter(Boolean).join(" — ");
  }
  return err instanceof Error ? err.message : String(err);
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const helpers = env.OAUTH_PROVIDER;
  if (!helpers) {
    return page("授权失败", "<h1>授权失败</h1><p>OAuth 助手未注入，请从 Worker 入口访问 /authorize。</p>", 500);
  }

  const { url: authUrl } = normalizeResourceQuery(request);
  const action = `${authUrl.pathname}${authUrl.search}`;
  await ensureClient(helpers, env, authUrl);
  // parseAuthRequest 只读 URL，所以 GET/POST 都用同一个合成请求
  const synthetic = new Request(authUrl.toString());

  if (request.method === "GET") {
    try {
      const authRequest = await helpers.parseAuthRequest(synthetic);
      const client = await helpers.lookupClient(authRequest.clientId).catch(() => null);
      return page(
        "授权远程访问",
        passwordForm(action, { clientName: client?.clientName, scope: authRequest.scope }),
      );
    } catch (err) {
      return page("授权失败", `<h1>请求无效</h1><p>${escapeHtml(errorMessage(err))}</p>`, 400);
    }
  }

  const form = await request.formData().catch(() => null);
  if (!form) return page("授权失败", "<h1>请求无效</h1><p>请使用页面上的表单。</p>", 400);

  const password = String(form.get("password") ?? "");
  if (!constantTimeEquals(password, env.AUTH_PASSWORD)) {
    return page("授权远程访问", passwordForm(action, { error: "密码错误，请重试。" }), 401);
  }

  try {
    const authRequest = await helpers.parseAuthRequest(synthetic);
    const scope = authRequest.scope.length ? authRequest.scope : [DEFAULT_SCOPE];
    const { redirectTo } = await helpers.completeAuthorization({
      request: authRequest,
      userId: env.USER_ID,
      metadata: { authorizedAt: new Date().toISOString() },
      scope,
      props: { userId: env.USER_ID, email: env.USER_EMAIL },
    });
    return new Response(null, { status: 302, headers: { Location: redirectTo, "Cache-Control": "no-store" } });
  } catch (err) {
    return page("授权失败", `<h1>授权失败</h1><p>${escapeHtml(errorMessage(err))}</p>`, 400);
  }
}
