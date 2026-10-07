-- 条目与字段的 id 不再复用：id_seq 记下各自发出过的最大 id（含已删行留在别处的痕迹），新行从它之后取号。
CREATE TABLE id_seq (name TEXT PRIMARY KEY, seq INTEGER NOT NULL);

INSERT INTO id_seq(name, seq) SELECT 'items', max(
  (SELECT coalesce(max(id), 0) FROM items),
  (SELECT coalesce(max(item_id), 0) FROM renewal_ledger),
  (SELECT coalesce(max(item_id), 0) FROM notification_log));

INSERT INTO id_seq(name, seq) SELECT 'fields', max(
  (SELECT coalesce(max(id), 0) FROM fields),
  (SELECT coalesce(max(CAST(substr(j.key, 2) AS INTEGER)), 0)
     FROM items, json_each(CASE WHEN json_valid(items.extra) THEN items.extra ELSE '{}' END) j
     WHERE j.key GLOB 'c[0-9]*'),
  (SELECT coalesce(max(CAST(substr(k, 2) AS INTEGER)), 0)
     FROM (SELECT subtitle AS k FROM collections
           UNION ALL SELECT subline FROM collections
           UNION ALL SELECT note_field FROM collections)
     WHERE k GLOB 'c[0-9]*'));
