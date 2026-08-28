-- user_version=14 时代（新架构）的合成数据，全为虚构的通用值：主题是自定义库/自定义列/extra
-- 在后续迁移里原样存续。行的取值即断言的预期来源，改这里必须同步改测试。

INSERT INTO collections(id, key, name, due_anchor, pos, builtin) VALUES
  (4, 'books', '藏书', 'next', 4, 0);

INSERT INTO fields(tbl, key, name, ftype, options, builtin, pos, src, shown) VALUES
  ('subs',  'c1',           '付费方式', 'sel',    '["月付","年付"]', 0, 30, 'extra', 1),
  ('books', 'name',         '名称',     'text',   '[]',              1, 1,  'col',   1),
  ('books', 'status',       '状态',     'status', '[]',              1, 2,  'col',   1),
  ('books', 'next_renewal', '到期',     'date',   '[]',              1, 3,  'col',   1);

-- 模拟用户自定义过的规格模板：0016 的「改过就不动」防线要在这上面验
UPDATE fields SET config = '{"tpl":"{cores}C/{ram_gb}G"}' WHERE tbl = 'vps' AND key = 'spec';

INSERT INTO items(id, collection_id, name, status, price, currency, cycle, cycle_days, next_renewal, last_renewed, extra, pos) VALUES
  (101, 1, 'Example Plus',    'Active', 11.99, 'USD', 'monthly', NULL, '2026-09-01', NULL,         '{"c1":"月付","payment_method":"PayPal"}', 1),
  (102, 2, 'ExampleTel',      'Active', NULL,  NULL,  'days',    90,   NULL,         '2026-07-01', '{"phone_number":"+44 7700 900456"}',      1),
  (103, 3, 'ExampleHost',     'Active', 5.5,   'USD', 'annual',  NULL, NULL,         '2026-05-20', '{"product":"VPS-Basic","cores":2}',       1),
  (104, 4, 'Example Almanac', 'Active', NULL,  NULL,  NULL,      NULL, '2026-12-31', NULL,         NULL,                                      1);

INSERT INTO renewal_ledger(kind, item_id, renewed_at, amount, currency) VALUES
  ('subs',  101, '2026-08-01', 11.99, 'USD'),
  ('books', 999, '2026-01-01', NULL,  NULL);
