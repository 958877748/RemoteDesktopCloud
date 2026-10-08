# RemoteDesktopCloud

ChatGPT 与 DesktopCommander 设备之间的**中转站**（MCP Relay）。

```
ChatGPT 连接器 ──HTTPS/Streamable──▶ 本 Worker(/mcp) ──Postgres 任务表──▶ Supabase
                                                                    ▲    │
                                            Realtime broadcast ◀───┘    │
npx @wonderwhy-er/desktop-commander remote ◀────────────────────────────┘
        （设备端，官方现成 npm 包，只改 URL，不 fork 不改代码）
```

- ChatGPT 通过 OAuth 登录本服务，看到 29 个 DesktopCommander 工具。
- 调用落到 Supabase `mcp_remote_calls` 表，Worker 广播 `new_call` 门铃。
- 设备端认领任务、执行、写回结果，Worker 轮询返回给 ChatGPT。
- 单用户、2-3 台设备，**免费方案**（Cloudflare Free + Supabase Free，¥0）。

> 状态：**MVP 六步全部完成 ✅**。真实 ChatGPT 连接器已跑通——ChatGPT 自动发现并使用了本服务发布的 OAuth 端点与作用域，`list_devices` / `start_process` 均真机往返成功；四套件 **128 项断言**全绿（控制台 34 + OAuth 54 + 设备配对 14 + 真机转发 26）。线上地址 `https://remotedesktopcloud.txdygl.workers.dev`。关键决策见 §8，进度见 §9，已知限制（Workers Free 子请求预算、设备写回假阴性）见 §11。

---

## 1. 技术栈与分工

| 组件 | 选型 | 职责 |
|---|---|---|
| Cloudflare Workers | `@cloudflare/workers-oauth-provider` + `agents/mcp/server` | MCP 端点、OAuth 2.1 + DCR、设备授权页 |
| Supabase Free | Postgres + GoTrue + Realtime + REST | 任务表、设备表、身份、广播、清扫 |
| 设备端 | 官方 `@wonderwhy-er/desktop-commander` | 现成 npm 包，零改动，仅注入 URL |

**放弃的路线**：B（自研 Supabase 兼容层）、C（自托管）。

### 两个注入点（不 fork 设备端的全部依据）

1. `MCP_SERVER_URL` 环境变量 → 客户端向 `GET /api/mcp-info`、`POST /device/start`、`POST /device/poll` 发请求。
2. `/api/mcp-info` 返回 `supabaseUrl` + `supabasePublishableKey`（`sb_publishable_...`）→ 客户端用它 `createClient()` 连我们指定的 Supabase。

---

## 2. 端点清单

### ChatGPT 硬性要求（✅ 已实现，`scripts/test-oauth-flow.mjs` 54/54 通过）

| 端点 | 规范 | 说明 |
|---|---|---|
| `POST /mcp` | Streamable HTTP | 公网 HTTPS，MCP 传输 |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 | 资源元数据（`/mcp` 后缀变体另由 Worker 别名补上，两条都 200） |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 | 授权服务器元数据 |
| `GET /authorize` | OAuth 2.1 + PKCE S256 | `redirect_uri` 必须允许 `https://chatgpt.com/connector_platform_oauth_redirect` |
| `POST /token` | OAuth 2.1 | 发 token |
| `POST /register` | RFC 7591 DCR | 必须接受任意 UUID `client_id`（未注册过的 `client_id` 走 `/authorize` 的 KV 兜底补记录） |

现成组件：`@cloudflare/workers-oauth-provider` 覆盖 OAuth 2.1 + DCR + RFC 8414/9728；`createMcpHandler`（`agents/mcp/server`）覆盖 Streamable HTTP。
**`/authorize` 是唯一自己实现的 OAuth 端点**（provider 只内建 discovery / token / register / API 鉴权），用它的 `OAuthHelpers` 完成 `parseAuthRequest` → 密码页 → `completeAuthorization`。

### 设备端注入点（✅ 已实现并真机验证）

| 端点 | 说明 |
|---|---|
| `GET /api/mcp-info` | 返回 `supabaseUrl`、`supabasePublishableKey`、`mcpServerUrl`、`version` |
| `POST /device/start` | 收 S256 `code_challenge`，返回 `device_code` + `user_code`(`XXXX-XXXX`) + `verification_uri(_complete)` + `expires_in:600` + `interval:5` |
| `GET /device/verify` | 密码 + 配对码页面（乙方案，同 `/authorize` 共用密码校验） |
| `POST /device/verify` | 校验 `AUTH_PASSWORD` 与配对码 → 建 `mcp_devices` 行 → 置 `approved` |
| `POST /device/poll` | pending → `{error:'authorization_pending'}`(400)；批准 → 校验 PKCE → GoTrue password grant → 返回 token + `device_id`（码用后即焚） |

> ⚠️ 关键约束：`/device/poll` 的 token 若非 GoTrue 签发，设备端 `client.auth.setSession()` 直接失败 → 设备授权流必须与 GoTrue 桥接。

### 控制台（✅ Step 6 已实现，`scripts/test-console.mjs` 34/34 通过）

| 端点 | 说明 |
|---|---|
| `GET /` | 控制台首页：无 session → 密码登录页；有 session → 设备面板（列表 / 在线状态 / 接入命令 / 连接器 URL） |
| `POST /login` | 校验 `AUTH_PASSWORD` → 在 `OAUTH_KV` 写 `console:<token>`（7 天 TTL）→ 下 `rdc_console` cookie（HttpOnly + SameSite=Lax）→ 303 `/` |
| `POST /logout` | 删 KV session + 清 cookie → 303 `/` |
| `GET /api/devices` | JSON：`total` / `online` / `devices` / `html`（列表片段由服务端生成，前端只做 `innerHTML`，避免两套模板）。需 session，否则 401 |
| `POST /api/devices/revoke` | 删 `mcp_devices` 行（`mcp_remote_calls.device_id` 是 `on delete cascade`，调用行一起消失，新调用又因外键插不进去）。需 session + JSON body（跨站 HTML 表单发不出 JSON，作为 CSRF 第二道防线） |
| `GET /api/info` | 原来挂在 `/` 上的自描述 JSON，首页被控制台接管后挪到这里 |

> 首页原先是自描述 JSON，Step 6 改为控制台；机器可读的那份留在 `GET /api/info`。

---

## 3. 数据模型（Supabase）

唯一事实来源：`supabase/migrations/0001_init.sql`（已应用到 `zdtxqyonglqnyrwayins`）。

```sql
mcp_devices(
  id            uuid pk default gen_random_uuid()
  user_id       uuid not null default auth.uid() → auth.users(id)
  device_name   text not null default 'device'
  capabilities  jsonb not null default '{}'
  status        text not null default 'offline'
  last_seen     timestamptz not null default now()
  created_at    timestamptz not null default now()
)

mcp_remote_calls(
  id            uuid pk default gen_random_uuid()
  user_id       uuid not null default auth.uid() → auth.users(id)
  device_id     uuid not null → mcp_devices(id)
  tool_name     text not null
  tool_args     jsonb not null default '{}'
  metadata      jsonb not null default '{}'
  status        text not null default 'pending'   -- pending|executing|completed|failed
  result        jsonb
  error_message text
  created_at    timestamptz not null default now()
  completed_at  timestamptz
  timeout_at    timestamptz not null default now() + interval '5 minutes'
)
```

**索引**：`mcp_remote_calls_claim_idx`（`device_id, created_at` where `status='pending'`，认领用）、
`mcp_remote_calls_sweep_idx`（清扫用）、`mcp_remote_calls_user_idx`、`mcp_devices_user_id_idx`、`mcp_devices_last_seen_idx`。

**RLS（7 条策略，均已实测存在于 `pg_policies`）**

| 表 | 策略 | 角色 | 规则 |
|---|---|---|---|
| `mcp_devices` | select/insert/update own | authenticated | `user_id = auth.uid()` |
| `mcp_remote_calls` | select/update own | authenticated | `user_id = auth.uid()`（pending+timeout 由调用方 WHERE 保证 exactly-once） |
| `realtime.messages` | select/insert own topic | authenticated | `topic = 'user:' \|\| auth.uid()` ← 防 `CHANNEL_ERROR` |

Worker 侧走 `service_role`（bypass RLS），不受上表约束。
`realtime.messages` 已加入 `supabase_realtime` publication（分区表，`pg_publication_tables` 查不到，需查 `pg_publication_rel`）。

### 状态机与 exactly-once

```
pending ──(设备条件 UPDATE 认领)──▶ executing ──▶ completed | failed
```

- 认领：`UPDATE ... WHERE status='pending' AND timeout_at > now()` → 天然 exactly-once。
- `timeout_at = created_at + 5min`。
- 终态行 1 分钟后可删，创建时间 1 小时兜底（清扫）。
- **private broadcast 必须配 RLS 策略**，否则客户端 `CHANNEL_ERROR`。

### 心跳与清扫档位

| | 有能力 `transport_broadcast_v1` | 无能力 |
|---|---|---|
| 心跳 | 5 min | 15 s |
| 服务端清扫档位 | 15 min | 45 s |

token 45 分钟自刷新；`capabilities = { app_version, transport_broadcast_v1?: true }`。

### 清扫函数 `public.sweep_remote_calls()`（已建，实测可执行）

1. 过期 `pending`（`timeout_at < now()`）→ `failed` + `error_message='timeout...'`
2. 终态行 `completed_at < now()-1min` → 删除
3. `created_at < now()-1h` → 兜底删除
4. 设备 `last_seen` 超档位 → `status='offline'`（15min / 45s 两档）

调用方式：`select public.sweep_remote_calls()`（`security definer`，由 Worker cron 或 pg_cron 触发）。

### Realtime

- 私有频道：`user:${user_id}`，presence key = deviceId。
- 广播事件 `new_call`，载荷**只有** `{call_id, device_id}`。
- 服务端发广播走 REST：`POST https://{ref}.supabase.co/realtime/v1/api/broadcast`，body `{messages:[{topic,event,payload,private:true}]}`。
  - **必须同时带 `apikey` 和「用户」的 GoTrue JWT**（`Authorization: Bearer <access_token>`）。
  - 实测坑：只带 `apikey` 会回 **202 但消息被静默丢弃**——私有频道要写 `realtime.messages`，过 RLS `topic = 'user:' || auth.uid()`，没有用户 JWT 时 `auth.uid()` 为空、策略不放行，而接口照样回 202。用 `scripts/probe-broadcast.mjs real-apikey / real-jwt` 可复现（前者 20s 后仍是 `pending`，后者 `completed`）。
  - 旧笔记「带空 `Authorization` 会 500」（supabase/supabase-js#1936）说的是**空串**，与上面这条不冲突。
  - 因此 `src/calls.ts` **没有降级到只带 apikey 的分支**：JWT 拿不到就立刻报错，不让 ChatGPT 白等 4 分钟超时。

---

## 4. 核心时序

### 时序 A：设备配对

```
设备 ─▶ GET  /api/mcp-info          拿到 supabaseUrl + publishable key
设备 ─▶ POST /device/start          拿到 verification_uri + user_code
用户 ─▶ GET  /device/verify         浏览器输密码 + 确认码（服务端代为换取 GoTrue session）
设备 ─▶ POST /device/poll           拿到 GoTrue access/refresh token
设备 ─▶ 写 mcp_devices 行，连 Realtime 频道 user:{id}，开始心跳
```

### 时序 B：一次工具调用（✅ Step 4 已实现，`src/calls.ts`）

```
ChatGPT ─▶ POST /mcp (tools/call)
Worker  ─▶ 选一台在线设备（listDevices，按 last_seen 倒序）
Worker  ─▶ INSERT mcp_remote_calls (status=pending, timeout_at=+5min)
Worker  ─▶ POST realtime/v1/api/broadcast  event=new_call {call_id, device_id}
Worker  ─▶ 轮询该行（自适应退避 500ms→1s→5s，34 轮子请求预算 ≈ 2 分钟，见 §11 第 2 条）
设备    ─▶ 条件 UPDATE 认领 → executing → 本地执行 → 写回 completed/failed
Worker  ─▶ 返回 result（或 isError + 原因）给 ChatGPT
```

要点：

- **投递前先挑设备**：没有 `online` 的设备立刻报错并列出各设备状态，不浪费 5 分钟。
- **定向投递**：`_meta.device_id` 可指定机器（不存在/不在线也立刻报错）；缺省用最近活跃的那台。
- **等不到就明说**：超时 / 广播失败 / 轮询 REST 连挂 5 次，都返回 `isError` 文字原因（按 MCP 规范，工具执行失败要让模型读到原因，而不是抛 JSON-RPC error）。
- **清扫兜底**：Worker 没挂 cron，每次投递前节流（≥10 分钟一次）执行 `purgeRemoteCalls()`，等价于 `sweep_remote_calls()` 里跟调用表有关的两条。

---

## 5. 工具清单（✅ 已静态注册 29/29，且全部接通转发）

ChatGPT 端看到的全部工具 = `server.ts` 的 25 个（`get_prompts` 不暴露）+ 4 个 remote 专属。
`inputSchema` **零手抄**：`scripts/capture-tools.mjs` 直接把官方 npm 包当 stdio server 跑起来、抓 `tools/list`
原样写进 `tools.captured.json`，`src/tools.ts` 过滤掉 `get_prompts` 后再补 4 个 remote 专属定义，最后按 name 排序返回。

**读取（16）**
`get_config` `get_file_info` `get_more_search_results` `get_recent_tool_calls` `get_usage_stats`
`list_devices` `list_directory` `list_processes` `list_searches` `list_sessions`
`ping` `read_file` `read_multiple_files` `read_process_output` `start_search` `who_am_i`

**写入（13）**
`create_directory` `edit_block` `force_terminate` `give_feedback_to_desktop_commander`
`interact_with_process` `kill_process` `move_file` `set_config_value` `shutdown`
`start_process` `stop_search` `write_file` `write_pdf`

备注：

- `list_devices` `ping` `who_am_i` `shutdown` 为 remote 专属，`device.ts` 对 `ping`/`shutdown` 有设备侧特判。
- `track_ui_event` 只有 switch case、无工具定义 → 不暴露。
- `get_prompts` 有定义但 remote 模式不展示 → 不暴露。

---

## 6. 环境变量 / 密钥

| 变量 | 说明 |
|---|---|
| `SUPABASE_URL` | `https://zdtxqyonglqnyrwayins.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_...`，经 `/api/mcp-info` 下发 |
| `SUPABASE_SERVICE_ROLE_KEY` | `sb_secret_...`，服务端写表、清扫（仅 Worker 持有） |
| `DATABASE_URL` | Postgres 直连串，**仅本地跑迁移用**，不配进 Worker |
| `SUPABASE_JWT_SECRET` / GoTrue 配置 | 校验设备 token、桥接授权流 |
| `OAUTH_SIGNING_KEY` | `@cloudflare/workers-oauth-provider` 签名 |
| `AUTH_PASSWORD` | `/device/verify` 与 `/authorize` 的密码，同时是 GoTrue 唯一用户的密码（乙方案，见 §8） |
| `USER_EMAIL` | GoTrue 唯一用户邮箱，`/device/poll` 用 password grant 换真 token |
| `USER_ID` | 唯一用户的 UUID（`56d074bb-5421-45c1-aac3-600f2cb790e7`），乙方案下硬编码进 OAuth token |

真实值只存本地 `.env`（已 gitignore），仓库里只有 `.env.example` 模板。

---

## 7. 仓库现状与改造清单（✅ 已完成）

原为另一项目 `personal-agent-mcp`（`cloudflare-html2sprite-mcp`），已推倒重来：

**保留**

- `src/index.ts` 的 `import { createMcpHandler } from "agents/mcp/server"` 骨架（Step 3 已填上 29 个工具）
- `wrangler.jsonc`（`nodejs_compat`、`compatibility_date`），name 改为 `remotedesktopcloud`；Step 3 加了 `OAUTH_KV` 绑定

**已删除**

- `src/runtime/{registry,session,transport,durable-object}.ts`（死代码）
- `wrangler.toml` —— 与 `wrangler.jsonc` 双配置冲突，`wrangler.jsonc` 优先导致 `env.RUNTIME_SESSIONS` 为 undefined，旧版三个工具全挂

**已重写**

- 业务逻辑全部重写为 `src/{env,supabase,device-auth,index}.ts`
- `package.json` 改名 `remotedesktopcloud`，新增 `@modelcontextprotocol/server@^2`（`createMcpHandler` 期望的 `McpServer` 来自它，不是 `@modelcontextprotocol/sdk`）

---

## 8. 已定决策

| # | 问题 | 结论 |
|---|---|---|
| 1 | 身份贯通 | **乙：环境变量简单密码**。`/authorize` 展示一个密码输入页，校验 `AUTH_PASSWORD`，通过后签发 OAuth token 并硬编码 `USER_ID`。最快落地，单用户场景够用；后续要正统登录再升级到甲方案 |
| 2 | 现有代码 | 保留 `wrangler.jsonc` + `agents/mcp/server` import，删 `src/runtime/` 与 `wrangler.toml`，业务全重写 |
| 3 | 开发顺序 | **倒着做，由本 README 定为**：先设备侧（`/api/mcp-info` + `/device/start|verify|poll`，设备能连上）→ 再 ChatGPT 侧（`/mcp` + OAuth）。理由：设备侧协议被现成 npm 客户端锁死，先做能尽早暴露兼容性问题 |

---

## 9. MVP 清单（顺序已定，倒着做）

| # | 步骤 | 状态 |
|---|---|---|
| 1 | schema + RLS + 清扫（sweep） | ✅ **已完成**（`0001_init.sql` + `0002_device_codes.sql` 已应用并反查验证） |
| 2 | **设备授权流**（`/api/mcp-info` + `/device/start\|verify\|poll` + GoTrue 桥接）→ 先让设备连上 | ✅ **已完成，真机跑通**（官方 npm 包 → 本地 Worker → Supabase，`Channel subscribed` + `Presence tracked` + `online`） |
| 3 | `/mcp` + OAuth（RFC 8414/9728/7591、PKCE、29 工具静态注册）→ 再让 ChatGPT 能调 | ✅ **已完成**（本地全链路 54/54 通过：401→discovery→DCR→authorize→token→initialize→`tools/list`=29） |
| 4 | 核心链路（落库 → 广播 → 等结果 → 返回） | ✅ **已完成，真机跑通**（`scripts/test-remote-call.mjs` **26/26**：ping / get_usage_stats / read_file 真执行，失败与定向投递正确，另有 34.6s 长任务回归） |
| 5 | 端到端联调 | ✅ **已完成，真实 ChatGPT 连接器跑通**（discovery 端点与作用域均为本服务发布的、`list_devices` 直答、`start_process` 真机穿越；四套件 **128 项断言**全绿） |
| 6 | 控制台页面（设备列表 / 在线状态 / 一键复制接入命令） | ✅ **已完成**（`src/console.ts`，`scripts/test-console.mjs` **34/34**，已部署） |

### Step 1 交付物（已完成）

- `supabase/migrations/0001_init.sql` — 建表 / 索引 / 7 条 RLS 策略 / Realtime publication / `sweep_remote_calls()`
- `scripts/migrate.mjs` — 迁移执行器（读 `.env` 的 `DATABASE_URL`，顺序执行、记录 `schema_migrations`、失败回滚）
- `.gitignore` + `.env.example` — 密钥不入库
- 验证方式：反查 `information_schema` / `pg_indexes` / `pg_policies` / `pg_publication_rel` / `pg_proc`，并实跑一次 `sweep_remote_calls()`

### Step 2 交付物（已完成）

- `supabase/migrations/0002_device_codes.sql` — 配对码表（RLS 开启、零策略 = 只有 Worker 可见）
- `src/env.ts` — 环境变量定义与校验
- `src/supabase.ts` — REST/GoTrue 最小封装（service_role 建表行、password grant 签发 token）
- `src/device-auth.ts` — 四个端点 + 验证页（PKCE S256、常量时间密码比较、码用后即焚）
- `src/index.ts` — 路由；旧 `src/runtime/*` 与 `wrangler.toml` 已删
- `scripts/test-device-flow.mjs` — 14 项自测（**14/14 通过**）
- 真机验证：`MCP_SERVER_URL=http://localhost:8787 npx @wonderwhy-er/desktop-commander@latest remote` → 设备 `online`，`capabilities = {app_version:0.2.52, transport_broadcast_v1:true}`

**踩过的坑（已在代码中修掉）**

1. `verify` 与 `poll` 各自建行 → 一次配对产生 2 个设备行。改为 `poll` 优先读 `verify` 写入的 `approved_device_id`，并给 `verify` 加幂等。
2. `@modelcontextprotocol/sdk` 的 `McpServer` 与 `agents/mcp/server` 期望的类型不兼容 → 改用 `@modelcontextprotocol/server`。
3. 本机 `crypto.subtle.digest` 无同步 API → `verifyPkce` 改 async。
4. 客户端有持久化的旧 session/设备 id（`Invalid Refresh Token` 属预期），会走完整重新配对流程——服务端必须容忍并复用仍存在的设备行。

**明确不做**：控制台网页、账单、遥测、feature flags、多租户（数据直接用 Supabase Studio 看）。

### Step 3 交付物（已完成）

- `scripts/capture-tools.mjs` + `tools.captured.json` — 从官方 npm 包的 dist 抓 26 个工具的 `name/description/inputSchema/annotations/_meta`（重跑即可同步设备端）
- `src/tools.ts` — 29 个工具注册表 = 抓来的 25（滤掉 `get_prompts`）+ 4 个 remote 专属
- `src/mcp.ts` — 低层 `Server` + `setRequestHandler('tools/list'|'tools/call')`；`who_am_i` / `list_devices` 云端直答，其余 27 个转交 `src/calls.ts`（Step 4 接通）
- `src/oauth.ts` — `OAuthProvider` 按 origin 惰性构造并缓存；`/authorize` 密码页（`parseAuthRequest` → 校验 `AUTH_PASSWORD` → `completeAuthorization`，props 写入 `userId`/`email`）
- `src/index.ts` — 改为 provider 出口：先做 PRM `/mcp` 后缀别名与 token `resource` 归一化，再交给 `OAuthProvider.fetch`
- `wrangler.jsonc` — 新增 `OAUTH_KV` 绑定（真 id `46ade2b57ca8477f8b40669516398c0d`，已 `wrangler kv namespace create OAUTH_KV` 建好；要重建就重跑这条命令再把 id 填回来）
- `scripts/test-oauth-flow.mjs` — 12 节 54 项断言（Step 4 把「占位」改成「真转发」多加 1 项），**54/54 通过**（Step 2 的 14 项回归也照旧全绿）

**踩过的坑（已在代码中修掉）**

1. `resourceMetadata.resource` 必须是绝对 URI，而本地 `http://localhost:8787` 与线上 workers.dev 不同 → provider 不能写死，改为按 origin 惰性构造 + `Map` 缓存。
2. RFC 9728 的 `/.well-known/oauth-protected-resource/mcp` 变体 provider 只服务「配置的那个精确路径」，另一个会 404 → 在交给 provider 之前先重写到规范路径，两条都能 200。
3. ChatGPT 可能把 `resource` 报成 `origin/mcp`，而我们配置的是 `origin`（与原版一致）→ `/authorize` 的 query 与 `/token` 的 form body 两处都归一到 `origin`，否则 `invalid_target`。
4. 未注册的 UUID `client_id` 会让 `parseAuthRequest` 直接 `invalid_request` → 在解析前按请求的 `redirect_uri`（仅接受 https / loopback）补一条 `client:<id>` 记录。
5. `McpServer.registerTool` 只收 StandardSchema（zod），而我们是抓来的原生 JSON Schema → 改用低层 `Server` 的 `setRequestHandler('tools/list', …)` 原样透传，不做 JSON↔zod 转换。

### Step 4 交付物（已完成）

- `src/calls.ts` — 核心链路：挑设备 → `INSERT mcp_remote_calls` → 广播 `new_call` → 500ms 轮询到终态 → 还原 `CallToolResult`。含 NUL 清洗（jsonb/text 都存不了 U+0000）、GoTrue session 复用、清扫节流。
- `src/supabase.ts` — 新增 `insertRemoteCall`（`Prefer: return=representation` 拿 DB 时钟的 `timeout_at`）/ `getRemoteCall` / `purgeRemoteCalls`
- `src/mcp.ts` — `Result` 类型换成真正的 `CallToolResult`；`tools/call` 取出 `_meta`，27 个工具全部转交 `dispatchCall`
- `scripts/test-remote-call.mjs` — 端到端 **26 项断言**（**26/26 通过**；原 21 项，Step 5 追加第 8 节 34.6s 长任务的子请求预算回归）
- `scripts/probe-broadcast.mjs` — 广播送达探针（`real-apikey` / `real-jwt` 两档对照，用来证明「202 ≠ 送达」）
- `scripts/test-oauth-flow.mjs` — 第 10 节由「占位」断言改为「真转发」断言，**54/54 通过**；`test-device-flow` 14/14 回归也全绿
- `package.json` — 新增 `npm run test:call`

**真机验证结果**

| 用例 | 结果 |
|---|---|
| `ping` | `pong 2026-10-07T02:39:59.471Z`（设备侧特判，全链路 3.8s） |
| `get_usage_stats` / `read_file` | 设备上真实执行，内容原样回传 |
| 不存在的工具名 | 设备端 `Unknown tool` → 还原成 `isError` |
| `_meta.device_id` 指向不存在的设备 | 488ms 立刻报错（不等超时） |
| `_meta.device_id` 正确 | 照常 `pong` |

**踩过的坑（已在代码中修掉）**

1. **私有频道广播 202 ≠ 送达**：只带 `apikey` 时 Realtime 照样回 202，但消息被 RLS 静默丢弃，设备永远收不到 → 必须带**用户**的 GoTrue JWT。原来 README 记的「只能带 apikey」是错的，已订正（§3）。
2. 客户端参数里可能有 NUL → 整条 INSERT 报 22P05 → 写入前 `stripNul()` 递归清洗（设备侧写回时做同样的事）。
3. 设备不在线时如果照常投递，会白等满 5 分钟才超时 → 挑设备这一步先判 `status='online'`，立刻给模型可行动的错误信息。
4. Worker 没有 cron，`mcp_remote_calls` 的终态行会堆积 → 每次投递前节流跑一次 `purgeRemoteCalls()`。

### Step 5 交付物（✅ 已完成：真实 ChatGPT 连接器跑通）

**线上地址**：`https://remotedesktopcloud.txdygl.workers.dev`
（最新 Version `145638bf`，bundle 994.96 KiB / gzip 206.50 KiB）

**已完成**

1. 清掉 Step 2 自测留下的 5 条 `selftest-host` 孤儿设备行与 6 条终态调用行。
2. `wrangler secret put` × 6：`SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `AUTH_PASSWORD` / `USER_ID` / `USER_EMAIL`（`.dev.vars` 同源，未入库）。
3. `npm run deploy` 成功，KV 绑定读的是真 namespace `46ade2b57ca8477f8b40669516398c0d`。
4. 设备端改指生产地址重新拉起 —— **复用持久化 session，无需重新配对**（`Session restored` → `Channel subscribed` → `Presence tracked` → `online`）。
5. 四套件全绿（**128 项断言**；建议直接对 `http://localhost:8787` 跑，见坑 3）：

| 套件 | 命令 | 结果 |
|---|---|---|
| 控制台页面 | `node scripts/test-console.mjs <地址>` | **34/34** |
| ChatGPT 侧 OAuth + MCP | `node scripts/test-oauth-flow.mjs <地址>` | **54/54** |
| 设备配对流 | `node scripts/test-device-flow.mjs <地址>` | **14/14** |
| 真机工具转发（含长任务） | `node scripts/test-remote-call.mjs <地址>` | **26/26** |

6. **真实 ChatGPT 连接器**（Step 5 的最后一环，也是 §11 第 1 条原判的"最大风险"）：
   - 连接器对话框选 `OAuth`，「OAuth 高级设置」自动发现出的 Auth / 令牌 / 注册 URL **就是我们发布的** `/authorize`、`/token`、`/register`，授权服务器基础与资源都是本 Worker origin；
   - 默认作用域列出 **`mcp:tools` / `desktop:auth`** —— 这两个值只存在于我们 AS metadata 的 `scopes_supported` 里，不可能是 ChatGPT 的默认值，**证明 RFC 9728 → 8414 discovery 真读了我们的 JSON**；
   - 注册方法自动落到 **DCR**；`CIMD 不可用`、`OIDC 未启用` 两条警告都是回退到我们没实现的分支，无影响；
   - 授权后 `list_devices` 云端直答 `Mac / online / v0.2.52`；`start_process` 真机穿越成功（DB `metadata` 里带 `openai/session`、`openai/userAgent`、`openai/userLocation` 及坐标）。

**真机发现并修掉的两个问题**（详见 §11 第 2、7 条）

1. **设备写回的假阴性** —— ChatGPT 那次 ping 在 DB 里是 `status=failed`，但 `result` 躺着完整的 ping 输出。设备端「UPDATE 已提交、HTTP 响应丢失」时误判失败并补写 `failed`。`calls.ts` 现在以「`failed` 且有 `result`」→ 以 result 为准。
2. **子请求预算** —— Workers Free 单次请求 50 个子请求，固定 500ms 轮询约 40 轮就撞 `Too many subrequests`（真机复现：一次 `read_file` 拖到 39s 翻车）。改成自适应退避 + 34 轮预算，34.6s 长任务回归通过。

**踩过的坑**

1. **本机直连 `workers.dev` 不通**（`curl` 20s 超时），必须走 `http://127.0.0.1:7897`。Node 的 `fetch` 默认**不读** `http_proxy`，要加 `NODE_USE_ENV_PROXY=1`（Node 24+）才能让自测脚本和设备端都走代理：
   ```bash
   NODE_USE_ENV_PROXY=1 https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 \
     npx @wonderwhy-er/desktop-commander@latest remote
   ```
   这只影响**本机**的网络环境；ChatGPT 从 OpenAI 侧访问 workers.dev 不需要代理。
2. `wrangler secret put` 第一次执行会顺带把 Worker 注册出来（`Creating new Worker`），属于正常输出。
3. **本机代理在突发请求下会断连** —— 自测脚本偶发 `TypeError: terminated` / `SocketError: other side closed`，这是**测试客户端**的问题，不是服务端。两条出路：重跑，或者直接对 `http://localhost:8787` 跑（本地 dev 不经代理，而设备连的是**同一个 Supabase**，转发/广播照样通，四套件本地全绿已验证）。

---

### Step 6 交付物（已完成：控制台页面）

用户补充需求：要一个页面能看到**有哪些设备、每台是否在线**，点「添加设备」**复制一条命令**到终端执行（配图是原版产品的 Devices 页）。

1. `src/console.ts`（新增）—— 首页 `/` 从自描述 JSON 改为控制台：
   - **设备面板**：绿点/灰点 + `Online`/`Offline` 徽标、`Last seen … · v<版本>`、每行 `Revoke`，右上角 `+ Add a device`。首屏由服务端渲染，之后每 5s 拉 `/api/devices` 覆盖列表片段。
   - **接入命令卡**：`MCP_SERVER_URL=<当前 origin> npx @wonderwhy-er/desktop-commander@latest remote`，点按钮进剪贴板；另有一个折叠项给出**带代理的完整命令**（本机直连 `workers.dev` 不通的坑，见 Step 5）。
   - **Where you use it**：`<origin>/mcp` 连接器 URL，一键复制。
   - 登录页复用 `device-auth.ts` 的 `page()`；密码校验复用 `constantTimeEquals`。
2. **Session = 乙方案密码 + KV**：`POST /login` 通过后往 `OAUTH_KV` 写 `console:<随机 token>`（TTL 7 天），下发 `rdc_console` cookie（`HttpOnly` + `SameSite=Lax`；`https` 时才加 `Secure`，本地 `http://localhost` 才设得进去）。
   - CSRF 双保险：`SameSite=Lax` 让跨站 POST 不带 cookie；两个写接口只收 JSON body，跨站 HTML 表单发不出 JSON。
3. `src/supabase.ts` 加 `deleteDevice()` —— 删 `mcp_devices` 行，`mcp_remote_calls.device_id` 的 `on delete cascade` 把它的调用行一并清掉，新调用又因外键插不进去 → 这台机器立刻从 ChatGPT 的可选目标里消失。
4. 自描述 JSON 挪到 `GET /api/info`（首页被控制台接管）。
5. `scripts/test-console.mjs`（新增，`npm run test:console`）**34/34 通过**：登录页 → 密码错/对 → cookie 属性 → 面板渲染（含 origin 的接入命令、连接器 URL、5s 轮询、Sign out）→ `/api/devices` 401/200 → revoke 的非法 id / 非 JSON body / 真删（建临时行，不碰真实设备）/ 幂等 / 真实设备未被误删 → logout 后 session 失效 → `/api/info`。
6. **部署并四套件对生产全绿**：`34/34 + 54/54 + 14/14 + 21/21 = 123 项断言`（Version `8365aba8-351d-4659-b480-1dd620d7139d`）。自测遗留的 `console-selftest` / `selftest-host` 孤儿行已清，DB 只剩 `Mac/online`。

---

## 10. 免费额度与用量预估

Supabase Free：200 并发 Realtime 连接、200 万消息/月、**API 请求无限**、500MB DB、5GB egress、50000 MAU、2 个活跃项目、**1 周不活跃自动暂停**、无备份、日志保留 1 天。
Cloudflare Free：Workers 请求量充足。

1 人 2-3 台设备的预估用量远低于 5%。

参考：原版生产门铃量 `~126k/day`（代码注释）≈ 378 万/月，**会超免费额度**——但那是多租户商业量级，我们单用户不会触及。

风险提示：项目 1 周不活跃会被 Supabase 自动暂停（回来需手动 resume）；Free 无备份。

---

## 11. 已知技术风险

1. **端到端联调** —— ✅ **已清除（Step 5 真机通过）**。
   - 设备侧协议（`/mcp-info`、`/device/*`、GoTrue session、Realtime private channel + presence）已真机验证；
   - **真实 ChatGPT 连接器已跑通**，三条硬证据：
     1. ChatGPT 的「OAuth 高级设置」里列出的端点**就是我们发布的** `/authorize` / `/token` / `/register`，授权服务器基础与资源都是本 Worker origin；
     2. 它列出的默认作用域是 **`mcp:tools` / `desktop:auth`** —— 这两个值只存在于我们 AS metadata 的 `scopes_supported` 里，不是 ChatGPT 的默认值，说明 RFC 9728 → 8414 的 discovery 真读了我们的 JSON；
     3. 注册方法自动落到 **DCR**（`CIMD 不可用` 的警告只是回退到我们唯一实现的路径；`OIDC 未启用` 同理，我们没发布 openid-configuration，ChatGPT 只用它取 email，grant props 里已带）。
   - 授权后：`list_devices` 云端直答 `Mac / online / v0.2.52`；`start_process` 真机穿越成功（metadata 里带 `openai/session`、`openai/userAgent`、`openai/userLocation`）。
   - 四套件全绿 **34/34 + 54/54 + 14/14 + 26/26 = 128 项断言**。
   - 仍未覆盖：ChatGPT 侧的手动 OAuth 端点输入（我们走自动发现即可）。
2. **长等待 / 子请求预算** —— ✅ **真机撞过墙，已定位并修复**。
   - **Cloudflare Workers Free：子请求 50 次/请求**（`fetch()` 和 KV/R2/D1 都算，[limits 页](https://developers.cloudflare.com/workers/platform/limits/)）。注意 **HTTP 请求本身没有时长上限**（客户端连着就能一直做子请求），CPU 才是 10ms/请求。
   - 原来固定 500ms 一轮 → 理论 240s 要 480 次，**实际约 40~45 轮就撞墙**。真机复现：一次 `read_file` 因设备侧偶发变慢拖到 39s，返回 `Too many subrequests by single Worker invocation`。
   - 修法：**自适应退避 + 轮询预算**（`POLL_BUDGET = 34`，`src/calls.ts`）——头 3s 按 500ms、3~12s 按 1s、之后 5s 一次。真机每轮约 0.8s（500ms 睡眠 + REST 往返），34 轮覆盖**约 2 分钟**；撞预算时抛 `PollBudgetExhausted`，给 ChatGPT 返回人话而不是 Cloudflare 的原始错误。
   - **回归用例**：`test-remote-call` 第 8 节 —— `start_process` 卡 **34.6s** 的单次调用必须成功（老代码要 ~70 次轮询，必然失败）。
   - 剩余限制：单次调用最长等**约 2 分钟**，不是 240s。要更长只能升 Paid（子请求 10,000）。
3. private broadcast 的 RLS 策略 —— ✅ 已配置且真机通过（设备成功 `Channel subscribed` + `Presence tracked`；Step 4 进一步验证了「服务端带用户 JWT 发广播 → 设备真的收到并执行」）。
4. 13MB 级 `result` 经 Workers 传递。
5. 本机连 Supabase 直连域名偶发 DNS 解析失败（`db.<ref>.supabase.co`），`pg` 直连实测可用；失败时重试即可。
6. **Bundle 体积** —— ✅ **已排除（先前记的"离 1 MiB 上限只剩 2.9%"是错的，作废）**。
   - wrangler 输出的 `Total Upload: 994.96 KiB` 是**未压缩**值，`gzip: 206.50 KiB` 只是参考。原来拿未压缩的 993 KiB 去比一个"1 MiB 上限"，**那个上限不存在**。
   - 旧规则是 **压缩后 3 MB（Free）**——我们 gzip 206 KiB 只占 6.9%，从来就不紧张。
   - **2026-09-04 起 Cloudflare 取消了压缩后 3 MB / 10 MB 的限制，只检查未压缩 bundle，全档位 64 MiB**（[changelog](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/)）。我们 0.99 MiB = 上限的 **1.5%**，还有 60 多 MiB 余量。
   - 因此**不再需要为了 bundle 而裁依赖**（当初考虑过"砍掉 `@cloudflare/workers-oauth-provider` 换体积"，理由已不成立）。要看这个数就跑 `npx wrangler deploy --dry-run`。
7. **设备侧写回的假阴性** —— 已在 Worker 侧兜住，但 DB 会留下「`status=failed` 却有 `result`」的行。
   - 设备端 `remote-channel.ts` 的 fail-fast 兜底：结果写入的 UPDATE **已提交**、HTTP 响应却在半路丢了（实测 `TypeError: fetch failed`，设备经本地代理连 Supabase 时出现），客户端误判成写入失败，再补一发把 `status` 改成 `failed`（**不清 `result`**）。
   - 真机复现过一次（ChatGPT 那次 ping，结果其实正常返回给了 ChatGPT）。对照真正在跑的 npm 包 `dist/` 确认：真执行失败写的是 `('failed', null, error)`，所以**「failed 且有 result」只可能是这个假阴性** → `calls.ts` 以 `result` 为准。
   - 可选的彻底修法在设备侧（写回失败先回读一次再决定），但设备端是 npm 包，不在本仓库约束内。

---

## 12. 本地开发

```bash
cp .env.example .env      # 填好各变量（.env 已被 gitignore）
npm install
npm run migrate           # 执行 supabase/migrations/*.sql
npm run migrate:status    # 只看哪些还没跑
npm run dev               # wrangler dev → http://localhost:8787（读 .dev.vars，同样不入库）
```

> 迁移执行器用 Node `pg` 直连 `DATABASE_URL`（本机无 brew/psql，故不依赖 psql）。

Step 2 / 3 / 4 / 6 自测（需先 `npm run dev`）：

```bash
node scripts/test-device-flow.mjs   # 14 项断言，覆盖设备配对全流程
node scripts/test-oauth-flow.mjs    # 54 项断言，覆盖 ChatGPT 侧 OAuth + MCP 全流程
npm run test:call                   # 26 项断言，真机转发（需设备在线；第 8 节是 ~35s 长任务）
npm run test:console                # 34 项断言，Step 6 控制台页面 + 两个 API
npm run tools:capture               # 重抓设备端工具定义 → tools.captured.json
node scripts/probe-broadcast.mjs real-jwt   # 探针：证明门铃真的送达（real-apikey 会证明「202 ≠ 送达」）
```

> **四个套件合计 128 项断言。建议对 `http://localhost:8787` 跑**：本地 dev 不经代理，而设备连的是同一个 Supabase，转发与广播照样通（已验证）。对线上跑则必须带 `NODE_USE_ENV_PROXY=1` + 两个 proxy 变量，且本机代理在突发请求下会断连、脚本偶发 `TypeError: terminated` —— 那是客户端问题，重跑即可。

> `test-oauth-flow.mjs` 走的是 ChatGPT 的真实顺序：`POST /mcp` 401 拿 `resource_metadata` → RFC 9728/8414 discovery
> → RFC 7591 DCR → `GET/POST /authorize` 密码页 → `/token` 换 code → `initialize` → `tools/list`(=29) → `tools/call`。

真机联调（设备侧）：

```bash
MCP_SERVER_URL=http://localhost:8787 npx @wonderwhy-er/desktop-commander@latest remote
# 已配对过会直接复用 ~/.desktop-commander-device/device.json；否则打印 verification_uri_complete 与配对码，
# 浏览器打开并输入 AUTH_PASSWORD 即可
```

MCP 端点调试用 MCP Inspector 连 `http://localhost:8787/mcp`。

**部署：推 `main` 即自动上线（Cloudflare Workers Builds）**

仓库已通过 Cloudflare 的 **Workers Builds** 连到 Worker `remotedesktopcloud`
（Worker → 设置 → 构建 → Git 存储库）。推 commit 到 `main` 就会构建并部署，**不用建 API token、不用 GitHub Secrets**。

| 项 | 值 |
|---|---|
| Git 存储库 | `958877748/RemoteDesktopCloud`，生产分支 `main` |
| 构建命令 | `npm run typecheck` ← **类型检查不过就不部署**，相当于 verify 门 |
| 部署命令 | `npx wrangler deploy`（默认，wrangler 版本取自 `package.json`） |
| 根目录 | `/` |
| 预览构建 | **已关闭**（只用 `main`；预览环境没有 KV 绑定和运行时 secrets，开着只会在推分支时白跑一个红叉） |
| API 令牌 | Cloudflare 自动生成（`Workers Scripts: Edit` + `Workers KV Storage: Edit` + `User Details: Read`） |

> 构建历史：Worker → **部署** → `View build history`。一次约 1~2 分钟；
> 免费额度 **3,000 build 分钟/月**（1 并发、20 分钟超时、2 vCPU / 8 GB）。
> 依赖按 `package-lock.json` 自动安装。
>
> 选 Build command 是 `npm run typecheck` 而不是 `wrangler deploy --dry-run`：typecheck 已经能挡住
> 唯一会让部署出错的那类改动，dry-run 只是重复打包，deploy 自己会验 bundle。
>
> 曾写过 `.github/workflows/deploy.yml` 走 GitHub Actions（verify job + deploy job），因 Workers Builds
> **不需要手动建 Cloudflare API token**、且部署历史直接挂在 Worker 上，**已弃用并删除**。

上线时的一次性步骤（已完成，不用重做）：

```bash
npx wrangler login                        # ✅ 已完成
npx wrangler kv namespace create OAUTH_KV # ✅ 已完成，id 已填进 wrangler.jsonc
npx wrangler secret put SUPABASE_URL      # ✅ 6 个 secret 全部上传
# 其余 5 个：SUPABASE_PUBLISHABLE_KEY / SUPABASE_SERVICE_ROLE_KEY
#            AUTH_PASSWORD / USER_ID / USER_EMAIL
npm run deploy                            # 本地手动发版（等同，但会绕过 typecheck 门）
# → https://remotedesktopcloud.txdygl.workers.dev
```

> **6 个运行时 secret 存在 Cloudflare 侧**，`wrangler deploy` 不会覆盖或删除它们 ——
> 所以自动部署不需要在任何 CI 里传密钥。

> 全局敲 `wrangler` 会 `command not found`（只是本地 devDependency），一律用 `npx wrangler ...`。
> 三个自测脚本都吃第二个参数当 baseUrl，所以同一套断言可以直接打生产：
> `node scripts/test-oauth-flow.mjs https://remotedesktopcloud.txdygl.workers.dev`（要带代理，见下）。

**ChatGPT 连接器配置**

1. ChatGPT → 设置 → 连接器（Connectors）→ 添加自定义连接器
2. URL 填 `https://remotedesktopcloud.txdygl.workers.dev/mcp`
3. 授权时会跳到本服务的密码页，输入 `AUTH_PASSWORD` 即可（乙方案，见 §8）
4. 连上后应看到 29 个 Desktop Commander 工具；先问一句「列出我的设备」，再让它读个文件验证转发

### 网络备注（本机）

需走代理才能访问 github/npm：`http_proxy=http://127.0.0.1:7897`；`~/.ssh` 无密钥，clone 一律 HTTPS。
