-- 没注册周期的库里只填了天数的条目落成自定义周期。
UPDATE items SET cycle = 'days'
 WHERE coalesce(cycle, '') = '' AND typeof(cycle_days) = 'integer' AND cycle_days > 0
   AND collection_id IN (SELECT c.id FROM collections c
                          WHERE NOT EXISTS (SELECT 1 FROM fields f WHERE f.tbl = c.key AND f.key = 'cycle'));

-- 每个库都注册周期 / 费用 / 链接（缺的补上、不上表），周期与费用排在下次到期之后、链接排最后。
CREATE TEMP TABLE _add AS
  SELECT c.key AS tbl, g.key, g.name, g.ftype,
         CASE g.key WHEN 'url' THEN coalesce((SELECT max(pos) FROM fields f WHERE f.tbl = c.key), 60) + 1
                    ELSE coalesce((SELECT pos FROM fields f WHERE f.tbl = c.key AND f.key = 'next_renewal'), 40) END AS pos
    FROM collections c,
         (SELECT 'cycle' AS key, '周期' AS name, 'sel' AS ftype
          UNION ALL SELECT 'price', '费用', 'num'
          UNION ALL SELECT 'url', '链接', 'text') g
   WHERE NOT EXISTS (SELECT 1 FROM fields f WHERE f.tbl = c.key AND f.key = g.key);
INSERT INTO fields(id, tbl, key, name, ftype, src, shown, pos, builtin, options)
  SELECT (SELECT max(seq, (SELECT coalesce(max(id), 0) FROM fields)) FROM id_seq WHERE name = 'fields')
         + row_number() OVER (ORDER BY tbl, key),
         tbl, key, name, ftype, 'col', 0, pos, 1, '[]'
    FROM _add;
UPDATE id_seq SET seq = max(seq, (SELECT coalesce(max(id), 0) FROM fields)) WHERE name = 'fields';
DROP TABLE _add;

-- 周期天数只属于自定义周期：别的周期上的天数清掉，它也不再单独成列。
UPDATE items SET cycle_days = NULL WHERE cycle_days IS NOT NULL AND coalesce(cycle, '') <> 'days';
DELETE FROM fields WHERE key = 'cycle_days' AND src = 'col';

-- 买断没有到期日；推不动的周期（买断、没周期）不挂自动续费。
UPDATE items SET next_renewal = NULL, billing_day = NULL WHERE cycle = 'lifetime';
UPDATE items SET auto_renew = NULL WHERE auto_renew IS NOT NULL AND coalesce(cycle, '') IN ('', 'lifetime');
