-- 台账要能自证：一笔账记下的是"当时付的是哪个库的哪一条"，不该在条目改名或删除之后
-- 变成别的东西。items.id 没带 AUTOINCREMENT，SQLite 会把删掉的号捡回来复用，于是
-- 「删掉旧条目、在同一个库里再建一条」就让旧账挂到了新条目名下（实测复现过）。
-- 写入时把名字钉进台账，显示就不再依赖当前条目。
ALTER TABLE renewal_ledger ADD COLUMN item_name TEXT;
ALTER TABLE renewal_ledger ADD COLUMN coll_name TEXT;

-- 存量行按当前 (kind, item_id) 回填一次：这是现在拿得到的最好近似（条目还在就是准的，
-- 已经删掉的留空、界面回落到编号）。之后写入的行记的都是当时的真名。
UPDATE renewal_ledger SET
  item_name = (SELECT i.name FROM items i JOIN collections c ON c.id = i.collection_id
               WHERE i.id = renewal_ledger.item_id AND c.key = renewal_ledger.kind),
  coll_name = (SELECT c.name FROM collections c WHERE c.key = renewal_ledger.kind);
