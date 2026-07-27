-- 库泛化：订阅 / SIM / VPS 三张固化表 → collections（库）+ items（条目）。
-- 引擎要用的字段留真列（status/price/currency/cycle/cycle_days/next_renewal/last_renewed/
-- name/parent_id/url/notes/logo），域字段进 extra JSON、键沿用原列名，与自定义列同一套机制。
-- 旧三表原样留着不删：部署后未录入新数据前，回滚旧二进制无损。
-- price_history 仍挂在旧 subscriptions(id) 上（当前无读取方），不随之重指。

CREATE TABLE collections (
  id         INTEGER PRIMARY KEY,
  key        TEXT NOT NULL UNIQUE,          -- 前端标识，也是台账/通知/ICS 里的 kind
  name       TEXT NOT NULL,
  icon       TEXT,
  due_anchor TEXT NOT NULL DEFAULT 'last',  -- next=直接存下次到期日；last=上次续费+周期推算
  subtitle   TEXT,                          -- 副标题字段键（VPS 用 product），可空
  verb       TEXT,                           -- 到期动作说法，进日历标题；空则"续费"（SIM 是"保号"）
  note_field TEXT,                           -- 进日历描述的 extra 字段键（SIM 用 keepalive_action）
  pos        INTEGER NOT NULL DEFAULT 0,
  builtin    INTEGER NOT NULL DEFAULT 0,    -- 预置库标记；仅用于界面提示，不妨碍删除
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE items (
  id            INTEGER PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  parent_id     INTEGER REFERENCES items(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'Planned',
  price         REAL,
  currency      TEXT,
  cycle         TEXT,
  cycle_days    INTEGER,
  next_renewal  TEXT,
  last_renewed  TEXT,
  url           TEXT,
  notes         TEXT,
  logo          TEXT,
  extra         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_items_coll   ON items(collection_id);
CREATE INDEX idx_items_status ON items(status);
CREATE INDEX idx_items_parent ON items(parent_id);
CREATE INDEX idx_items_due    ON items(next_renewal, last_renewed);

INSERT INTO collections(key, name, icon, due_anchor, subtitle, verb, note_field, pos, builtin) VALUES
  ('subs', '订阅',   NULL, 'next', NULL,      NULL,   NULL,               1, 1),
  ('sims', 'SIM 卡', NULL, 'last', NULL,      '保号', 'keepalive_action', 2, 1),
  ('vps',  'VPS',    NULL, 'last', 'product', NULL,   NULL,               3, 1);

-- 旧 id → 新 id 映射，显式算出来，不依赖 rowid 的分配顺序
CREATE TABLE _migr_map (kind TEXT NOT NULL, old_id INTEGER NOT NULL, new_id INTEGER NOT NULL);
INSERT INTO _migr_map(kind, old_id, new_id)
SELECT kind, old_id, ROW_NUMBER() OVER (ORDER BY ord, old_id) FROM (
  SELECT 'subs' AS kind, id AS old_id, 1 AS ord FROM subscriptions
  UNION ALL SELECT 'sims', id, 2 FROM sim_cards
  UNION ALL SELECT 'vps',  id, 3 FROM vps_instances
);

-- 订阅：分类 / 支付方式 / 账号进 extra；父子档位按映射重指
INSERT INTO items(id, collection_id, name, parent_id, status, price, currency, cycle, cycle_days,
                  next_renewal, last_renewed, url, notes, logo, extra, created_at, updated_at)
SELECT m.new_id,
       (SELECT id FROM collections WHERE key = 'subs'),
       s.name,
       (SELECT p.new_id FROM _migr_map p WHERE p.kind = 'subs' AND p.old_id = s.parent_id),
       s.status, s.price, s.currency, s.cycle, s.cycle_days,
       s.next_renewal, NULL, s.url, s.notes, s.logo,
       json_patch(
         CASE WHEN json_valid(s.extra) THEN s.extra ELSE '{}' END,
         json_object('category',       s.category,
                     'payment_method', s.payment_method,
                     'account',        s.account)),
       s.created_at, s.updated_at
FROM subscriptions s JOIN _migr_map m ON m.kind = 'subs' AND m.old_id = s.id;

-- SIM：保号周期天数并入通用周期模型（cycle='days' + cycle_days），号码/形式/保号动作进 extra
INSERT INTO items(id, collection_id, name, parent_id, status, price, currency, cycle, cycle_days,
                  next_renewal, last_renewed, url, notes, logo, extra, created_at, updated_at)
SELECT m.new_id,
       (SELECT id FROM collections WHERE key = 'sims'),
       s.name, NULL, s.status, NULL, NULL,
       CASE WHEN ifnull(s.cycle_days, 0) > 0 THEN 'days' END,
       s.cycle_days,
       NULL, s.last_renewed, NULL, s.notes, NULL,
       json_patch(
         CASE WHEN json_valid(s.extra) THEN s.extra ELSE '{}' END,
         json_object('phone_number',     s.phone_number,
                     'keepalive_action', s.keepalive_action,
                     'forms',            CASE WHEN json_valid(s.forms) THEN json(s.forms) END)),
       s.created_at, s.updated_at
FROM sim_cards s JOIN _migr_map m ON m.kind = 'sims' AND m.old_id = s.id;

-- VPS：商家为条目名，产品名与规格 / 线路 / 地点进 extra
INSERT INTO items(id, collection_id, name, parent_id, status, price, currency, cycle, cycle_days,
                  next_renewal, last_renewed, url, notes, logo, extra, created_at, updated_at)
SELECT m.new_id,
       (SELECT id FROM collections WHERE key = 'vps'),
       v.vendor, NULL, v.status, v.price, v.currency, v.cycle, v.cycle_days,
       NULL, v.last_renewed, v.url, v.notes, NULL,
       json_patch(
         CASE WHEN json_valid(v.extra) THEN v.extra ELSE '{}' END,
         json_object('product',       v.product,
                     'purpose',       v.purpose,
                     'locations',     CASE WHEN json_valid(v.locations) THEN json(v.locations) END,
                     'routes',        CASE WHEN json_valid(v.routes)    THEN json(v.routes)    END,
                     'cores',         v.cores,
                     'ram_gb',        v.ram_gb,
                     'storage_gb',    v.storage_gb,
                     'storage_type',  v.storage_type,
                     'extra_storage', v.extra_storage,
                     'port_gbps',     v.port_gbps,
                     'traffic_tb',    v.traffic_tb,
                     'ipv6',          v.ipv6,
                     'account',       v.account)),
       v.created_at, v.updated_at
FROM vps_instances v JOIN _migr_map m ON m.kind = 'vps' AND m.old_id = v.id;

-- 续费台账与通知去重日志的 (kind, item_id) 重指到新条目；kind 统一为库键。
-- 通知去重键必须跟着走，否则同一到期日会重发一轮。
UPDATE renewal_ledger SET
  item_id = (SELECT m.new_id FROM _migr_map m WHERE m.kind = 'subs' AND m.old_id = renewal_ledger.item_id),
  kind = 'subs'
WHERE renewal_ledger.kind = 'subscription'
  AND EXISTS (SELECT 1 FROM _migr_map m WHERE m.kind = 'subs' AND m.old_id = renewal_ledger.item_id);

UPDATE renewal_ledger SET
  item_id = (SELECT m.new_id FROM _migr_map m WHERE m.kind = 'sims' AND m.old_id = renewal_ledger.item_id),
  kind = 'sims'
WHERE renewal_ledger.kind = 'sim'
  AND EXISTS (SELECT 1 FROM _migr_map m WHERE m.kind = 'sims' AND m.old_id = renewal_ledger.item_id);

UPDATE renewal_ledger SET
  item_id = (SELECT m.new_id FROM _migr_map m WHERE m.kind = 'vps' AND m.old_id = renewal_ledger.item_id)
WHERE renewal_ledger.kind = 'vps'
  AND EXISTS (SELECT 1 FROM _migr_map m WHERE m.kind = 'vps' AND m.old_id = renewal_ledger.item_id);

UPDATE notification_log SET
  item_id = (SELECT m.new_id FROM _migr_map m WHERE m.kind = 'subs' AND m.old_id = notification_log.item_id),
  kind = 'subs'
WHERE notification_log.kind = 'subscription'
  AND EXISTS (SELECT 1 FROM _migr_map m WHERE m.kind = 'subs' AND m.old_id = notification_log.item_id);

UPDATE notification_log SET
  item_id = (SELECT m.new_id FROM _migr_map m WHERE m.kind = 'sims' AND m.old_id = notification_log.item_id),
  kind = 'sims'
WHERE notification_log.kind = 'sim'
  AND EXISTS (SELECT 1 FROM _migr_map m WHERE m.kind = 'sims' AND m.old_id = notification_log.item_id);

UPDATE notification_log SET
  item_id = (SELECT m.new_id FROM _migr_map m WHERE m.kind = 'vps' AND m.old_id = notification_log.item_id)
WHERE notification_log.kind = 'vps'
  AND EXISTS (SELECT 1 FROM _migr_map m WHERE m.kind = 'vps' AND m.old_id = notification_log.item_id);

DROP TABLE _migr_map;
