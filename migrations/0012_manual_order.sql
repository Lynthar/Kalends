-- 手动排序：pos 是「没点任何列排序时」的基态序（Notion 同款模型——手动序是基态，
-- 一旦按某列排序就临时盖过它，拖拽随之禁用）。
--
-- 回填成各表当前的默认显示序，好让升级后界面上看不出变化：
--   items       —— 前端 renderColl 此前在无排序时按名称排（这行随本次改动一并删掉）；
--   media_items —— 后端一直是「最近标记优先」，前端不另排。
-- 库这侧回填用的是 SQLite 的 NOCASE 序，与浏览器 localeCompare('zh') 对中文名的排法
-- 不完全一致（生产 163 条里含中文的只有 14 条），差异仅此一次、之后一切以手动序为准。
ALTER TABLE items ADD COLUMN pos INTEGER;
ALTER TABLE media_items ADD COLUMN pos INTEGER;

WITH ord AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY collection_id ORDER BY name COLLATE NOCASE, id
  ) AS rn FROM items
)
UPDATE items SET pos = (SELECT rn FROM ord WHERE ord.id = items.id);

WITH ord AS (
  SELECT id, ROW_NUMBER() OVER (
    ORDER BY marked_at IS NULL, marked_at DESC, id DESC
  ) AS rn FROM media_items
)
UPDATE media_items SET pos = (SELECT rn FROM ord WHERE ord.id = media_items.id);

CREATE INDEX idx_items_pos ON items(collection_id, pos);
CREATE INDEX idx_media_pos ON media_items(pos);
