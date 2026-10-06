-- RemoteDesktopCloud — Step 1: schema + RLS + sweep
-- 目标：Supabase（zdtxqyonglqnyrwayins）
-- 执行方式：见 README §9 Step 1

-- ============================================================
-- 1. 设备表
-- ============================================================
create table if not exists public.mcp_devices (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  device_name text not null default 'device',
  capabilities jsonb not null default '{}'::jsonb,
  status      text not null default 'offline',
  last_seen   timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists mcp_devices_user_id_idx on public.mcp_devices (user_id);
create index if not exists mcp_devices_last_seen_idx on public.mcp_devices (last_seen desc);

-- ============================================================
-- 2. 远程调用表（任务队列）
--    状态机：pending -> executing -> completed | failed
--    exactly-once 靠条件 UPDATE：where status='pending' and timeout_at > now()
-- ============================================================
create table if not exists public.mcp_remote_calls (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  device_id     uuid not null references public.mcp_devices (id) on delete cascade,
  tool_name     text not null,
  tool_args     jsonb not null default '{}'::jsonb,
  metadata      jsonb not null default '{}'::jsonb,
  status        text not null default 'pending',
  result        jsonb,
  error_message text,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  timeout_at    timestamptz not null default now() + interval '5 minutes'
);

create index if not exists mcp_remote_calls_claim_idx
  on public.mcp_remote_calls (device_id, created_at)
  where status = 'pending';

create index if not exists mcp_remote_calls_sweep_idx
  on public.mcp_remote_calls (status, timeout_at, created_at);

create index if not exists mcp_remote_calls_user_idx
  on public.mcp_remote_calls (user_id, created_at desc);

-- ============================================================
-- 3. RLS：设备（authenticated 角色）只碰自己 user_id 的行
--    Worker 走 service_role（bypass RLS），不在此列
-- ============================================================
alter table public.mcp_devices enable row level security;
alter table public.mcp_remote_calls enable row level security;

-- mcp_devices：设备配对时 upsert 自己的行、心跳刷 last_seen
drop policy if exists devices_select_own on public.mcp_devices;
create policy devices_select_own on public.mcp_devices
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists devices_insert_own on public.mcp_devices;
create policy devices_insert_own on public.mcp_devices
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists devices_update_own on public.mcp_devices;
create policy devices_update_own on public.mcp_devices
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- mcp_remote_calls：设备读取属于自己设备的调用、认领、写回结果
drop policy if exists calls_select_own on public.mcp_remote_calls;
create policy calls_select_own on public.mcp_remote_calls
  for select to authenticated
  using (user_id = auth.uid());

-- 认领/写回都是一条 UPDATE；pending + timeout 条件由调用方 WHERE 保证 exactly-once，
-- 这里只保证不越权改别人的行。
drop policy if exists calls_update_own on public.mcp_remote_calls;
create policy calls_update_own on public.mcp_remote_calls
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ============================================================
-- 4. Realtime private broadcast 的 RLS（频道 user:{user_id}）
--    缺这段策略时客户端会报 CHANNEL_ERROR（已知风险 §11.3）
-- ============================================================
do $$
begin
  if exists (
    select 1 from pg_tables
    where schemaname = 'realtime' and tablename = 'messages'
  ) then
    execute 'alter table realtime.messages enable row level security';

    execute 'drop policy if exists messages_select_own_topic on realtime.messages';
    execute $p$
      create policy messages_select_own_topic on realtime.messages
        for select to authenticated
        using (topic = 'user:' || auth.uid()::text)
    $p$;

    execute 'drop policy if exists messages_insert_own_topic on realtime.messages';
    execute $p$
      create policy messages_insert_own_topic on realtime.messages
        for insert to authenticated
        with check (topic = 'user:' || auth.uid()::text)
    $p$;

    -- 授权要求该表在 supabase_realtime publication 中
    -- （realtime.messages 是分区表，pg_publication_tables 不一定列得出，
    --   所以用异常捕获兜底，重复执行不报错）
    begin
      execute 'alter publication supabase_realtime add table realtime.messages';
    exception
      when duplicate_object then null;
    end;
  end if;
end $$;

-- ============================================================
-- 5. 清扫函数（sweep）：由 Worker 的 cron 或 pg_cron 调用
--    - 过期 pending    -> failed(timeout)
--    - 终态 > 1 分钟   -> 删除
--    - 创建 > 1 小时    -> 兜底删除
--    - 设备失联        -> status=offline（有能力 15min / 无能力 45s）
-- ============================================================
create or replace function public.sweep_remote_calls()
returns void
language sql
security definer
set search_path = public
as $$
  -- 5.1 过期的 pending 标记为 failed
  update public.mcp_remote_calls
     set status = 'failed',
         error_message = 'timeout: device did not claim the call in time',
         completed_at = now()
   where status = 'pending'
     and timeout_at < now();

  -- 5.2 终态行 1 分钟后删除
  delete from public.mcp_remote_calls
   where status in ('completed', 'failed')
     and completed_at < now() - interval '1 minute';

  -- 5.3 1 小时兜底（任何状态）
  delete from public.mcp_remote_calls
   where created_at < now() - interval '1 hour';

  -- 5.4 设备失联下线
  update public.mcp_devices
     set status = 'offline'
   where status <> 'offline'
     and last_seen < now() - interval '15 minutes'
     and coalesce(capabilities ->> 'transport_broadcast_v1', 'false') = 'true';

  update public.mcp_devices
     set status = 'offline'
   where status <> 'offline'
     and last_seen < now() - interval '45 seconds'
     and coalesce(capabilities ->> 'transport_broadcast_v1', 'false') <> 'true';
$$;
