-- 删掉库泛化前的旧三表：0007 留它们是为了回滚旧二进制，而旧端点连同适配层已删，那个窗口早关了。
-- 删得安全的判据是没有外键指进来——price_history 随 0010 已删，台账与通知日志走松散的 kind + item_id。
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS sim_cards;
DROP TABLE IF EXISTS vps_instances;
