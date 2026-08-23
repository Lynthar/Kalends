-- 我的评分从 5 星制改成 10 分制：与 `douban_rating` 同一把尺，两个数字并排就能比。
-- 1–5 等比换算成 2–10，语感也对得上（4 星 → 8 分，正是豆瓣那边 4 星的分值）。

-- 0 分那批要先摘成 NULL：它们表达的本来就是「没评分」（界面上与没评分长得一样），
-- 而写入口不收 0 —— 不转的话这些行改任何字段都会被 400 拒，等于锁死在库里。
UPDATE media_items SET rating = NULL WHERE rating = 0;

UPDATE media_items SET rating = rating * 2 WHERE rating IS NOT NULL;
