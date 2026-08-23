-- VPS「规格」模板串多显示端口速率与流量；段首字段为空时整段自动不出现，没填的机器显示不变。
-- 只在模板串仍是当初播种的那份时才改，用户自己调过的保留他的。比的是 json_extract 出来的内容
-- 而不是 config 整段的字节——同一份 JSON 重存一次冒号后的空格就变了，按字节比会静默失配。
UPDATE fields
   SET config = '{"tpl":"{cores}C / {ram_gb}G / {storage_gb}G {storage_type} / {port_gbps}Gbps / {traffic_tb}TB"}'
 WHERE tbl = 'vps' AND key = 'spec'
   AND json_extract(config, '$.tpl') = '{cores}C / {ram_gb}G / {storage_gb}G {storage_type}';
