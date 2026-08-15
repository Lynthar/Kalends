-- 我的评分从 5 星制改成 10 分制：与 `douban_rating` 同一把尺，两个数字并排就能比。
-- 1–5 等比换算成 2–10，语感也对得上（4 星 → 8 分，正是豆瓣那边 4 星的分值）。

-- 0 分那批要先摘出去。它们是 2026-07 从 Notion 导进来的，当时还没有评分范围校验；
-- 界面上 0 分与「没评分」长得一模一样（零颗亮星）、筛选里也一并归进「（空）」，
-- 而现在的写入口只收 1–5 —— 也就是说这些行**存不回去**（改任何一个字段都会被 400 拒）。
-- 它们表达的本来就是「没评分」，转成 NULL 让数据说实话，顺带把这些行从锁死状态里救出来。
UPDATE media_items SET rating = NULL WHERE rating = 0;

UPDATE media_items SET rating = rating * 2 WHERE rating IS NOT NULL;
