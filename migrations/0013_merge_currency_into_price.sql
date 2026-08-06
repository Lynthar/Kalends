-- 币种并进费用格：填金额的同时选币种，不再单独占一列。
--
-- 数据层什么都没变——items.price 与 items.currency 仍是两个真列，原币入账那条不动。
-- 变的只是「界面上有哪些列」：把 currency 的字段注册撤掉，它就不再是一列，
-- 值改由费用格的复合编辑器和详情表单里的同一枚控件写入（seed_fields 也不再播它）。
--
-- 只删 src='col' 的那些。用户自己加过名叫 currency 的自定义列（src='extra'）是另一回事，
-- 与这次合并无关，留着。
DELETE FROM fields WHERE key = 'currency' AND src = 'col';
