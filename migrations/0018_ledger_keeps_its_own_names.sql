-- 台账要能自证：写入时把库名与条目名钉进 renewal_ledger，显示不再依赖当前条目。
-- items.id 没带 AUTOINCREMENT，SQLite 会复用删掉的号——回查当前条目会让旧账挂到新条目名下。
ALTER TABLE renewal_ledger ADD COLUMN item_name TEXT;
ALTER TABLE renewal_ledger ADD COLUMN coll_name TEXT;

-- 存量行按当前 (kind, item_id) 回填一次：这是现在拿得到的最好近似（条目还在就是准的，
-- 已经删掉的留空、界面回落到编号）。之后写入的行记的都是当时的真名。
UPDATE renewal_ledger SET
  item_name = (SELECT i.name FROM items i JOIN collections c ON c.id = i.collection_id
               WHERE i.id = renewal_ledger.item_id AND c.key = renewal_ledger.kind),
  coll_name = (SELECT c.name FROM collections c WHERE c.key = renewal_ledger.kind);
