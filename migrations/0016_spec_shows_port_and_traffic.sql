-- VPS「规格」多显示端口速率与流量。
--
-- 这两项一直有独立字段、多数机器也填了，但只进详情表单——
-- 表格上看不见，得点开条目才知道这台机器的带宽和流量。模板串多两段即可，
-- 段首字段为空时整段自动不出现，没填的机器显示不变。
--
-- 模板串同时也是就地编辑器的字段清单（前端 tplKeys），所以这一改顺带让规格格
-- 点开后能一并改端口与流量。
--
-- 只在模板串仍是当初播种的那份时才改：用户自己调过的，保留他的。
--
-- 比的是 json_extract 出来的**内容**，不是 config 整段的字节。同一份 JSON 经不同库
-- 重存一次，冒号后有没有空格就变了——按字节比会在这种无关紧要的差异上静默失配
-- （生产数据副本上实测踩过：副本里是 {"tpl": "…"}，生产是 {"tpl":"…"}）。
UPDATE fields
   SET config = '{"tpl":"{cores}C / {ram_gb}G / {storage_gb}G {storage_type} / {port_gbps}Gbps / {traffic_tb}TB"}'
 WHERE tbl = 'vps' AND key = 'spec'
   AND json_extract(config, '$.tpl') = '{cores}C / {ram_gb}G / {storage_gb}G {storage_type}';
