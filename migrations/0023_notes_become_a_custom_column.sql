-- 备注从条目真列搬进 extra（键仍是 notes），注册表里改成可改名、可删的自定义列，删掉真列。
UPDATE items SET extra = json_set(coalesce(nullif(extra, ''), '{}'), '$.notes', notes)
 WHERE notes IS NOT NULL AND notes <> '';
UPDATE fields SET src = 'extra', builtin = 0 WHERE key = 'notes';
ALTER TABLE items DROP COLUMN notes;
