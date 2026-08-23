-- 「续费后从哪天起算」独立成 renew_from 列，不再挤在 due_anchor 里：due_anchor 决定到期日
-- 从哪儿来，renew_from 决定续费之后从哪天起算，两个轴正交（四种组合见 engine::renew_to）。
-- 默认给 schedule——多数周期账单有固定账单日，「从操作当天重新计时」才是特例。
ALTER TABLE collections ADD COLUMN renew_from TEXT NOT NULL DEFAULT 'schedule';

-- 存量一律保持原行为，免得别人的实例被这次迁移悄悄改掉语义：
-- last 锚点此前恒等于「从今天起算」，逐个置回 today。
UPDATE collections SET renew_from = 'today' WHERE due_anchor = 'last';

-- 唯独 vps 留在 schedule——这正是本次要修的那一条。预置库不一定还在（按设计可删），
-- 不在时这句影响 0 行。
UPDATE collections SET renew_from = 'schedule' WHERE key = 'vps';
