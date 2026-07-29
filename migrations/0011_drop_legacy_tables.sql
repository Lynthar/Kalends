-- 删掉库泛化前的旧三表。迁移 0007 把它们的数据拷进 collections+items 后原样留着，
-- 为的是「部署后未录入新数据前能回滚旧二进制」——那个窗口早就关了：前端只认
-- /api/collections/{key}/items 这套端点，旧端点连同适配层已删，要回退只能连数据一起回到快照。
-- 留着的代价是每天导出 66K 停在迁移当天的过期副本，且看着像还在用的表。
-- 没有外键指进来（price_history 已随 0010 一起删；renewal_ledger 与 notification_log
-- 用的是松散的 kind + item_id，0007 已把 id 重指到 items），索引随表一起消失。
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS sim_cards;
DROP TABLE IF EXISTS vps_instances;
