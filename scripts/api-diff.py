#!/usr/bin/env python3
"""对拍两个实例的接口输出，逐字段列出差异。

用途：改动了数据模型或引擎之后，拿同一份数据分别喂给旧、新两个版本，
差异应当只出现在你预期会变的字段上——其余任何一处不一致都是回归。

    python3 scripts/api-diff.py http://old-host:port http://new-host:port
    python3 scripts/api-diff.py A B --ignore updated_at,due,days_left

两边都只发 GET。退出码非零表示存在未被 --ignore 排除的差异。
"""
import argparse
import json
import sys
import urllib.request

fails = []


def get(base, path):
    with urllib.request.urlopen(base.rstrip('/') + path, timeout=60) as r:
        return json.load(r)


def check(label, ok, extra=''):
    print(('PASS ' if ok else 'FAIL ') + label + ('' if ok else '  ' + str(extra)))
    if not ok:
        fails.append(label)


def blank(v):
    return v in (None, '', [], {})


def diff_rows(a, b, label, ignore):
    """按 id 对齐两侧的行，逐字段比对"""
    ma = {r['id']: r for r in a}
    mb = {r['id']: r for r in b}
    check(f'{label} id 集合一致（{len(mb)} 条）', set(ma) == set(mb),
          f'仅 A 有 {sorted(set(ma) - set(mb))[:5]}，仅 B 有 {sorted(set(mb) - set(ma))[:5]}')
    diffs = []
    for i in sorted(set(ma) & set(mb)):
        for f in sorted(set(ma[i]) | set(mb[i])):
            if f in ignore:
                continue
            va, vb = ma[i].get(f), mb[i].get(f)
            if blank(va) and blank(vb):
                continue          # 空值的不同写法（null / '' / []）视作相同
            if va != vb:
                diffs.append(f'id {i}.{f}: A {va!r} / B {vb!r}')
    check(f'{label} 逐字段一致', not diffs, diffs[:8])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('a', help='A 侧基地址（通常是旧版本）')
    ap.add_argument('b', help='B 侧基地址（通常是新版本）')
    ap.add_argument('--ignore', default='updated_at',
                    help='逗号分隔的字段名，比对时跳过（默认 updated_at）')
    args = ap.parse_args()
    ignore = {x.strip() for x in args.ignore.split(',') if x.strip()}
    A, B = args.a, args.b

    print('=== 计数 ===')
    ha, hb = get(A, '/api/health'), get(B, '/api/health')
    check(f"计数一致 {hb['counts']}", ha['counts'] == hb['counts'], f"A {ha['counts']}")

    print('\n=== 库清单 ===')
    ca, cb = get(A, '/api/collections'), get(B, '/api/collections')
    check('库清单完全一致', ca == cb, f'A {ca}\nB {cb}')

    print('\n=== 各库条目 ===')
    for c in cb:
        k = c['key']
        diff_rows(get(A, f'/api/collections/{k}/items'),
                  get(B, f'/api/collections/{k}/items'), f"{c['name']}({k})", ignore)

    print('\n=== 到期时间线与支出 ===')
    oa, ob = get(A, '/api/overview'), get(B, '/api/overview')
    check('今日一致', oa['today'] == ob['today'], f"A {oa['today']} B {ob['today']}")
    sig = lambda ov: sorted((u['kind'], u['id'], u['name'], u['due'], u['days_left'],
                             u['cycle'], u.get('verb'), bool(u.get('muted')))
                            for u in ov['upcoming'])
    ta, tb = sig(oa), sig(ob)
    check(f'时间线 {len(tb)} 项完全一致', ta == tb, [x for x in set(ta) ^ set(tb)][:6])
    check('分币种支出一致', oa['totals'] == ob['totals'], f"A {oa['totals']} B {ob['totals']}")

    print('\n=== 台账与字段注册表 ===')
    check('台账一致', get(A, '/api/ledger') == get(B, '/api/ledger'))
    fa, fb = get(A, '/api/fields'), get(B, '/api/fields')
    check(f'字段注册表一致（{len(fb)} 个字段）', fa == fb,
          f'A 有 {len(fa)} 个 / B 有 {len(fb)} 个')

    print('\n' + (f'{len(fails)} 项不符：' + '; '.join(fails) if fails else '两侧完全一致'))
    sys.exit(1 if fails else 0)


main()
