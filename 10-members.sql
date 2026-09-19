-- ============================================================
--  第 15 步：前台「游客注册 / 登录 + 推广邀请」
--  用法：Supabase 控制台 → SQL Editor → 新建查询 → 整段粘贴 → Run
--  网址：https://supabase.com/dashboard/project/tbrndvwxwvtvyjpsqnuj/sql/new
--
--  做完之后买家可以在前台用「用户名 + 密码」注册，注册页可以填邀请码；
--  每个会员自带一个邀请码，发出去拉人，双方按你在后台设的金额得奖励金。
-- ============================================================

-- 0) 密码哈希用 bcrypt（pgcrypto）。Supabase 默认装了，这句保证它在 extensions 里
create extension if not exists pgcrypto with schema extensions;

-- 1) 会员表
create table if not exists public.members (
  id           bigserial primary key,
  username     text    not null,                       -- 注册时填的样子
  uname        text    not null unique,                -- 小写去空格后的唯一键
  pass_hash    text    not null default '',            -- bcrypt 串，永不出库给浏览器
  invite_code  text    not null unique,                -- 自己的邀请码（6-16 位大写字母数字）
  ref_member   bigint  not null default 0,             -- 谁拉来的（会员 id）
  ref_agent    text    not null default '',            -- 归因到哪个推广员码
  balance_fen  bigint  not null default 0,             -- 奖励金（分）
  token        text    not null default '',            -- 登录态（等于一个随机串）
  token_exp    bigint  not null default 0,
  status       smallint not null default 1,            -- 1 正常 / 0 已禁用
  login_count  integer not null default 0,
  created_at   bigint  not null default 0,
  last_login   bigint  not null default 0
);
create index if not exists members_ref_idx on public.members (ref_member);

-- 2) 奖励流水（注册礼 / 邀请礼 / 后台手动发放）
create table if not exists public.member_rewards (
  id            bigserial primary key,
  member_id     bigint not null,
  kind          text   not null,                       -- signup / invite / bonus
  amount_fen    bigint not null default 0,
  from_member   bigint not null default 0,
  note          text   not null default '',
  created_at    bigint not null default 0
);
create index if not exists member_rewards_member_idx on public.member_rewards (member_id, id desc);

-- 3) 登录失败计数（防密码爆破：同一用户名 10 分钟内错 8 次就锁）
create table if not exists public.member_try (
  k        text    primary key,
  n        integer not null default 0,
  until_at bigint  not null default 0
);

-- 4) RLS：买家（匿名 key）一律读不到这三张表，只有下面的 RPC 能碰
alter table public.members         enable row level security;
alter table public.member_rewards  enable row level security;
alter table public.member_try      enable row level security;

drop policy if exists "admin_read_members"        on public.members;
drop policy if exists "admin_update_members"      on public.members;
drop policy if exists "admin_read_member_rewards" on public.member_rewards;
drop policy if exists "admin_read_member_try"     on public.member_try;
create policy "admin_read_members" on public.members
  for select to authenticated
  using (exists (select 1 from public.admin_users a where a.user_id = auth.uid()));
create policy "admin_update_members" on public.members
  for update to authenticated
  using     (exists (select 1 from public.admin_users a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admin_users a where a.user_id = auth.uid()));
drop policy if exists "admin_write_member_rewards" on public.member_rewards;
create policy "admin_write_member_rewards" on public.member_rewards
  for insert to authenticated
  with check (exists (select 1 from public.admin_users a where a.user_id = auth.uid()));
create policy "admin_read_member_rewards" on public.member_rewards
  for select to authenticated
  using (exists (select 1 from public.admin_users a where a.user_id = auth.uid()));
create policy "admin_read_member_try" on public.member_try
  for select to authenticated
  using (exists (select 1 from public.admin_users a where a.user_id = auth.uid()));

-- 5) 内部小工具：造一个没被占用的邀请码 / 造一个会话 token
create or replace function public.member_new_code() returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_alpha text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   -- 去掉易混的 I O 0 1
  v_s     text := '';
  v_i     integer;
  v_try   integer := 0;
begin
  loop
    v_s := '';
    for v_i in 1..8 loop
      v_s := v_s || substr(v_alpha, 1 + floor(random() * length(v_alpha))::integer, 1);
    end loop;
    if not exists (select 1 from public.members where invite_code = v_s) then return v_s; end if;
    v_try := v_try + 1;
    if v_try > 20 then raise exception 'CODE_BUSY'; end if;
  end loop;
end $$;

create or replace function public.member_new_token() returns text
language sql security definer set search_path = public, pg_temp as $$
  select replace(md5(random()::text || clock_timestamp()::text || random()::text), '-', '')
      || replace(md5(clock_timestamp()::text || random()::text), '-', '');
$$;

-- 6) 注册
create or replace function public.rpc_signup(p_user text, p_pass text, p_ref text default '')
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now   bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_ttl   bigint := 30 * 24 * 60 * 60 * 1000;
  v_user  text := btrim(coalesce(p_user, ''));
  v_uname text := lower(btrim(coalesce(p_user, '')));
  v_pass  text := coalesce(p_pass, '');
  v_ref   text := upper(btrim(coalesce(p_ref, '')));
  v_set   jsonb;
  v_signup bigint := 0;
  v_invite bigint := 0;
  v_ref_id bigint := 0;
  v_agent  text := '';
  v_code   text;
  v_token  text;
  v_today  bigint;
begin
  v_set := coalesce((select data from public.settings where id = 'site' limit 1), '{}'::jsonb);
  if coalesce((v_set ->> 'member_open')::boolean, true) is not true then
    raise exception 'SIGNUP_CLOSED';
  end if;

  if v_uname !~ '^[a-z0-9_.\-]{4,20}$' then raise exception 'BAD_USER'; end if;
  if char_length(v_pass) < 6 or char_length(v_pass) > 64 then raise exception 'BAD_PASS'; end if;
  if v_uname = lower(v_pass) then raise exception 'BAD_PASS'; end if;
  if exists (select 1 from public.members where uname = v_uname) then raise exception 'USER_TAKEN'; end if;

  -- 没人验证码，先挂一道粗闸门：一天最多注册 500 个，防刷子把表灌爆
  v_today := v_now - 24 * 60 * 60 * 1000;
  if (select count(*) from public.members where created_at > v_today) >= 500 then
    raise exception 'SIGNUP_BUSY';
  end if;

  -- 邀请码：先当「会员邀请码」认，认不到再当「推广员码」认；都不对就当没填
  if v_ref ~ '^[A-Z0-9]{6,16}$' then
    select id into v_ref_id from public.members where invite_code = v_ref and status = 1;
    if v_ref_id is null then
      v_ref_id := 0;
      if exists (select 1 from public.agents where code = v_ref and status = 1) then v_agent := v_ref; end if;
    end if;
  end if;

  v_code  := public.member_new_code();
  v_token := public.member_new_token();
  v_signup := greatest(0, least(1000000, coalesce((v_set ->> 'signup_bonus_fen')::bigint, 0)));
  v_invite := greatest(0, least(1000000, coalesce((v_set ->> 'invite_bonus_fen')::bigint, 0)));

  insert into public.members (username, uname, pass_hash, invite_code, ref_member, ref_agent,
                              balance_fen, token, token_exp, created_at, last_login, login_count)
  values (v_user, v_uname, extensions.crypt(v_pass, extensions.gen_salt('bf')), v_code,
          case when v_ref_id > 0 then v_ref_id else 0 end, v_agent, v_signup,
          v_token, v_now + v_ttl, v_now, v_now, 1);

  if v_signup > 0 then
    insert into public.member_rewards (member_id, kind, amount_fen, from_member, note, created_at)
    values ((select id from public.members where uname = v_uname), 'signup', v_signup, 0, '新用户注册礼', v_now);
  end if;
  if v_ref_id > 0 then
    if v_invite > 0 then
      update public.members set balance_fen = balance_fen + v_invite where id = v_ref_id;
      insert into public.member_rewards (member_id, kind, amount_fen, from_member, note, created_at)
      values (v_ref_id, 'invite', v_invite, (select id from public.members where uname = v_uname),
              '邀请 ' || left(v_user, 1) || '*** 注册', v_now);
    end if;
  end if;

  return public.rpc_me(v_token);
end $$;

-- 7) 登录
create or replace function public.rpc_login(p_user text, p_pass text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now   bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_ttl   bigint := 30 * 24 * 60 * 60 * 1000;
  v_uname text := lower(btrim(coalesce(p_user, '')));
  v_m     public.members%ROWTYPE;
  v_t     public.member_try%ROWTYPE;
  v_token text;
begin
  select * into v_t from public.member_try where k = v_uname;
  if found and v_t.n >= 8 and v_t.until_at > v_now then raise exception 'TOO_MANY_TRIES'; end if;

  select * into v_m from public.members where uname = v_uname;
  if not found
     or v_m.status <> 1
     or extensions.crypt(coalesce(p_pass, ''), v_m.pass_hash) <> v_m.pass_hash then
    insert into public.member_try (k, n, until_at) values (v_uname, 1, v_now + 10 * 60 * 1000)
      on conflict (k) do update
        set n = case when public.member_try.until_at < v_now then 1 else public.member_try.n + 1 end,
            until_at = excluded.until_at;
    raise exception 'BAD_LOGIN';                       -- 统一文案，不告诉对方是用户名错还是密码错
  end if;

  delete from public.member_try where k = v_uname;
  v_token := public.member_new_token();
  update public.members
     set token = v_token, token_exp = v_now + v_ttl,
         last_login = v_now, login_count = login_count + 1
   where id = v_m.id;
  return public.rpc_me(v_token);
end $$;

-- 8) 会话：前台每次打开页面拿一次「我是谁 + 我的推广」
create or replace function public.rpc_me(p_token text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_m   public.members%ROWTYPE;
  v_ref text := btrim(coalesce(p_token, ''));
begin
  if v_ref = '' or length(v_ref) < 32 then return jsonb_build_object('ok', false, 'signed_in', false); end if;
  select * into v_m from public.members where token = v_ref and token_exp > v_now and status = 1;
  if not found then return jsonb_build_object('ok', false, 'signed_in', false); end if;
  return jsonb_build_object(
    'ok', true, 'signed_in', true, 'token', v_ref,
    'id', v_m.id,
    'username', v_m.username,
    'invite_code', v_m.invite_code,
    'balance_fen', v_m.balance_fen,
    'ref_count', (select count(*) from public.members where ref_member = v_m.id),
    'order_count', 0,
    'created_at', v_m.created_at,
    'invited', (select coalesce(jsonb_agg(jsonb_build_object(
                     'name', left(m2.username, 1) || '***', 'at', m2.created_at)
                     order by m2.id desc), '[]'::jsonb)
                  from (select username, created_at, id from public.members
                         where ref_member = v_m.id order by id desc limit 10) m2),
    'rewards', (select coalesce(jsonb_agg(jsonb_build_object(
                     'kind', r.kind, 'amount', r.amount_fen, 'note', r.note, 'at', r.created_at)
                     order by r.id desc), '[]'::jsonb)
                  from (select kind, amount_fen, note, created_at from public.member_rewards
                         where member_id = v_m.id order by id desc limit 10) r)
  );
end $$;

-- 9) 退出登录（清掉 token）
create or replace function public.rpc_logout(p_token text)
returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  update public.members set token = '', token_exp = 0
   where token = btrim(coalesce(p_token, ''))
  returning jsonb_build_object('ok', true);
$$;

-- 10) 改密码（改完重新发一个 token，旧设备自动掉线）
create or replace function public.rpc_change_pass(p_token text, p_old text, p_new text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now   bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_ttl   bigint := 30 * 24 * 60 * 60 * 1000;
  v_m     public.members%ROWTYPE;
  v_token text;
begin
  select * into v_m from public.members where token = btrim(coalesce(p_token, '')) and token_exp > v_now;
  if not found then raise exception 'BAD_TOKEN'; end if;
  if extensions.crypt(coalesce(p_old, ''), v_m.pass_hash) <> v_m.pass_hash then raise exception 'BAD_OLD_PASS'; end if;
  if char_length(coalesce(p_new, '')) < 6 or char_length(coalesce(p_new, '')) > 64 then raise exception 'BAD_PASS'; end if;
  v_token := public.member_new_token();
  update public.members
     set pass_hash = extensions.crypt(p_new, extensions.gen_salt('bf')),
         token = v_token, token_exp = v_now + v_ttl
   where id = v_m.id;
  return jsonb_build_object('ok', true, 'changed', true, 'token', v_token);
end $$;

-- 11) 权限：注册/登录/会话是「游客」也要用的，所以授给 anon + authenticated；
--     内部工具函数不给任何人直接调。
revoke all on function public.rpc_signup(text, text, text) from public;
revoke all on function public.rpc_login(text, text) from public;
revoke all on function public.rpc_me(text) from public;
revoke all on function public.rpc_logout(text) from public;
revoke all on function public.rpc_change_pass(text, text, text) from public;
revoke all on function public.member_new_code()  from public;
revoke all on function public.member_new_token() from public;
revoke all on function public.member_new_code()  from anon;
revoke all on function public.member_new_code()  from authenticated;
revoke all on function public.member_new_token() from anon;
revoke all on function public.member_new_token() from authenticated;

grant  execute on function public.rpc_signup(text, text, text) to anon, authenticated;
grant  execute on function public.rpc_login(text, text)        to anon, authenticated;
grant  execute on function public.rpc_me(text)                 to anon, authenticated;
grant  execute on function public.rpc_logout(text)             to anon, authenticated;
grant  execute on function public.rpc_change_pass(text, text, text) to anon, authenticated;

-- 11b) 前台用：注册是否开放 + 奖励金额（只给这三个数，不泄露别的设置）
create or replace function public.rpc_member_flags() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'ok', true,
    'member_open', coalesce((s.d ->> 'member_open')::boolean, true),
    'signup_bonus_fen', coalesce((s.d ->> 'signup_bonus_fen')::bigint, 0),
    'invite_bonus_fen', coalesce((s.d ->> 'invite_bonus_fen')::bigint, 0))
  from (select coalesce(data, '{}'::jsonb) as d from public.settings where id = 'site' limit 1) s;
$$;
revoke all on function public.rpc_member_flags() from public;
grant execute on function public.rpc_member_flags() to anon, authenticated;

-- 12) 后台可调的三个开关/金额，先塞默认值（在「系统设置」里改）
update public.settings
   set data = coalesce(data, '{}'::jsonb) || jsonb_build_object(
         'member_open', coalesce((data ->> 'member_open')::boolean, true),
         'signup_bonus_fen', coalesce((data ->> 'signup_bonus_fen')::bigint, 0),
         'invite_bonus_fen', coalesce((data ->> 'invite_bonus_fen')::bigint, 0))
 where id = 'site';

-- 13) 体检：应显示 5 行「已创建 ✓」
select '会员表' as 项目, case when exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'members') then '已创建 ✓' else '没建上 ✗' end as 结果
union all
select '注册函数', case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'rpc_signup') then '已创建 ✓' else '没建上 ✗' end
union all
select '登录函数', case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'rpc_login') then '已创建 ✓' else '没建上 ✗' end
union all
select '会员开关函数', case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'rpc_member_flags') then '已创建 ✓' else '没建上 ✗' end
union all
select 'bcrypt可用', case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'extensions' and p.proname = 'crypt') then '已就绪 ✓' else '没装 ✗（跑第 0 步那句 create extension）' end;
