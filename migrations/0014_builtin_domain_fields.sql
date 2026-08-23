-- 三个预置库的域字段收归 builtin=0，与模板建出来的库同权；此后 builtin 只区分通用字段与域字段。
-- 判据用"不属于通用字段集"而不是 src='extra'：vps.spec 是 src='calc' 的模板列，同样是域字段，
-- 只有通用字段才该保持 builtin=1。
UPDATE fields
   SET builtin = 0
 WHERE tbl IN ('subs', 'sims', 'vps')
   AND key NOT IN (
     'name', 'status', 'price', 'cycle', 'next_renewal',
     'last_renewed', 'left', 'notes', 'cycle_days', 'url'
   );
