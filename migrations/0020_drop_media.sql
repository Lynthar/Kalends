-- 撤下媒体库（media_items 与媒体字段注册）；还有媒体行时守卫表的 CHECK 翻车，整个迁移回滚。
CREATE TABLE _media_guard(
  n INTEGER CONSTRAINT media_rows_remain CHECK(n = 0)
);
INSERT INTO _media_guard SELECT count(*) FROM media_items;
DROP TABLE _media_guard;
DROP TABLE media_items;
DELETE FROM fields WHERE tbl='media';
