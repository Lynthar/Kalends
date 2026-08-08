-- 三个预置库的域字段收归 builtin=0，与模板建出来的库同权。
--
-- 背景：订阅 / SIM / VPS 此前只由迁移 0007/0008 一次性建出来，模板里没有它们——删掉就
-- 建不回来，也建不了第二个同类库。现在 collections::TEMPLATES 补齐了这三个模板，而模板
-- 播下来的域字段一律 builtin=0。这条迁移把已存在的三库对齐到同一形态，两边从此没有差别。
--
-- 为什么 builtin 这个标记要翻：它是"这列归不归用户管"的判据之一。前端 optionsEditable
-- 与后端 resolve() 都靠它放行选项编辑，于是预置库的自由词表字段只能靠一张硬编码白名单
-- （前端 OPT_EDITABLE / 后端 BUILTIN_OPT）逐个点名。翻成 0 之后白名单整个作废，两处删掉。
--
-- 顺带修掉一处不一致：vps.storage_type 是 src='extra'，按 30a9bef 的判据可改名可删除，
-- 却因为不在白名单里而不能编辑选项。收归之后它与其他域字段一样可管。
--
-- 判据用"不属于通用字段集"而不是 src='extra'：vps.spec 是 src='calc' 的模板列，同样是
-- 域字段（模板里就这么声明），只有通用字段才该保持 builtin=1。
UPDATE fields
   SET builtin = 0
 WHERE tbl IN ('subs', 'sims', 'vps')
   AND key NOT IN (
     'name', 'status', 'price', 'cycle', 'next_renewal',
     'last_renewed', 'left', 'notes', 'cycle_days', 'url'
   );
