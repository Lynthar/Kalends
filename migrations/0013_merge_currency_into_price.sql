-- 币种并进费用格：撤掉 currency 的字段注册，它不再是一列；数据层不动（price 与 currency 仍是真列）。
-- 只删 src='col' 的那条——用户自己加过的同名自定义列（src='extra'）与这次合并无关，留着。
DELETE FROM fields WHERE key = 'currency' AND src = 'col';
