-- 续费中心 v1：订阅、SIM保号、共享的续费台账与通知发送记录

CREATE TABLE subscriptions (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  parent_id      INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL, -- 服务→套餐档位
  category       TEXT,                                   -- NetInfra/CloudSvc/DevTools/AI/…（沿用 Notion 词表，可自由扩展）
  status         TEXT NOT NULL DEFAULT 'Planned',        -- Planned / Deferred / Active / Ended；仅 Active 参与统计与到期计算
  price          REAL,
  currency       TEXT,                                   -- ISO 4217：CNY / USD / GBP …
  cycle          TEXT,                                   -- weekly / monthly / quarterly / semiannual / annual / lifetime / days
  cycle_days     INTEGER,                                -- cycle='days' 时的自定义天数
  next_renewal   TEXT,                                   -- ISO 日期
  payment_method TEXT,
  account        TEXT,                                   -- 注册所用邮箱/账号
  url            TEXT,
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);
CREATE INDEX idx_subscriptions_parent ON subscriptions(parent_id);
CREATE INDEX idx_subscriptions_next   ON subscriptions(next_renewal);

CREATE TABLE price_history (
  id              INTEGER PRIMARY KEY,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  price           REAL NOT NULL,
  currency        TEXT NOT NULL,
  effective_from  TEXT,                                  -- ISO 日期
  note            TEXT
);
CREATE INDEX idx_price_history_sub ON price_history(subscription_id);

CREATE TABLE sim_cards (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,                        -- 运营商+国家，如 "🇬🇧 某运营商"
  phone_number     TEXT,
  forms            TEXT,                                 -- JSON 数组，取值 SIM / eSIM / VOIP
  status           TEXT NOT NULL DEFAULT '未启用',        -- 启用 / 准备 / 未启用 / 已结束；仅 启用 参与到期计算
  keepalive_action TEXT,                                 -- 保号动作，如 "每 90 天充值一次"
  cycle_days       INTEGER,                              -- 保号周期天数（自定义，如 181）
  last_renewed     TEXT,                                 -- 上次续费/保号 ISO 日期；剩余天数 = last_renewed + cycle_days - today
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sim_cards_status ON sim_cards(status);

CREATE TABLE renewal_ledger (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,                              -- 'subscription' | 'sim'
  item_id    INTEGER NOT NULL,
  renewed_at TEXT NOT NULL,                              -- 实际续费/保号日期
  amount     REAL,
  currency   TEXT,
  note       TEXT
);
CREATE INDEX idx_renewal_ledger_item ON renewal_ledger(kind, item_id);

CREATE TABLE notification_log (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL,                          -- 'subscription' | 'sim' | 'digest'
  item_id        INTEGER,                                -- digest 时为空
  channel        TEXT NOT NULL,                          -- 'telegram' | 'discord' | 'email'
  threshold_days INTEGER,                                -- 触发的提前档位；同 (kind,item_id,due_date,threshold,channel) 只发一次
  due_date       TEXT NOT NULL,
  sent_at        TEXT NOT NULL DEFAULT (datetime('now')),
  ok             INTEGER NOT NULL,
  error          TEXT
);
CREATE INDEX idx_notification_log_item ON notification_log(kind, item_id, due_date);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
