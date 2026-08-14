#!/usr/bin/env python3
"""Notion → Kalends 迁移示例脚本（豆瓣风格影视库 / 订阅 / SIM / VPS 表）。

用法：python3 notion-import.py <movies|subs|sims|vps> <结果文件...>
结果文件为 Notion MCP 查询输出（SQL 别名列或 view 模式原始列名均可，自动识别改名）。
目标实例默认本机，可用 KALENDS_URL 覆盖；设了 PIN 时用 KALENDS_PIN 传入。
按自己的 Notion 列名改 RENAMES 映射即可复用。

三个续费库走通用接口 POST /api/collections/{key}/items：引擎要用的字段是 items 的真列，
域字段（分类、支付方式、VPS 的地点线路规格…）一律进 extra，键即字段键——由 item_body 分流。
目标库得先存在（预置的 subs/sims/vps，或按模板新建的库，把库键传给 add_item）。
"""
import datetime as dt
import json
import os
import re
import sys
import urllib.request

BASE = os.environ.get('KALENDS_URL', 'http://127.0.0.1:4180')
PIN = os.environ.get('KALENDS_PIN', '')


def load_rows(path):
    text = open(path, encoding='utf-8').read()
    obj = json.loads(text[text.index('{'):])
    return obj['results']


def post(path, payload, method='POST'):
    headers = {'Content-Type': 'application/json'}
    if PIN:
        headers['X-Kalends-Pin'] = PIN
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
                                 headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def clean(d):
    return {k: v for k, v in d.items() if v is not None and v != ''}


# ── 条目的形状：引擎要用的字段是 items 的真列，域字段一律进 extra（键即字段键）──
REAL_COLS = {'name', 'parent_id', 'status', 'price', 'currency', 'cycle', 'cycle_days',
             'next_renewal', 'last_renewed', 'url', 'notes', 'logo'}
# 三个续费库的状态词表 2026-07 起统一为英文（迁移 0006）；Notion 导出里还是中文
STATUS_EN = {'启用': 'Active', '准备': 'Planned', '未启用': 'Unused',
             '预结束': 'Ending', '已结束': 'Ended'}


def item_body(d):
    """把一个平铺的字段字典拆成 {真列..., extra: {域字段...}}。"""
    body = clean({k: v for k, v in d.items() if k in REAL_COLS})
    extra = clean({k: v for k, v in d.items() if k not in REAL_COLS})
    if extra:
        body['extra'] = extra
    return body


def add_item(coll, d):
    """往某个库里加一条。coll 是库键（subs / sims / vps，或自建库的 k<N>）。"""
    return post(f'/api/collections/{coll}/items', item_body(d))


# view 模式返回原始列名 → 统一改名为 SQL 别名版；formulaResult 引用列直接丢弃
RENAMES = {
    'movies': {'电影名': 'title', '又名': 'orig_title', '年份': 'year', '我的评分': 'rating',
               'date:标记日期:start': 'marked_at', '我的短评': 'review', '短评们': 'others_reviews',
               '类型': 'genres', '导演': 'directors', '编剧': 'writers', '主演': 'actors',
               '制片国家/地区': 'countries', '语言': 'languages', '片长': 'runtime',
               '上映/首播日期': 'release_date', '豆瓣编号': 'douban_id', '豆瓣链接': 'douban_url',
               '豆瓣评分': 'douban_rating', '评分人数': 'douban_votes', 'IMDB编号': 'imdb_id'},
    'subs': {'项目名称': 'name', '订阅状态': 'status', '类型': 'category', '计费周期': 'cycle_raw',
             '价格': 'price_usd', 'date:续费日期:start': 'next_renewal', '支付方式': 'payment_method',
             '备注': 'notes', '上级 项目': 'parent_url', 'url': 'url'},
    'sims': {'运营商和国家': 'name', '号码': 'phone_number', '状态': 'status', '形式': 'forms',
             '保号策略': 'keepalive_action', '周期天数': 'cycle_days', '保号周期': 'cycle_raw',
             'date:上次续费:start': 'last_renewed', 'date:续费日期:start': 'next_date', '备注': 'notes'},
    'vps': {'商家': 'vendor', '产品': 'product', '状态': 'status', '用途': 'purpose',
            '地点': 'locations', '线路': 'routes', 'Core': 'cores', 'RAM': 'ram_gb',
            'Storage(GB)': 'storage_gb', '存储类型': 'storage_type', '附加存储': 'extra_storage',
            'Port(Gbps)': 'port_gbps', 'Traffic(TB)': 'traffic_tb', 'ipv6': 'ipv6_raw',
            '费用': 'price', '付费周期': 'cycle_raw', '周期天数': 'cycle_days',
            'date:上次续费:start': 'last_renewed'},
}


def maybe_rename(rows, table):
    mapping = RENAMES[table]
    out = []
    for r in rows:
        if not any(k in r for k in mapping):
            out.append(r)
            continue
        nr = {}
        for k, v in r.items():
            if k in mapping:
                nr[mapping[k]] = v
            elif k == 'url':
                nr['url'] = v
        for k in ('marked_at', 'next_renewal', 'last_renewed', 'next_date'):
            if isinstance(nr.get(k), str):
                nr[k] = nr[k][:10]
        # Notion 的数字一律是浮点：整数值就还原成整数，否则核数内存这些域字段会
        # 一路以 "2.0" 的样子进 extra 并这么显示在表格里
        for k, v in list(nr.items()):
            if isinstance(v, float) and v.is_integer():
                nr[k] = int(v)
        out.append(nr)
    return out


# ── 影视 ──
SERIES_RE = re.compile(r'第[一二三四五六七八九十百\d]+季|Season\s*\d', re.I)


def movie_kind(r):
    if '动画' in (r.get('genres') or ''):
        return '动画'
    if '集' in (r.get('runtime') or '') or SERIES_RE.search(r.get('title') or ''):
        return '剧集'
    return '电影'


def transform_movie(r):
    out = clean({k: r.get(k) for k in (
        'title', 'orig_title', 'year', 'rating', 'marked_at', 'review', 'others_reviews',
        'genres', 'directors', 'writers', 'actors', 'countries', 'languages', 'runtime',
        'release_date', 'douban_url', 'douban_rating', 'douban_votes', 'imdb_id')})
    if r.get('douban_id') is not None:
        out['douban_id'] = str(int(r['douban_id']))
    out['kind'] = movie_kind(r)
    out['status'] = '看过'
    return out


def import_movies(files):
    rows, skipped_notitle = [], 0
    for f in files:
        for r in maybe_rename(load_rows(f), 'movies'):
            if not (r.get('title') or '').strip():
                skipped_notitle += 1
                continue
            rows.append(transform_movie(r))
    total = {'added': 0, 'skipped': 0, 'failed': 0}
    for i in range(0, len(rows), 100):
        res = post('/api/media/import', rows[i:i + 100])
        for k in total:
            total[k] += res.get(k, 0)
        print(f'  media 批 {i // 100 + 1}: {res}')
    print(f'影视：待导 {len(rows)}（无标题跳过 {skipped_notitle}）→ {total}')


# ── 订阅 ──
CYCLE = {'Weekly': 'weekly', 'Monthly': 'monthly', 'Quarterly': 'quarterly',
         'SemiAnnually': 'semiannual', 'Semi-annually': 'semiannual',
         'Annually': 'annual', 'Triennial': 'triennial', 'Lifetime': 'lifetime'}
CUR_SIGN = {'¥': 'CNY', '￥': 'CNY', '€': 'EUR', '£': 'GBP', '￡': 'GBP'}


def orig_price(price_usd, notes):
    # 从备注还原原币价（如 "¥53 ≈ $7.36"）；价格为 0 的免费档不做还原
    if notes and price_usd:
        m = re.search(r'([¥￥€£￡])\s*(\d+(?:\.\d+)?)', notes)
        if m:
            return float(m.group(2)), CUR_SIGN[m.group(1)], True
    if price_usd is None:
        return None, None, False
    return price_usd, 'USD', False


def import_subs(files):
    rows = [r for f in files for r in maybe_rename(load_rows(f), 'subs')]
    url2id, bodies, converted = {}, {}, []
    for r in rows:
        name = (r.get('name') or '').strip()
        if not name:
            continue
        price, cur, conv = orig_price(r.get('price_usd'), r.get('notes'))
        if conv:
            converted.append(f"{name}: USD {r.get('price_usd')} → {cur} {price}")
        body = {
            'name': name, 'status': r.get('status') or 'Planned',
            'category': r.get('category'), 'cycle': CYCLE.get(r.get('cycle_raw') or ''),
            'price': price, 'currency': cur,
            'next_renewal': r.get('next_renewal'),
            'payment_method': r.get('payment_method'), 'notes': r.get('notes'),
        }
        res = add_item('subs', body)
        url2id[r['url']] = res['id']
        bodies[r['url']] = body
    linked = 0
    for r in rows:
        raw = r.get('parent_url')
        if not raw or r['url'] not in url2id:
            continue
        try:
            purls = json.loads(raw) if raw.startswith('[') else [raw.strip('"')]
        except Exception:
            purls = [raw]
        pid = next((url2id[u] for u in purls if u in url2id), None)
        if pid:
            # 条目更新是局部更新：只发这一个键，其余字段后端原样保留
            post(f"/api/items/{url2id[r['url']]}", {'parent_id': pid}, 'PATCH')
            linked += 1
    print(f'订阅：导入 {len(url2id)}，父子关系 {linked}，原币还原 {len(converted)} 条：')
    for line in converted:
        print('  ', line)


# ── SIM ──
CYCLE_DAYS = {'Weekly': 7, 'Monthly': 30, 'Quarterly': 91,
              'SemiAnnually': 182, 'Semi-annually': 182, 'Annually': 365}


def import_sims(files):
    n, derived = 0, []
    for f in files:
        for r in maybe_rename(load_rows(f), 'sims'):
            name = (r.get('name') or '').strip()
            if not name:
                continue
            cycle_days = r.get('cycle_days') or CYCLE_DAYS.get(r.get('cycle_raw') or '')
            last = r.get('last_renewed')
            if not last and r.get('next_date') and cycle_days:
                last = (dt.date.fromisoformat(r['next_date'])
                        - dt.timedelta(days=cycle_days)).isoformat()
                derived.append(f'{name}: 由续费日期倒推上次续费 {last}')
            forms = r.get('forms')
            try:
                forms = json.loads(forms) if isinstance(forms, str) else (forms or [])
            except Exception:
                forms = []
            raw_status = r.get('status') or '未启用'
            add_item('sims', {
                'name': name, 'phone_number': r.get('phone_number'),
                'status': STATUS_EN.get(raw_status, raw_status), 'forms': forms,
                'keepalive_action': r.get('keepalive_action'),
                # 保号周期并进了通用周期模型：自定义天数 = cycle 'days' + cycle_days
                'cycle': 'days' if cycle_days else None,
                'cycle_days': cycle_days, 'last_renewed': last, 'notes': r.get('notes'),
            })
            n += 1
    print(f'SIM：导入 {n}；倒推 {len(derived)} 条：')
    for line in derived:
        print('  ', line)


# ── VPS ──
def import_vps(files):
    n = 0
    for f in files:
        for r in maybe_rename(load_rows(f), 'vps'):
            vendor = (r.get('vendor') or '').strip()
            if not vendor:
                continue
            cycle = CYCLE.get(r.get('cycle_raw') or '')
            cycle_days = r.get('cycle_days')
            if not cycle and cycle_days:
                cycle = 'days'

            def arr(key):
                v = r.get(key)
                try:
                    return json.loads(v) if isinstance(v, str) else (v or [])
                except Exception:
                    return []
            raw_status = r.get('status') or '未启用'
            add_item('vps', {
                # 商家是条目名，产品名走库属性 subtitle（VPS 的「商家 · 产品」）
                'name': vendor, 'product': r.get('product'),
                'status': STATUS_EN.get(raw_status, raw_status), 'purpose': r.get('purpose'),
                'locations': arr('locations'), 'routes': arr('routes'),
                'cores': r.get('cores'), 'ram_gb': r.get('ram_gb'),
                'storage_gb': r.get('storage_gb'), 'storage_type': r.get('storage_type'),
                'extra_storage': r.get('extra_storage'), 'port_gbps': r.get('port_gbps'),
                'traffic_tb': r.get('traffic_tb'),
                'ipv6': 1 if r.get('ipv6_raw') == '__YES__' else 0,
                'price': r.get('price'),
                'currency': 'USD' if r.get('price') is not None else None,
                'cycle': cycle, 'cycle_days': cycle_days,
                'last_renewed': r.get('last_renewed'),
            })
            n += 1
    print(f'VPS：导入 {n}')


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    {'movies': import_movies, 'subs': import_subs,
     'sims': import_sims, 'vps': import_vps}[sys.argv[1]](sys.argv[2:])
