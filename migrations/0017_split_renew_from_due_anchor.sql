-- 「续费后从哪天起算」独立成一列，不再挤在 due_anchor 里。
--
-- due_anchor='last' 此前一个标记扛着两种语义：SIM 保号的窗口**本来就该**从实际充值那天
-- 重新计时，而 VPS 是服务商按固定日历日出账的。两者共用一条实现的结果是 VPS 那侧错了：
-- 点一次「已续费」就把 last_renewed 设成今天，晚付十天账期便永久后移十天，而且逐期累积。
--
-- 两个轴其实是正交的——due_anchor 决定到期日**从哪儿来**，renew_from 决定续费之后
-- **从哪天起算**。拆开之后四种组合都说得通（见 engine::renew_to）。
--
-- 默认给 schedule：多数周期账单（域名、保险、证书、云主机）都有固定账单日，
-- 「从操作当天重新计时」才是特例。
ALTER TABLE collections ADD COLUMN renew_from TEXT NOT NULL DEFAULT 'schedule';

-- 存量一律保持原行为，免得别人的实例被这次迁移悄悄改掉语义：
-- last 锚点此前恒等于「从今天起算」，逐个置回 today。
UPDATE collections SET renew_from = 'today' WHERE due_anchor = 'last';

-- 唯独 vps 留在 schedule——这正是本次要修的那一条。预置库不一定还在（按设计可删），
-- 不在时这句影响 0 行。
UPDATE collections SET renew_from = 'schedule' WHERE key = 'vps';
