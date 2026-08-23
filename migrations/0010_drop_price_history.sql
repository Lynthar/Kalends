-- 删掉 price_history：自建表起就没有读写方与界面入口，外键还指着库泛化前的 subscriptions(id)。
DROP INDEX IF EXISTS idx_price_history_sub;
DROP TABLE IF EXISTS price_history;
