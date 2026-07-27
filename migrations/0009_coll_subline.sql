-- 名称格下方那行小字（VPS 显示产品名、SIM 显示号码）成为库的属性。
-- 与 subtitle 分开：subtitle 会拼进到期时间线与日历标题（VPS 需要「商家 · 产品」区分同商家多台），
-- subline 只在表格的名称格里显示（SIM 的号码不该进日历）。
ALTER TABLE collections ADD COLUMN subline TEXT;

UPDATE collections SET subline = 'product'      WHERE key = 'vps';
UPDATE collections SET subline = 'phone_number' WHERE key = 'sims';
