-- 删掉 price_history：迁移 0001 建了它，本打算把备注里的「某月从 $22.99 涨价」结构化，
-- 但代码里从来没有读写方，界面也没有入口，只在备份导出清单里占一行、看着像已有功能。
-- 它的外键还指着旧的 subscriptions(id)——库泛化后条目已经搬到 items，这张表连形状都过时了。
-- 日后真要做涨价历史，应当在 items 上重新建表，而不是复活这张空表。
DROP INDEX IF EXISTS idx_price_history_sub;
DROP TABLE IF EXISTS price_history;
