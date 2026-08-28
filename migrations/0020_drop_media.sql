-- 媒体库迁往独立项目 Ludi：撤下 media_items 与媒体字段注册。
-- 守卫表的 CHECK 在还有媒体行时故意翻车、整个迁移回滚——先用 Ludi 的导入脚本搬走
-- （或在旧版本界面清空媒体库）再升级，否则这一步就是静默丢数据。
CREATE TABLE _media_guard(
  n INTEGER CONSTRAINT media_rows_remain_export_to_ludi_first CHECK(n = 0)
);
INSERT INTO _media_guard SELECT count(*) FROM media_items;
DROP TABLE _media_guard;
DROP TABLE media_items;
DELETE FROM fields WHERE tbl='media';
