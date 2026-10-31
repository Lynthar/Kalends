-- 库的 id 也从 id_seq 发号，删掉的号不再发出。
INSERT INTO id_seq(name, seq) SELECT 'collections', coalesce(max(id), 0) FROM collections;
