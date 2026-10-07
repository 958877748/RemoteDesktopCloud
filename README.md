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

> 状态：架构与三项关键决策已敲定（见 §8）。**进度：Step 1 ✅ Step 2 ✅ Step 3 ✅ Step 4 ✅ 均已完成**（建表 → 设备授权流 → `/mcp` + OAuth + 29 工具 → 核心转发链路真机跑通），进行中为 Step 5。实时进度见 §9。

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

### 其他

- `GET /` 健康检查。

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
Worker  ─▶ 轮询该行（500ms 一次，等到终态或 240s 上限）
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
| 4 | 核心链路（落库 → 广播 → 等结果 → 返回） | ✅ **已完成，真机跑通**（`scripts/test-remote-call.mjs` 21/21：ping / get_usage_stats / read_file 真执行，失败与定向投递也正确） |
| 5 | 端到端联调 | 进行中 |

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
- `scripts/test-remote-call.mjs` — 端到端 21 项断言（**21/21 通过**）
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

---

## 10. 免费额度与用量预估

Supabase Free：200 并发 Realtime 连接、200 万消息/月、**API 请求无限**、500MB DB、5GB egress、50000 MAU、2 个活跃项目、**1 周不活跃自动暂停**、无备份、日志保留 1 天。
Cloudflare Free：Workers 请求量充足。

1 人 2-3 台设备的预估用量远低于 5%。

参考：原版生产门铃量 `~126k/day`（代码注释）≈ 378 万/月，**会超免费额度**——但那是多租户商业量级，我们单用户不会触及。

风险提示：项目 1 周不活跃会被 Supabase 自动暂停（回来需手动 resume）；Free 无备份。

---

## 11. 已知技术风险

1. **端到端联调** —— 协议兼容性只能真机暴露（最大风险）。
   - 设备侧协议（`/mcp-info`、`/device/*`、GoTrue session、Realtime private channel + presence）**已真机验证通过**；
   - ChatGPT 侧的 **OAuth + MCP 协议面已在本地按 RFC 顺序全部验证**（`scripts/test-oauth-flow.mjs` 54/54）；
   - **Step 4 工具转发已在本地对真设备验证**（`scripts/test-remote-call.mjs` 21/21，ping / 读文件 / 统计 / 失败传播 / 定向投递）；
   - 仍未验证：**真实 ChatGPT 连接器**（需先部署到公网，见 §12），以及线上 Workers 的长 `await`。
2. **长等待** —— `/mcp` 里 `tools/call` 会把 HTTP 响应一直挂着轮询（上限 `MAX_WAIT_MS = 240s`，见 `src/calls.ts`）。
   本地 `wrangler dev` 实测多秒级没问题；**部署到线上 Workers 后能否挂到分钟级、以及 ChatGPT 自己的 HTTP 超时是多少**，要 Step 5 真机才知道。缓解：正常调用都在 3s 内返回，只有长任务才会顶到上限。
3. private broadcast 的 RLS 策略 —— ✅ 已配置且真机通过（设备成功 `Channel subscribed` + `Presence tracked`；Step 4 进一步验证了「服务端带用户 JWT 发广播 → 设备真的收到并执行」）。
4. 13MB 级 `result` 经 Workers 传递。
5. 本机连 Supabase 直连域名偶发 DNS 解析失败（`db.<ref>.supabase.co`），`pg` 直连实测可用；失败时重试即可。
6. **Bundle 体积**：`wrangler deploy --dry-run` 实测 `978.45 KiB / gzip 201.11 KiB`，离 Workers 免费版 1 MiB 上限只剩约 4.4%（Step 4 加了 `calls.ts`，涨了 7.5 KiB）。以后每加依赖都要看一眼这个数。

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

Step 2 / 3 / 4 自测（需先 `npm run dev`）：

```bash
node scripts/test-device-flow.mjs   # 14 项断言，覆盖设备配对全流程
node scripts/test-oauth-flow.mjs    # 54 项断言，覆盖 ChatGPT 侧 OAuth + MCP 全流程
npm run test:call                   # 21 项断言，Step 4 真机转发（需设备在线）
npm run tools:capture               # 重抓设备端工具定义 → tools.captured.json
node scripts/probe-broadcast.mjs real-jwt   # 探针：证明门铃真的送达（real-apikey 会证明「202 ≠ 送达」）
```

> `test-oauth-flow.mjs` 走的是 ChatGPT 的真实顺序：`POST /mcp` 401 拿 `resource_metadata` → RFC 9728/8414 discovery
> → RFC 7591 DCR → `GET/POST /authorize` 密码页 → `/token` 换 code → `initialize` → `tools/list`(=29) → `tools/call`。

真机联调（设备侧）：

```bash
MCP_SERVER_URL=http://localhost:8787 npx @wonderwhy-er/desktop-commander@latest remote
# 已配对过会直接复用 ~/.desktop-commander-device/device.json；否则打印 verification_uri_complete 与配对码，
# 浏览器打开并输入 AUTH_PASSWORD 即可
```

MCP 端点调试用 MCP Inspector 连 `http://localhost:8787/mcp`。

部署（Step 5 用，本地开发不需要）：

```bash
npx wrangler login                        # ✅ 已完成
npx wrangler kv namespace create OAUTH_KV # ✅ 已完成，id 已填进 wrangler.jsonc
# 生产环境变量：SUPABASE_* / AUTH_PASSWORD / USER_ID / USER_EMAIL 逐个 wrangler secret put
npm run deploy
```

> 登录与 KV 都已就绪，Step 5 只剩 `wrangler secret put` × 5 和 `npm run deploy`。
> 全局敲 `wrangler` 会 `command not found`（只是本地 devDependency），一律用 `npx wrangler ...`。

### 网络备注（本机）

需走代理才能访问 github/npm：`http_proxy=http://127.0.0.1:7897`；`~/.ssh` 无密钥，clone 一律 HTTPS。
