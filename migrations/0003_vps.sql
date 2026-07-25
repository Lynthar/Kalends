-- VPS / 云服务器：与 SIM 同为"上次续费 + 周期"模型，规格线路为其特有

CREATE TABLE vps_instances (
  id            INTEGER PRIMARY KEY,
  vendor        TEXT NOT NULL,                  -- 商家
  product       TEXT,                           -- 产品/套餐名
  status        TEXT NOT NULL DEFAULT '启用',    -- 启用 / 准备 / 预结束 / 未启用 / 已结束
                                                -- 预结束 = 到期不续：仍显示在到期时间线，但不发提醒、不计支出
  purpose       TEXT,                           -- 用途：代理入口/代理出口/建站/任务…
  locations     TEXT,                           -- JSON 数组，如 ["东京（TYO）"]
  routes        TEXT,                           -- JSON 数组，如 ["CN2 GIA","9929"]
  cores         REAL,
  ram_gb        REAL,
  storage_gb    REAL,
  storage_type  TEXT,                           -- SSD / HDD
  extra_storage TEXT,
  port_gbps     REAL,
  traffic_tb    REAL,
  ipv6          INTEGER,                        -- 0/1
  price         REAL,
  currency      TEXT,                           -- ISO 4217
  cycle         TEXT,                           -- weekly/monthly/quarterly/semiannual/annual/biennial/triennial/lifetime/days
  cycle_days    INTEGER,
  last_renewed  TEXT,                           -- 上次续费；到期 = 按周期从此推进
  url           TEXT,
  account       TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_vps_status ON vps_instances(status);
