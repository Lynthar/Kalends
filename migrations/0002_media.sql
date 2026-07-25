-- 媒体库：影视/游戏条目，豆瓣导出字段原样保留为快照

CREATE TABLE media_items (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL DEFAULT '电影',   -- 电影 / 剧集 / 动画 / 游戏
  title          TEXT NOT NULL,
  orig_title     TEXT,                            -- 又名/原文名
  year           INTEGER,
  status         TEXT NOT NULL DEFAULT '想看',    -- 想看 / 在看 / 看过 / 弃
  rating         INTEGER,                         -- 我的评分 1–5 星（豆瓣制）
  marked_at      TEXT,                            -- 标记日期
  started_at     TEXT,
  review         TEXT,                            -- 我的短评
  others_reviews TEXT,                            -- 短评们（豆瓣他人短评快照）
  genres         TEXT,                            -- " / " 分隔，沿用豆瓣格式
  directors      TEXT,
  writers        TEXT,
  actors         TEXT,
  countries      TEXT,
  languages      TEXT,
  runtime        TEXT,                            -- 片长，如 "94分钟" / "12集\40-55分钟"
  release_date   TEXT,                            -- 上映/首播日期（含地区标注的原文）
  douban_id      TEXT,
  douban_url     TEXT,
  douban_rating  REAL,
  douban_votes   INTEGER,
  imdb_id        TEXT,
  tmdb_id        INTEGER,
  platform       TEXT,                            -- 游戏平台
  playtime_hours REAL,                            -- 游戏时长
  steam_appid    INTEGER,
  cover          TEXT,                            -- covers/ 目录下的文件名
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_media_kind   ON media_items(kind);
CREATE INDEX idx_media_status ON media_items(status);
CREATE INDEX idx_media_marked ON media_items(marked_at);
CREATE INDEX idx_media_year   ON media_items(year);
