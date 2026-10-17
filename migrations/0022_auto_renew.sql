-- 条目加自动续费开关（存开启那天）、台账标出自动记的账；域名模板的「自动续费」开/关列在值只有开/关/空的库里并进开关。
ALTER TABLE items ADD COLUMN auto_renew TEXT;
ALTER TABLE renewal_ledger ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;

CREATE TEMP TABLE _ar AS
SELECT c.id, c.key FROM collections c
  JOIN fields f ON f.tbl = c.key AND f.key = 'auto_renew' AND f.src = 'extra'
 WHERE NOT EXISTS (
   SELECT 1 FROM items i
    WHERE i.collection_id = c.id AND json_valid(i.extra)
      AND coalesce(json_extract(i.extra, '$.auto_renew'), '') NOT IN ('开', '关', ''));

UPDATE items SET auto_renew = date('now', 'localtime')
 WHERE collection_id IN (SELECT id FROM _ar)
   AND json_valid(extra) AND json_extract(extra, '$.auto_renew') = '开';
UPDATE items SET extra = json_remove(extra, '$.auto_renew')
 WHERE collection_id IN (SELECT id FROM _ar)
   AND json_valid(extra) AND json_type(extra, '$.auto_renew') IS NOT NULL;
DELETE FROM fields WHERE key = 'auto_renew' AND src = 'extra' AND tbl IN (SELECT key FROM _ar);

DROP TABLE _ar;
