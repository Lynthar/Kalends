-- 字段注册表补全：让"库有哪些列、什么类型、值在哪、默认是否上表"成为数据而不是代码。
-- 前端的 COLS / thead / 详情表单在切片 B2 里都改由这张表生成。
--
-- src  = 值存在哪：col（items 的真列）/ extra（items.extra JSON）/ calc（服务端算出，只读）
-- shown = 默认是否作为表格列出现（0 = 只在详情表单里出现）；用户仍可用视图偏好自行隐藏/恢复
-- config = 类型专属配置的 JSON，目前只有 tpl 类型用它的 {"tpl": "..."}
--
-- 本次注册的字段一律 builtin=1：旧前端把 builtin=0 的当自定义列，置 1 可保证部署后界面不变。

ALTER TABLE fields ADD COLUMN src TEXT NOT NULL DEFAULT 'extra';
ALTER TABLE fields ADD COLUMN shown INTEGER NOT NULL DEFAULT 1;
ALTER TABLE fields ADD COLUMN config TEXT;

-- 已有的自定义列（键 c<id>）值本就在 extra 里，src 默认值正确；显式确认一次
UPDATE fields SET src = 'extra' WHERE builtin = 0;

-- 三个预置库的列。pos 依当前表头顺序排，shown=0 的排在可见列之后。
-- options 一律不动（订阅分类那份带颜色的词表要保住），所以 ON CONFLICT 只更新结构性字段。
INSERT INTO fields(tbl, key, name, ftype, src, shown, pos, builtin, options, config) VALUES
  -- 订阅
  ('subs', 'name',           '名称',     'text',   'col',   1,  1, 1, '[]', NULL),
  ('subs', 'status',         '状态',     'status', 'col',   1,  2, 1, '[]', NULL),
  ('subs', 'category',       '分类',     'sel',    'extra', 1,  3, 1, '[]', NULL),
  ('subs', 'price',          '价格',     'num',    'col',   1,  4, 1, '[]', NULL),
  ('subs', 'currency',       '币种',     'sel',    'col',   1,  5, 1, '[]', NULL),
  ('subs', 'cycle',          '周期',     'sel',    'col',   1,  6, 1, '[]', NULL),
  ('subs', 'next_renewal',   '下次续费', 'date',   'col',   1,  7, 1, '[]', NULL),
  ('subs', 'payment_method', '支付方式', 'sel',    'extra', 1,  8, 1, '[]', NULL),
  ('subs', 'notes',          '备注',     'text',   'col',   1,  9, 1, '[]', NULL),
  ('subs', 'cycle_days',     '周期天数', 'num',    'col',   0, 20, 1, '[]', NULL),
  ('subs', 'account',        '账号',     'text',   'extra', 0, 21, 1, '[]', NULL),
  ('subs', 'url',            '链接',     'text',   'col',   0, 22, 1, '[]', NULL),

  -- SIM 卡
  ('sims', 'name',             '名称',     'text',   'col',   1,  1, 1, '[]', NULL),
  ('sims', 'forms',            '形式',     'multi',  'extra', 1,  2, 1, '[]', NULL),
  ('sims', 'status',           '状态',     'status', 'col',   1,  3, 1, '[]', NULL),
  ('sims', 'last_renewed',     '上次续费', 'date',   'col',   1,  4, 1, '[]', NULL),
  ('sims', 'left',             '剩余天数', 'num',    'calc',  1,  5, 1, '[]', NULL),
  ('sims', 'keepalive_action', '保号动作', 'text',   'extra', 1,  6, 1, '[]', NULL),
  ('sims', 'cycle_days',       '周期天数', 'num',    'col',   0, 20, 1, '[]', NULL),
  ('sims', 'phone_number',     '号码',     'text',   'extra', 0, 21, 1, '[]', NULL),
  ('sims', 'notes',            '备注',     'text',   'col',   0, 22, 1, '[]', NULL),

  -- VPS：名称即商家，产品名走库的 subtitle
  ('vps', 'name',          '商家',     'text',   'col',   1,  1, 1, '[]', NULL),
  ('vps', 'status',        '状态',     'status', 'col',   1,  2, 1, '[]', NULL),
  ('vps', 'locations',     '地点',     'multi',  'extra', 1,  3, 1, '[]', NULL),
  ('vps', 'purpose',       '用途',     'sel',    'extra', 1,  4, 1, '[]', NULL),
  ('vps', 'spec',          '规格',     'tpl',    'calc',  1,  5, 1, '[]',
   '{"tpl":"{cores}C / {ram_gb}G / {storage_gb}G {storage_type}"}'),
  ('vps', 'routes',        '线路',     'multi',  'extra', 1,  6, 1, '[]', NULL),
  ('vps', 'price',         '费用',     'num',    'col',   1,  7, 1, '[]', NULL),
  ('vps', 'currency',      '币种',     'sel',    'col',   1,  8, 1, '[]', NULL),
  ('vps', 'last_renewed',  '上次续费', 'date',   'col',   1,  9, 1, '[]', NULL),
  ('vps', 'left',          '剩余天数', 'num',    'calc',  1, 10, 1, '[]', NULL),
  ('vps', 'cycle',         '周期',     'sel',    'col',   0, 20, 1, '[]', NULL),
  ('vps', 'cycle_days',    '周期天数', 'num',    'col',   0, 21, 1, '[]', NULL),
  ('vps', 'product',       '产品',     'text',   'extra', 0, 22, 1, '[]', NULL),
  ('vps', 'cores',         '核心',     'num',    'extra', 0, 23, 1, '[]', NULL),
  ('vps', 'ram_gb',        '内存 GB',  'num',    'extra', 0, 24, 1, '[]', NULL),
  ('vps', 'storage_gb',    '存储 GB',  'num',    'extra', 0, 25, 1, '[]', NULL),
  ('vps', 'storage_type',  '存储类型', 'sel',    'extra', 0, 26, 1, '[]', NULL),
  ('vps', 'extra_storage', '附加存储', 'text',   'extra', 0, 27, 1, '[]', NULL),
  ('vps', 'port_gbps',     '端口 Gbps','num',    'extra', 0, 28, 1, '[]', NULL),
  ('vps', 'traffic_tb',    '流量 TB',  'num',    'extra', 0, 29, 1, '[]', NULL),
  ('vps', 'ipv6',          'IPv6',     'num',    'extra', 0, 30, 1, '[]', NULL),
  ('vps', 'account',       '账号',     'text',   'extra', 0, 31, 1, '[]', NULL),
  ('vps', 'url',           '链接',     'text',   'col',   0, 32, 1, '[]', NULL),
  ('vps', 'notes',         '备注',     'text',   'col',   0, 33, 1, '[]', NULL)
ON CONFLICT(tbl, key) DO UPDATE SET
  name    = excluded.name,
  ftype   = excluded.ftype,
  src     = excluded.src,
  shown   = excluded.shown,
  pos     = excluded.pos,
  builtin = excluded.builtin,
  config  = excluded.config;

-- 状态词表带语义标记：spend=计入支出，alert=发提醒，timeline=上到期时间线与日历。
-- 三个语义此前是 engine 里的 status 字面量，从此以数据为准（engine 读不到就回落到同样的默认）。
-- 注意：这三条 UPDATE 只在该库还没有自定义过状态词表时写入，避免覆盖用户改动。
INSERT INTO fields(tbl, key, name, ftype, src, shown, pos, builtin, options, config)
SELECT c.key, 'status', '状态', 'status', 'col', 1, 2, 1,
  json('[{"v":"Active","spend":1,"alert":1,"timeline":1},
         {"v":"Planned","spend":0,"alert":0,"timeline":0},
         {"v":"Deferred","spend":0,"alert":0,"timeline":0},
         {"v":"Unused","spend":0,"alert":0,"timeline":0},
         {"v":"Ending","spend":0,"alert":0,"timeline":1},
         {"v":"Ended","spend":0,"alert":0,"timeline":0}]'),
  NULL
FROM collections c
WHERE c.key IN ('subs', 'sims', 'vps')
ON CONFLICT(tbl, key) DO UPDATE SET
  options = CASE WHEN fields.options IN ('[]', '') OR fields.options IS NULL
                 THEN excluded.options ELSE fields.options END;
