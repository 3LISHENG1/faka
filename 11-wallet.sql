-- ============================================================
--  第 18 步：钱包（先充值，再用余额买东西）
--  前提：已执行 10-members.sql（有 members 表）
--  用法：Supabase 控制台 → SQL Editor → 新建查询 → 整段粘贴 → Run
--  网址：https://supabase.com/dashboard/project/tbrndvwxwvtvyjpsqnuj/sql/new
--
--  做完之后：
--    1) 买家注册 → 充值（现阶段走「人工入账」：他转账给你，你在后台点确认）
--    2) 下单后在支付弹窗里点「用余额支付」，秒发货
--    3) 以后接了支付宝，只要把「充值渠道」改成 alipay，前台自动变成扫码/跳转
-- ============================================================

-- 0) 前置检查：没有 members 表就别往下跑（先执行 10-members.sql）
do $$
begin
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'members') then
    raise exception 'PRECHECK: 请先执行 10-members.sql（还没有 members 表）';
  end if;
end $$;

-- 1) 订单表加一列：这笔单是谁（会员）买的，方便退款和对账
alter table public.orders add column if not exists member_id bigint not null default 0;

-- 2) 充值单（一笔待入账的充值）
create table if not exists public.recharge_orders (
  out_trade_no  text    primary key,                   -- 我方订单号 RC+日期+随机
  member_id     bigint  not null,
  amount_fen    bigint  not null,
  channel       text    not null default 'manual',     -- manual 人工 / alipay 支付宝
  status        text    not null default 'pending',    -- pending 待入账 / paid 已入账 / closed 已关闭
  trade_no      text    not null default '',           -- 对方（支付宝）流水号
  note          text    not null default '',
  created_at    bigint  not null default 0,
  paid_at       bigint  not null default 0
);
create index if not exists recharge_orders_member_idx on public.recharge_orders (member_id, out_trade_no desc);
create index if not exists recharge_orders_pending_idx on public.recharge_orders (status, created_at desc);

-- 3) 钱包流水（充值 / 消费 / 退款 / 后台调整）
create table if not exists public.wallet_tx (
  id            bigserial primary key,
  member_id     bigint  not null,
  kind          text    not null,                      -- recharge / consume / refund / admin
  amount_fen    bigint  not null,                      -- 正数进账，负数出账
  balance_after bigint  not null default 0,
  ref           text    not null default '',           -- 关联单号（充值单号 / 订单号）
  note          text    not null default '',
  created_at    bigint  not null default 0
);
create index if not exists wallet_tx_member_idx on public.wallet_tx (member_id, id desc);
create index if not exists wallet_tx_ref_idx on public.wallet_tx (ref);

-- 4) RLS：买家一律读不到，只能走下面的 RPC；后台（admin_users）只读
alter table public.recharge_orders enable row level security;
alter table public.wallet_tx       enable row level security;

drop policy if exists "admin_read_recharge_orders" on public.recharge_orders;
drop policy if exists "admin_read_wallet_tx"       on public.wallet_tx;
create policy "admin_read_recharge_orders" on public.recharge_orders
  for select to authenticated
  using (exists (select 1 from public.admin_users a where a.user_id = auth.uid()));
create policy "admin_read_wallet_tx" on public.wallet_tx
  for select to authenticated
  using (exists (select 1 from public.admin_users a where a.user_id = auth.uid()));

-- 5) 内部工具：改余额 + 记流水（一步到位，绝不给前台直接调）
create or replace function public.wallet_credit(
  p_member_id bigint, p_kind text, p_amount_fen bigint, p_ref text, p_note text)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now  bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_left bigint := 0;
begin
  if p_amount_fen = 0 then return (select balance_fen from public.members where id = p_member_id); end if;
  if p_amount_fen > 0 then
    update public.members set balance_fen = balance_fen + p_amount_fen
     where id = p_member_id
     returning balance_fen into v_left;
  else
    -- 扣款带条件：余额不够就一行都更新不到，天然防并发超扣
    update public.members set balance_fen = balance_fen + p_amount_fen
     where id = p_member_id and balance_fen >= -p_amount_fen
     returning balance_fen into v_left;
    if v_left is null then raise exception 'LOW_BALANCE'; end if;
  end if;
  insert into public.wallet_tx (member_id, kind, amount_fen, balance_after, ref, note, created_at)
  values (p_member_id, p_kind, p_amount_fen, v_left, coalesce(p_ref, ''), coalesce(p_note, ''), v_now);
  return v_left;
end $$;

-- 内部工具：认会员（token 有效才算）
create or replace function public.wallet_member(p_token text)
returns public.members
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v public.members%rowtype;
begin
  select * into v from public.members
   where token = coalesce(p_token, '') and token_exp > (extract(epoch from clock_timestamp()) * 1000)::bigint
     and status = 1;
  return v;   -- 找不到就是一行 NULL，调用方判 id is null
end $$;

-- 内部工具：充值单入账（幂等：同一单号第二次调用不会再给钱）
create or replace function public.recharge_pay(p_out_trade_no text, p_trade_no text, p_check_fen bigint)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_r   public.recharge_orders%rowtype;
  v_mem bigint; v_amt bigint;
  v_bal bigint := 0;
begin
  update public.recharge_orders
     set status = 'paid', trade_no = coalesce(p_trade_no, ''), paid_at = v_now
   where out_trade_no = p_out_trade_no and status = 'pending'
   returning member_id, amount_fen into v_mem, v_amt;
  if not found then
    select * into v_r from public.recharge_orders where out_trade_no = p_out_trade_no;
    if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
    -- 已经是 paid / closed：幂等返回，不重复给钱
    return jsonb_build_object('ok', true, 'credited', false, 'status', v_r.status,
                              'amount_fen', v_r.amount_fen);
  end if;
  if p_check_fen is not null and p_check_fen > 0 and p_check_fen <> v_amt then
    -- 金额对不上：退回待入账状态，等人工核查，绝不入账
    update public.recharge_orders
       set status = 'pending', paid_at = 0,
           note = '金额不符：到账 ' || p_check_fen || ' / 应到 ' || v_amt
     where out_trade_no = p_out_trade_no;
    return jsonb_build_object('ok', false, 'error', 'AMOUNT_MISMATCH');
  end if;
  v_bal := public.wallet_credit(v_mem, 'recharge', v_amt, p_out_trade_no, '充值到账');
  return jsonb_build_object('ok', true, 'credited', true, 'amount_fen', v_amt,
                            'balance_fen', v_bal, 'member_id', v_mem);
end $$;

-- 6) 前台：钱包（余额 + 最近流水，把注册礼/邀请礼也并进来一起显示）
create or replace function public.rpc_wallet_info(p_token text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_m public.members%rowtype;
begin
  v_m := public.wallet_member(p_token);
  if v_m.id is null then return jsonb_build_object('ok', false, 'error', 'BAD_TOKEN'); end if;
  return jsonb_build_object(
    'ok', true,
    'balance_fen', v_m.balance_fen,
    'recharged_fen', coalesce((select sum(amount_fen) from public.wallet_tx
                                where member_id = v_m.id and kind = 'recharge'), 0),
    'spent_fen', coalesce((select -sum(amount_fen) from public.wallet_tx
                            where member_id = v_m.id and kind = 'consume'), 0),
    'tx', coalesce((select jsonb_agg(jsonb_build_object(
                       'kind', k, 'amount', a, 'balance', b, 'ref', r, 'note', n, 'at', c) order by x desc)
                    from (
                      select 'bonus' as k, amount_fen as a, 0 as b, '' as r, note as n, created_at as c,
                             10000000000000 + id as x
                        from public.member_rewards where member_id = v_m.id
                      union all
                      select kind, amount_fen, balance_after, ref, note, created_at, id
                        from public.wallet_tx where member_id = v_m.id
                      order by x desc limit 40
                    ) y), '[]'::jsonb)
  );
end $$;

-- 7) 前台：发起一笔充值（返回去支付宝需要的单号；渠道没配就只是挂一单等人工入账）
create or replace function public.rpc_recharge_start(p_token text, p_amount_fen bigint)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now   bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_set   jsonb := coalesce((select data from public.settings where id = 'site' limit 1), '{}'::jsonb);
  v_min   bigint := greatest(100, coalesce((v_set ->> 'recharge_min_fen')::bigint, 100));
  v_max   bigint := least(100000000, coalesce((v_set ->> 'recharge_max_fen')::bigint, 5000000));
  v_chan  text := lower(btrim(coalesce(v_set ->> 'recharge_channel', 'manual')));
  v_m     public.members%rowtype;
  v_no    text;
begin
  v_m := public.wallet_member(p_token);
  if v_m.id is null then return jsonb_build_object('ok', false, 'error', 'BAD_TOKEN'); end if;
  if v_chan not in ('manual', 'alipay') then v_chan := 'manual'; end if;
  if p_amount_fen is null or p_amount_fen < v_min or p_amount_fen > v_max then
    return jsonb_build_object('ok', false, 'error', 'BAD_AMOUNT', 'min_fen', v_min, 'max_fen', v_max);
  end if;
  -- 挂单太多就先关掉，免得后台堆一堆垃圾单
  if (select count(*) from public.recharge_orders
       where member_id = v_m.id and status = 'pending') >= 5 then
    return jsonb_build_object('ok', false, 'error', 'TOO_MANY_PENDING');
  end if;
  v_no := 'RC' || to_char(now() at time zone 'UTC', 'YYYYMMDD')
          || upper(encode(extensions.gen_random_bytes(6), 'hex'));
  insert into public.recharge_orders (out_trade_no, member_id, amount_fen, channel, status, created_at)
  values (v_no, v_m.id, p_amount_fen, v_chan, 'pending', v_now);
  return jsonb_build_object('ok', true, 'out_trade_no', v_no, 'amount_fen', p_amount_fen,
                            'channel', v_chan, 'created_at', v_now);
end $$;

-- 8) 前台：查这笔充值到没到账（支付宝回调 / 后台点确认之后，这里就会变 paid）
create or replace function public.rpc_recharge_status(p_token text, p_out_trade_no text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_m public.members%rowtype;
  v_r public.recharge_orders%rowtype;
begin
  v_m := public.wallet_member(p_token);
  if v_m.id is null then return jsonb_build_object('ok', false, 'error', 'BAD_TOKEN'); end if;
  select * into v_r from public.recharge_orders
   where out_trade_no = btrim(coalesce(p_out_trade_no, '')) and member_id = v_m.id;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  return jsonb_build_object('ok', true, 'out_trade_no', v_r.out_trade_no, 'status', v_r.status,
                            'amount_fen', v_r.amount_fen, 'channel', v_r.channel,
                            'paid_at', v_r.paid_at, 'balance_fen', v_m.balance_fen);
end $$;

-- 9) 前台核心：用余额付款（付完直接变成已支付，交给原来的发货流程）
create or replace function public.rpc_pay_order_by_balance(p_token text, p_order_id text, p_email text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now  bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_m    public.members%rowtype;
  v_o    public.orders%rowtype;
  v_need bigint;
  v_bal  bigint := 0;
  v_res  jsonb;
begin
  v_m := public.wallet_member(p_token);
  if v_m.id is null then return jsonb_build_object('ok', false, 'error', 'BAD_TOKEN'); end if;

  select * into v_o from public.orders where order_id = btrim(coalesce(p_order_id, ''));
  if not found then return jsonb_build_object('ok', false, 'error', 'ORDER_NOT_FOUND'); end if;
  if lower(btrim(coalesce(p_email, ''))) <> lower(v_o.email) then
    -- 必须和下单时填的邮箱一致，避免拿别人的单号扣自己的钱 / 撞库
    return jsonb_build_object('ok', false, 'error', 'ORDER_EMAIL');
  end if;

  if v_o.status = 'paid' then   -- 已经付过了：不再扣钱，直接把结果给前台
    begin
      v_res := public.rpc_order_lookup(p_order_id => v_o.order_id, p_email => v_o.email);
    exception when others then
      v_res := null;
    end;
    return coalesce(v_res, '{}'::jsonb) || jsonb_build_object('ok', true, 'already', true,
             'order_id', v_o.order_id, 'status', 'paid',
             'balance_fen', v_m.balance_fen);
  end if;
  if v_o.status <> 'pending' then return jsonb_build_object('ok', false, 'error', 'ORDER_CLOSED'); end if;
  if v_o.lock_expires_at > 0 and v_o.lock_expires_at < v_now then
    return jsonb_build_object('ok', false, 'error', 'ORDER_EXPIRED');
  end if;
  if coalesce((select data ->> 'balance_pay_open' from public.settings where id = 'site'), 'true') <> 'true' then
    return jsonb_build_object('ok', false, 'error', 'PAY_CLOSED');
  end if;

  v_need := greatest(0, coalesce(v_o.amount, 0)::bigint);
  if v_need <= 0 then return jsonb_build_object('ok', false, 'error', 'BAD_AMOUNT'); end if;
  if v_m.balance_fen < v_need then
    return jsonb_build_object('ok', false, 'error', 'LOW_BALANCE',
                              'need_fen', v_need, 'balance_fen', v_m.balance_fen);
  end if;

  -- 先扣钱（条件更新，余额不足会抛 LOW_BALANCE 并整笔回滚），再把订单置为已支付
  v_bal := public.wallet_credit(v_m.id, 'consume', -v_need, v_o.order_id,
                                '余额购买 ' || coalesce(v_o.goods_name, ''));
  update public.orders
     set status = 'paid', paid_at = v_now, member_id = v_m.id, lock_expires_at = 0
   where order_id = v_o.order_id and status = 'pending';
  if not found then
    -- 订单在同时被别人关掉/付款了：把钱退回，绝不白扣
    perform public.wallet_credit(v_m.id, 'refund', v_need, v_o.order_id, '订单状态变化自动退款');
    return jsonb_build_object('ok', false, 'error', 'ORDER_CLOSED', 'refunded', true);
  end if;

  -- 查单只是把卡密带回去给前台显示，失败不影响已经扣的款（前台会继续轮询）
  begin
    v_res := public.rpc_order_lookup(p_order_id => v_o.order_id, p_email => v_o.email);
  exception when others then
    v_res := null;
  end;
  if v_res is null then
    v_res := jsonb_build_object('found', true, 'order_id', v_o.order_id,
              'goods_name', coalesce(v_o.goods_name, ''), 'qty', v_o.qty,
              'amount', v_need, 'status', 'paid',
              'cards', coalesce(to_jsonb(v_o.cards), '[]'::jsonb));
  end if;
  return v_res || jsonb_build_object('ok', true, 'paid', true,
           'order_id', v_o.order_id, 'balance_fen', v_bal);
end $$;

-- 10) 前台用：充值/余额支付相关的开关和额度（只给这几个数，不泄露别的设置）
create or replace function public.rpc_wallet_flags() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'ok', true,
    'balance_pay_open', coalesce((s.d ->> 'balance_pay_open')::boolean, true),
    'recharge_channel', coalesce(nullif(s.d ->> 'recharge_channel', ''), 'manual'),
    'recharge_min_fen', greatest(100, coalesce((s.d ->> 'recharge_min_fen')::bigint, 100)),
    'recharge_max_fen', least(100000000, coalesce((s.d ->> 'recharge_max_fen')::bigint, 5000000)),
    'recharge_presets', coalesce(s.d -> 'recharge_presets', '[1000,3000,5000,10000,30000,50000]'::jsonb),
    'recharge_notice', coalesce(s.d ->> 'recharge_notice', ''))
  from (select coalesce(data, '{}'::jsonb) as d from public.settings where id = 'site' limit 1) s;
$$;

-- 11) 后台：把一笔待入账充值确认到账（人工转账就用这个）
create or replace function public.rpc_recharge_confirm(p_out_trade_no text, p_note text default '')
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_r   public.recharge_orders%rowtype;
  v_res jsonb;
begin
  if not exists (select 1 from public.admin_users a where a.user_id = auth.uid()) then
    raise exception 'ADMIN_ONLY';
  end if;
  select * into v_r from public.recharge_orders where out_trade_no = btrim(coalesce(p_out_trade_no, ''));
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  v_res := public.recharge_pay(v_r.out_trade_no, 'manual-' || to_char(now() at time zone 'UTC', 'YYYYMMDDHH24MISS'), 0);
  if v_res ->> 'credited' = 'true' then
    update public.recharge_orders set note = left(coalesce(p_note, ''), 120) where out_trade_no = v_r.out_trade_no;
  end if;
  return v_res;
end $$;

-- 12) 后台：关掉一笔不打算付的充值单
create or replace function public.rpc_recharge_close(p_out_trade_no text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n integer := 0;
begin
  if not exists (select 1 from public.admin_users a where a.user_id = auth.uid()) then
    raise exception 'ADMIN_ONLY';
  end if;
  update public.recharge_orders set status = 'closed'
   where out_trade_no = btrim(coalesce(p_out_trade_no, '')) and status = 'pending';
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'closed', v_n);
end $$;

-- 13) 后台：手动给某个会员加/减余额（补偿、退款、送体验金都靠它）
create or replace function public.rpc_wallet_adjust(p_member_id bigint, p_delta_fen bigint, p_note text default '')
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bal bigint;
begin
  if not exists (select 1 from public.admin_users a where a.user_id = auth.uid()) then
    raise exception 'ADMIN_ONLY';
  end if;
  if p_member_id is null or p_delta_fen is null or p_delta_fen = 0 then
    return jsonb_build_object('ok', false, 'error', 'BAD_ARG');
  end if;
  if abs(p_delta_fen) > 100000000 then return jsonb_build_object('ok', false, 'error', 'BAD_ARG'); end if;
  if not exists (select 1 from public.members where id = p_member_id) then
    return jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  end if;
  begin
    v_bal := public.wallet_credit(p_member_id, 'admin', p_delta_fen, '',
              left(nullif(btrim(coalesce(p_note, '')), ''), 80) || case when p_delta_fen > 0 then '' else '（扣减）' end);
  exception when sqlstate 'P0001' then
    if p_delta_fen < 0 then return jsonb_build_object('ok', false, 'error', 'LOW_BALANCE'); end if;
    raise;
  end;
  return jsonb_build_object('ok', true, 'balance_fen', v_bal);
end $$;

-- 14) 供支付宝回调使用：只授给 service_role（Edge Function 里的服务端密钥才调得动）
revoke all on function public.wallet_credit(bigint, text, bigint, text, text) from public;
revoke all on function public.wallet_member(text)                                 from public;
revoke all on function public.recharge_pay(text, text, bigint)                    from public;
revoke all on function public.wallet_credit(bigint, text, bigint, text, text) from anon, authenticated;
revoke all on function public.wallet_member(text)                             from anon, authenticated;
revoke all on function public.recharge_pay(text, text, bigint)                from anon, authenticated;
revoke all on function public.rpc_wallet_info(text)                           from public;
revoke all on function public.rpc_recharge_start(text, bigint)                from public;
revoke all on function public.rpc_recharge_status(text, text)                 from public;
revoke all on function public.rpc_pay_order_by_balance(text, text, text)      from public;
revoke all on function public.rpc_wallet_flags()                              from public;
revoke all on function public.rpc_recharge_confirm(text, text)                from public;
revoke all on function public.rpc_recharge_close(text)                        from public;
revoke all on function public.rpc_wallet_adjust(bigint, bigint, text)         from public;
revoke all on function public.recharge_pay(text, text, bigint)                from service_role;

grant  execute on function public.rpc_wallet_info(text)                        to anon, authenticated;
grant  execute on function public.rpc_recharge_start(text, bigint)             to anon, authenticated;
grant  execute on function public.rpc_recharge_status(text, text)              to anon, authenticated;
grant  execute on function public.rpc_pay_order_by_balance(text, text, text)   to anon, authenticated;
grant  execute on function public.rpc_wallet_flags()                           to anon, authenticated;
grant  execute on function public.rpc_recharge_confirm(text, text)             to authenticated;
grant  execute on function public.rpc_recharge_close(text)                     to authenticated;
grant  execute on function public.rpc_wallet_adjust(bigint, bigint, text)      to authenticated;
grant  execute on function public.recharge_pay(text, text, bigint)             to service_role;
grant  execute on function public.wallet_credit(bigint, text, bigint, text, text) to service_role;

-- 15) 错误码风格与 10-members.sql 一致：BAD_TOKEN / LOW_BALANCE / ORDER_CLOSED 等
-- 16) 默认设置（在后台「系统设置 → 钱包/充值」里改）
update public.settings
   set data = coalesce(data, '{}'::jsonb) || jsonb_build_object(
         'balance_pay_open', coalesce((data ->> 'balance_pay_open')::boolean, true),
         'recharge_channel', coalesce(nullif(data ->> 'recharge_channel', ''), 'manual'),
         'recharge_min_fen', coalesce((data ->> 'recharge_min_fen')::bigint, 100),
         'recharge_max_fen', coalesce((data ->> 'recharge_max_fen')::bigint, 5000000),
         'recharge_presets', coalesce(data -> 'recharge_presets', '[1000,3000,5000,10000,30000,50000]'::jsonb),
         'recharge_notice', coalesce(data ->> 'recharge_notice', ''))
 where id = 'site';

-- 17) 体检：应显示 6 行「已创建 ✓」
select '充值单表' as 项目, case when exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'recharge_orders') then '已创建 ✓' else '没建上 ✗' end as 结果
union all
select '钱包流水表', case when exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'wallet_tx') then '已创建 ✓' else '没建上 ✗' end
union all
select '余额支付函数', case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'rpc_pay_order_by_balance') then '已创建 ✓' else '没建上 ✗' end
union all
select '充值函数', case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'rpc_recharge_start') then '已创建 ✓' else '没建上 ✗' end
union all
select '钱包开关函数', case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'rpc_wallet_flags') then '已创建 ✓' else '没建上 ✗' end
union all
select '订单表 member_id 列', case when exists (select 1 from pg_attribute where attrelid = 'public.orders'::regclass
        and attname = 'member_id') then '已加上 ✓' else '没加上 ✗' end;
