-- user_version=4 时代（库泛化之前的最后形态）的合成数据，全为虚构的通用值，
-- 给 db.rs 的「中间版本升级」测试当起点：行的取值即断言的预期来源，改这里必须同步改测试。

INSERT INTO subscriptions(id, name, parent_id, category, status, price, currency, cycle, next_renewal, payment_method, account, url, extra) VALUES
  (10, 'Beta Cloud', NULL, 'CloudSvc', 'Active', NULL, NULL,  NULL,      NULL,         NULL,   'user@example.com', 'https://example.com', NULL),
  (20, 'Pro tier',   10,   NULL,       'Active', 9.99, 'USD', 'annual',  '2027-01-15', 'Visa', NULL,               NULL,                  'not json'),
  (30, 'alpha Host', NULL, 'DevTools', 'Ended',  30,   'CNY', 'monthly', NULL,         NULL,   NULL,               NULL,                  '{"c1":"自定义值"}');

INSERT INTO price_history(subscription_id, price, currency, effective_from) VALUES
  (10, 7.99, 'USD', '2024-01-01'),
  (20, 8.99, 'USD', '2025-01-01');

INSERT INTO sim_cards(id, name, phone_number, forms, status, keepalive_action, cycle_days, last_renewed) VALUES
  (5,  '🇬🇧 ExampleTel', '+44 7700 900123', '["SIM","eSIM"]', '启用',   '每 90 天充值一次', 90,   '2026-06-01'),
  (6,  'AnyTel',         NULL,              NULL,             '未启用', NULL,               NULL, NULL),
  (40, 'OldTel',         NULL,              'SIM',            '已结束', NULL,               0,    NULL);

INSERT INTO vps_instances(id, vendor, product, status, purpose, locations, routes, cores, ram_gb, storage_gb, storage_type, port_gbps, traffic_tb, ipv6, price, currency, cycle, last_renewed, url, account) VALUES
  (8, 'ExampleHost', 'VPS-Basic', '预结束', '代理出口', '["东京（TYO）"]', '["CN2 GIA","9929"]', 1,    1,    20,   'SSD', 1,    1,    1,    5.5,  'USD', 'annual', '2026-03-10', 'https://example.com', 'user@example.com'),
  (9, 'NodeCo',      NULL,        '准备',   NULL,       NULL,              NULL,                 NULL, NULL, NULL, NULL,  NULL, NULL, NULL, NULL, NULL,  NULL,     NULL,         NULL,                  NULL);

INSERT INTO fields(tbl, key, name, ftype, options, builtin, pos) VALUES
  ('subs', 'c1', '自定义列', 'text', '[]', 0, 1);

INSERT INTO renewal_ledger(kind, item_id, renewed_at, amount, currency, note) VALUES
  ('subscription', 20,  '2025-12-01', 9.99, 'USD', NULL),
  ('sim',          5,   '2026-06-01', NULL, NULL,  '充值'),
  ('sim',          999, '2025-01-01', NULL, NULL,  NULL);

INSERT INTO notification_log(kind, item_id, channel, threshold_days, due_date, ok) VALUES
  ('subscription', 20,  'telegram', 7, '2026-01-10', 1),
  ('subscription', 999, 'telegram', 3, '2026-01-05', 1);
