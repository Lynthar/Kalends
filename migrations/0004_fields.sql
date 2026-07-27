-- 字段注册表：自定义列（builtin=0，key 形如 c<id>，值挂在各实体表 extra JSON 里）
-- 与内置自由词表列的选项清单（builtin=1，key=内置列键）。
CREATE TABLE IF NOT EXISTS fields (
  id INTEGER PRIMARY KEY,
  tbl TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  ftype TEXT NOT NULL DEFAULT 'text',
  options TEXT NOT NULL DEFAULT '[]',
  builtin INTEGER NOT NULL DEFAULT 0,
  pos INTEGER NOT NULL DEFAULT 0,
  UNIQUE(tbl, key)
);

ALTER TABLE subscriptions ADD COLUMN extra TEXT;
ALTER TABLE sim_cards ADD COLUMN extra TEXT;
ALTER TABLE vps_instances ADD COLUMN extra TEXT;
ALTER TABLE media_items ADD COLUMN extra TEXT;
