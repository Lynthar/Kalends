-- 三张续费表状态词表统一为英文（媒体词表不动）：
-- 启用→Active，准备→Planned，未启用→Unused，预结束→Ending，已结束→Ended；订阅本就是英文。
UPDATE sim_cards SET status = CASE status
  WHEN '启用' THEN 'Active'
  WHEN '准备' THEN 'Planned'
  WHEN '未启用' THEN 'Unused'
  WHEN '已结束' THEN 'Ended'
  ELSE status END;
UPDATE vps_instances SET status = CASE status
  WHEN '启用' THEN 'Active'
  WHEN '准备' THEN 'Planned'
  WHEN '预结束' THEN 'Ending'
  WHEN '未启用' THEN 'Unused'
  WHEN '已结束' THEN 'Ended'
  ELSE status END;
