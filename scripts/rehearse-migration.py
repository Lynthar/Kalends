#!/usr/bin/env python3
"""搬数据的迁移先演练，别直接上生产。

从一个正在运行的实例（只读 GET）把行数据拉下来，用仓库里真实的迁移文件在本地重建一个
指定版本的数据库；然后用新版本的二进制启动它，让待验证的迁移在这份副本上跑一遍，再逐项核对。

    # 1. 重建一份停在迁移 7 的副本（假设要演练迁移 8）
    python3 scripts/rehearse-migration.py http://<host>:<port> /tmp/rehearse --upto 7

    # 2. 用新二进制跑迁移
    KALENDS_DATA=/tmp/rehearse KALENDS_ADDR=127.0.0.1:4199 ./kalends

    # 3. 与原实例对拍（迁移不该改变任何对外可见的数据）
    python3 scripts/api-diff.py http://<host>:<port> http://127.0.0.1:4199

只读取源实例，不写任何东西；重建出来的副本里没有 settings（含令牌与渠道配置）。
"""
import argparse
import json
import os
import shutil
import sqlite3
import sys
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def get(base, path):
    with urllib.request.urlopen(base.rstrip('/') + path, timeout=60) as r:
        return json.load(r)


def sql_cols(conn, table):
    return [r[1] for r in conn.execute(f'PRAGMA table_info({table})')]


def load(conn, table, rows, log):
    """把接口返回的行塞进表，只取表里真有的列；对象/数组列存 JSON 文本。

    先清空：迁移本身会播种 collections 与 fields，副本要的是源实例的精确拷贝而不是两者相加。
    """
    avail = set(sql_cols(conn, table))
    if not avail:
        log(f'  {table}: 表不存在，跳过')
        return
    conn.execute(f'DELETE FROM {table}')
    n = 0
    for row in rows:
        keys = [k for k in row if k in avail]
        vals = []
        for k in keys:
            v = row[k]
            vals.append(json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v)
        conn.execute(
            f"INSERT INTO {table}({','.join(keys)}) VALUES({','.join('?' * len(keys))})", vals)
        n += 1
    log(f'  {table}: {n} 行')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('source', help='源实例的基地址，例如 http://127.0.0.1:4180')
    ap.add_argument('outdir', help='副本数据目录（会被清空重建）')
    ap.add_argument('--upto', type=int, required=True,
                    help='重建到第几号迁移为止（待演练的那个迁移号减一）')
    a = ap.parse_args()
    log = print

    files = sorted(f for f in os.listdir(f'{REPO}/migrations') if f.endswith('.sql'))
    if a.upto < 1 or a.upto > len(files):
        sys.exit(f'--upto 应在 1..{len(files)} 之间，实到 {a.upto}')

    shutil.rmtree(a.outdir, ignore_errors=True)
    os.makedirs(a.outdir)
    db = os.path.join(a.outdir, 'kalends.db')
    conn = sqlite3.connect(db)
    log(f'按仓库里的迁移文件建到第 {a.upto} 号：')
    for f in files[:a.upto]:
        log(f'  {f}')
        conn.executescript(open(f'{REPO}/migrations/{f}').read())
    conn.execute(f'PRAGMA user_version = {a.upto}')

    log(f'\n从 {a.source} 拉行数据（只读）：')
    colls = get(a.source, '/api/collections')
    load(conn, 'collections', colls, log)
    items = [it for c in colls for it in get(a.source, f"/api/collections/{c['key']}/items")]
    load(conn, 'items', items, log)
    for path, table in (('/api/media', 'media_items'), ('/api/ledger', 'renewal_ledger'),
                        ('/api/fields', 'fields')):
        try:
            load(conn, table, get(a.source, path), log)
        except Exception as e:  # 模块未启用时对应端点不挂载
            log(f'  {table}: 取不到（{type(e).__name__}），跳过')
    conn.commit()

    log(f'\n副本就绪：{db}（user_version={a.upto}）')
    log('接下来用新二进制指向这个目录启动，迁移会在副本上跑；再用 scripts/api-diff.py 与源实例对拍。')


main()
