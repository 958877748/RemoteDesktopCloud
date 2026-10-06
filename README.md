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

> 状态：架构与三项关键决策已全部敲定（见 §8），**尚未开始编码**。本 README 即为对齐后的设计文档，开发顺序见 §9。

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

### ChatGPT 硬性要求（缺一不可）

| 端点 | 规范 | 说明 |
|---|---|---|
| `POST /mcp` | Streamable HTTP | 公网 HTTPS，MCP 传输 |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 | 资源元数据 |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 | 授权服务器元数据 |
| `GET /authorize` | OAuth 2.1 + PKCE S256 | `redirect_uri` 必须允许 `https://chatgpt.com/connector_platform_oauth_redirect` |
| `POST /token` | OAuth 2.1 | 发 token |
| `POST /register` | RFC 7591 DCR | 必须接受任意 UUID `client_id` |

现成组件：`@cloudflare/workers-oauth-provider` 覆盖 OAuth 2.1 + DCR + RFC 8414；`createMcpHandler`（`agents/mcp/server`）覆盖 Streamable HTTP。

### 设备端注入点

| 端点 | 说明 |
|---|---|
| `GET /api/mcp-info` | 返回 `supabaseUrl`、`supabasePublishableKey` 等 |
| `POST /device/start` | 发起设备配对，返回 `verification_uri` + `user_code` |
| `GET /device/verify` | 用户在浏览器输入 `AUTH_PASSWORD` + 配对码确认（乙方案，同 `/authorize` 共用密码页组件） |
| `POST /device/poll` | 轮询配对结果，**必须返回 GoTrue 签发的 `access_token`/`refresh_token`** |

> ⚠️ 关键约束：`/device/poll` 的 token 若非 GoTrue 签发，设备端 `client.auth.setSession()` 直接失败 → 设备授权流必须与 GoTrue 桥接。

### 其他

- `GET /` 健康检查。

---

## 3. 数据模型（Supabase）

```sql
mcp_devices(
  id, user_id, device_name, capabilities, status, last_seen
)

mcp_remote_calls(
  id, user_id, device_id, tool_name, tool_args, metadata,
  status, result, error_message, created_at, completed_at, timeout_at
)
```

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

### Realtime

- 私有频道：`user:${user_id}`，presence key = deviceId。
- 广播事件 `new_call`，载荷**只有** `{call_id, device_id}`。
- 服务端发广播走 REST：`POST https://{ref}.supabase.co/realtime/v1/api/broadcast`，body `{messages:[{topic,event,payload,private:true}]}` → 202。
  - **只能带 `apikey` 头，带空 `Authorization` 会 500**（supabase/supabase-js#1936）。

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

### 时序 B：一次工具调用

```
ChatGPT ─▶ POST /mcp (tools/call)
Worker  ─▶ INSERT mcp_remote_calls (status=pending, timeout_at=+5min)
Worker  ─▶ POST realtime/v1/api/broadcast  event=new_call {call_id, device_id}
Worker  ─▶ 轮询该行（等待终态或超时）
设备    ─▶ 条件 UPDATE 认领 → executing → 本地执行 → 写回 completed/failed
Worker  ─▶ 返回 result 给 ChatGPT
```

---

## 5. 工具清单（29 个，须静态注册）

ChatGPT 端看到的全部工具 = `server.ts` 的 25 个（`get_prompts` 不暴露）+ 4 个 remote 专属。
`inputSchema` 用 `zodToJsonSchema(...)` 构建期生成后硬编码，不运行时依赖 `server.ts`。

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
| `SUPABASE_URL` | 托管 Supabase 项目地址 |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_...`，经 `/api/mcp-info` 下发 |
| `SUPABASE_SERVICE_ROLE_KEY` | 服务端写表、清扫（仅 Worker 持有） |
| `SUPABASE_JWT_SECRET` / GoTrue 配置 | 校验设备 token、桥接授权流 |
| `OAUTH_SIGNING_KEY` | `@cloudflare/workers-oauth-provider` 签名 |
| `AUTH_PASSWORD` | `/authorize` 页面用的简单密码（已选乙方案，见 §8） |
| `USER_ID` | 唯一用户的 UUID，乙方案下直接硬编码进 OAuth token |

---

## 7. 仓库现状与改造清单

现状：本仓库原为另一项目 `personal-agent-mcp`（`cloudflare-html2sprite-mcp`），需推倒重来，骨架可留。

**保留**

- `src/index.ts` 第 1 行 `import { createMcpHandler } from "agents/mcp/server"`
- `wrangler.jsonc`（`nodejs_compat`、`compatibility_date`）

**删除**

- `src/runtime/{registry,session,transport}.ts`（死代码）
- `wrangler.toml` —— 与 `wrangler.jsonc` 双配置冲突，`wrangler.jsonc` 优先导致 `env.RUNTIME_SESSIONS` 为 undefined，旧版三个工具全挂

**重写**

- 全部业务逻辑（旧版 `sprite_test` 工具、DO 绑定等一并清除）
- `package.json` 改名 `remotedesktopcloud`，加 `@cloudflare/workers-oauth-provider`

---

## 8. 已定决策

| # | 问题 | 结论 |
|---|---|---|
| 1 | 身份贯通 | **乙：环境变量简单密码**。`/authorize` 展示一个密码输入页，校验 `AUTH_PASSWORD`，通过后签发 OAuth token 并硬编码 `USER_ID`。最快落地，单用户场景够用；后续要正统登录再升级到甲方案 |
| 2 | 现有代码 | 保留 `wrangler.jsonc` + `agents/mcp/server` import，删 `src/runtime/` 与 `wrangler.toml`，业务全重写 |
| 3 | 开发顺序 | **倒着做，由本 README 定为**：先设备侧（`/api/mcp-info` + `/device/start|verify|poll`，设备能连上）→ 再 ChatGPT 侧（`/mcp` + OAuth）。理由：设备侧协议被现成 npm 客户端锁死，先做能尽早暴露兼容性问题 |

---

## 9. MVP 清单（顺序已定，倒着做）

1. schema + RLS + 清扫（sweep）
2. **设备授权流**（`/api/mcp-info` + `/device/start|verify|poll` + GoTrue 桥接）→ 先让设备连上
3. `/mcp` + OAuth（RFC 8414/9728/7591、PKCE、29 工具静态注册）→ 再让 ChatGPT 能调
4. 核心链路（落库 → 广播 → 等结果 → 返回）
5. 端到端联调

**明确不做**：控制台网页、账单、遥测、feature flags、多租户（数据直接用 Supabase Studio 看）。

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
2. Workers `/mcp` 能否 `await` 到 5 分钟（调用等待上限）。
3. private broadcast 的 RLS 策略配置。
4. 13MB 级 `result` 经 Workers 传递。

---

## 12. 本地开发

```bash
npm install
npm run dev          # wrangler dev → http://localhost:8787
```

设备侧联调：

```bash
MCP_SERVER_URL=http://localhost:8787 npx @wonderwhy-er/desktop-commander@latest remote
```

MCP 端点调试用 MCP Inspector 连 `http://localhost:8787/mcp`。

```bash
npx wrangler login
npm run deploy
```

### 网络备注（本机）

需走代理才能访问 github/npm：`http_proxy=http://127.0.0.1:7897`；`~/.ssh` 无密钥，clone 一律 HTTPS。
