-- user_version=14 时代（新架构）的合成数据，全为虚构的通用值：主题是自定义库/自定义列/extra
-- 在后续迁移里原样存续。行的取值即断言的预期来源，改这里必须同步改测试。

INSERT INTO collections(id, key, name, due_anchor, pos, builtin) VALUES
  (4, 'books', '藏书', 'next', 4, 0),
  (5, 'k5', '域名', 'next', 5, 0),
  (6, 'k6', '域名乙', 'next', 6, 0);

INSERT INTO fields(tbl, key, name, ftype, options, builtin, pos, src, shown) VALUES
  ('subs',  'c1',           '付费方式', 'sel',    '["月付","年付"]', 0, 30, 'extra', 1),
  ('books', 'name',         '名称',     'text',   '[]',              1, 1,  'col',   1),
  ('books', 'status',       '状态',     'status', '[]',              1, 2,  'col',   1),
  ('books', 'next_renewal', '到期',     'date',   '[]',              1, 3,  'col',   1),
  -- 域名模板的「自动续费」开/关列：k5 只有开/关/空，并进开关；k6 加过别的值，原样留着
  ('k5',    'auto_renew',   '自动续费', 'sel',    '[{"v":"开"},{"v":"关"}]', 0, 4, 'extra', 1),
  ('k6',    'auto_renew',   '自动续费', 'sel',    '[{"v":"开"},{"v":"关"},{"v":"是"}]', 0, 4, 'extra', 1);

-- 已删列留下的痕迹：库属性还指着它（c950），另有一行 extra 里挂着孤儿键（c900）
UPDATE collections SET note_field = 'c950' WHERE key = 'books';

-- 模拟用户自定义过的规格模板：0016 的「改过就不动」防线要在这上面验
UPDATE fields SET config = '{"tpl":"{cores}C/{ram_gb}G"}' WHERE tbl = 'vps' AND key = 'spec';

-- 备注三种形态（0023 搬进 extra）：extra 已有值、extra 为 NULL、备注是空串（不搬、extra 原样）；
-- ExampleBox 的 1/31 月付给 0024 的月末折算当样本
INSERT INTO items(id, collection_id, name, status, price, currency, cycle, cycle_days, next_renewal, last_renewed, extra, pos, notes) VALUES
  (101, 1, 'Example Plus',    'Active', 11.99, 'USD', 'monthly', NULL, '2026-09-01', NULL,         '{"c1":"月付","payment_method":"PayPal"}', 1, '每月对账'),
  (102, 2, 'ExampleTel',      'Active', NULL,  NULL,  'days',    90,   NULL,         '2026-07-01', '{"phone_number":"+44 7700 900456","c900":"已删列的残值"}', 1, NULL),
  (103, 3, 'ExampleHost',     'Active', 5.5,   'USD', 'annual',  NULL, NULL,         '2026-05-20', '{"product":"VPS-Basic","cores":2}',       1, ''),
  (108, 3, 'ExampleBox',      'Active', 3,     'EUR', 'monthly', NULL, NULL,         '2026-01-31', '{"product":"Box"}',                       2, NULL),
  (104, 4, 'Example Almanac', 'Active', NULL,  NULL,  NULL,      NULL, '2026-12-31', NULL,         NULL,                                      1, '纸本'),
  (105, 5, 'example.com',     'Active', 10,    'USD', 'annual',  NULL, '2027-03-01', NULL,         '{"auto_renew":"开","registrar":"ExampleReg"}', 1, NULL),
  (106, 5, 'example.org',     'Active', 10,    'USD', 'annual',  NULL, '2027-04-01', NULL,         '{"auto_renew":"关"}',                     2, NULL),
  (107, 6, 'example.net',     'Active', 10,    'USD', 'annual',  NULL, '2027-05-01', NULL,         '{"auto_renew":"是"}',                     1, NULL);

INSERT INTO renewal_ledger(kind, item_id, renewed_at, amount, currency) VALUES
  ('subs',  101, '2026-08-01', 11.99, 'USD'),
  ('books', 999, '2026-01-01', NULL,  NULL);
