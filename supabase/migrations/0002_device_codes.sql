-- Step 2 前置：设备配对码表（OAuth device flow 的服务端状态）
-- 只有 Worker（service_role）读写，authenticated 角色无任何策略 = 不可见

create table if not exists public.mcp_device_codes (
  device_code          text primary key,
  user_code            text not null unique,          -- 用户在浏览器里核对的 XXXX-XXXX
  client_id            text not null default 'mcp-device',
  device_name          text,
  device_type          text,
  device_id            uuid,                           -- 复授权时设备自带的旧 id（可能已吊销）
  code_challenge       text not null,                  -- S256
  code_challenge_method text not null default 'S256',
  status               text not null default 'pending', -- pending | approved | denied
  approved_device_id   uuid,                           -- 批准后分配/确认的设备 id
  expires_at           timestamptz not null,
  created_at           timestamptz not null default now()
);

create index if not exists mcp_device_codes_expires_idx
  on public.mcp_device_codes (expires_at);

alter table public.mcp_device_codes enable row level security;
-- 故意不建任何策略：设备端不需要、也不能碰配对码
