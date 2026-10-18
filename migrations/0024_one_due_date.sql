-- 到期日只存一个（下次到期日）：按「上次续费 + 周期」记的库把日期折成下次到期日，上次续费改成算出来的列，
-- 账单日单独记一格（月末钳位时记下原来的日），库的到期模型设置随之退场。
ALTER TABLE items ADD COLUMN billing_day INTEGER;

CREATE TEMP TABLE _last AS
SELECT i.id, i.last_renewed AS l,
       CASE i.cycle WHEN 'monthly' THEN 1 WHEN 'quarterly' THEN 3 WHEN 'semiannual' THEN 6
                    WHEN 'annual' THEN 12 WHEN 'biennial' THEN 24 WHEN 'triennial' THEN 36 END AS months,
       CASE i.cycle WHEN 'weekly' THEN 7 WHEN 'days' THEN CASE WHEN i.cycle_days > 0 THEN i.cycle_days END END AS ndays
  FROM items i JOIN collections c ON c.id = i.collection_id
 WHERE c.due_anchor = 'last';
ALTER TABLE _last ADD COLUMN due TEXT;
-- SQLite 的 '+N months' 会把 1/31 溢出成 3/3：先落到目标月 1 号再取原来的日，超出月末就取月末
UPDATE _last SET due = CASE
  WHEN date(l) IS NULL THEN NULL
  WHEN months IS NOT NULL THEN min(
    date(l, 'start of month', '+' || months || ' months', '+' || (CAST(strftime('%d', l) AS INTEGER) - 1) || ' days'),
    date(l, 'start of month', '+' || (months + 1) || ' months', '-1 day'))
  WHEN ndays IS NOT NULL THEN date(l, '+' || ndays || ' days')
END;
UPDATE items SET
  next_renewal = (SELECT due FROM _last WHERE _last.id = items.id),
  billing_day = (SELECT CASE WHEN months IS NOT NULL AND due IS NOT NULL AND strftime('%d', due) <> strftime('%d', l)
                             THEN CAST(strftime('%d', l) AS INTEGER) END
                   FROM _last WHERE _last.id = items.id)
 WHERE id IN (SELECT id FROM _last);
DROP TABLE _last;

DROP INDEX idx_items_due;
ALTER TABLE items DROP COLUMN last_renewed;
CREATE INDEX idx_items_due ON items(next_renewal);

-- 字段注册表：上次续费变成算出来的列；每个库都有下次到期（原来按上次续费记的库现在只有它可填，必须上表）、
-- 上次续费、剩余天数三列，缺的补上、有的不动。
UPDATE fields SET src = 'calc', builtin = 1 WHERE key = 'last_renewed';
UPDATE fields SET shown = 1 WHERE key = 'next_renewal' AND tbl IN (SELECT key FROM collections WHERE due_anchor = 'last');
CREATE TEMP TABLE _add AS
  SELECT c.key AS tbl, 'next_renewal' AS key, '下次到期' AS name, 'date' AS ftype, 'col' AS src, 1 AS shown,
         coalesce((SELECT max(pos) FROM fields f WHERE f.tbl = c.key AND f.key IN ('last_renewed', 'left')), 40) AS pos
    FROM collections c WHERE NOT EXISTS (SELECT 1 FROM fields WHERE tbl = c.key AND key = 'next_renewal')
  UNION ALL
  SELECT c.key, 'last_renewed', '上次续费', 'date', 'calc', 0,
         coalesce((SELECT pos FROM fields f WHERE f.tbl = c.key AND f.key = 'next_renewal'), 40)
    FROM collections c WHERE NOT EXISTS (SELECT 1 FROM fields WHERE tbl = c.key AND key = 'last_renewed')
  UNION ALL
  SELECT c.key, 'left', '剩余天数', 'num', 'calc', 0,
         coalesce((SELECT pos FROM fields f WHERE f.tbl = c.key AND f.key = 'next_renewal'), 40)
    FROM collections c WHERE NOT EXISTS (SELECT 1 FROM fields WHERE tbl = c.key AND key = 'left');
-- 新行的 id 从 max(seq, 现有最大 id) 之后发（与 db::next_id 同一规则：seq 可能落后于行），发完把 seq 推到位
INSERT INTO fields(id, tbl, key, name, ftype, src, shown, pos, builtin, options)
  SELECT (SELECT max(seq, (SELECT coalesce(max(id), 0) FROM fields)) FROM id_seq WHERE name = 'fields')
         + row_number() OVER (ORDER BY tbl, key),
         tbl, key, name, ftype, src, shown, pos, 1, '[]'
    FROM _add;
UPDATE id_seq SET seq = max(seq, (SELECT coalesce(max(id), 0) FROM fields)) WHERE name = 'fields';
DROP TABLE _add;

ALTER TABLE collections DROP COLUMN due_anchor;
