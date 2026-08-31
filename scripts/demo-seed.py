#!/usr/bin/env python3
"""造一份合成数据喂给真后端，把只读演示要用的接口响应导出成快照。

演示站点没有后端，界面全靠这份快照渲染——所以它必须由真二进制产出：到期日、
支出汇总、折算都是引擎算出来的，前端一行业务逻辑都不用复刻，也就不会漂移。

    python3 scripts/demo-seed.py --bin target/release/kalends --out site/demo-data.js

数据是合成的通用值，日期按运行当天相对生成，所以快照过期就会显得陈旧——
重建由 pages 工作流每月跑一次。
"""
import argparse
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import date, timedelta

TODAY = date.today()


def day(offset):
    return (TODAY + timedelta(days=offset)).isoformat()


# 演示站点只发 GET，这几条就是界面会请求的全部
EXPORT_PATHS = [
    '/api/overview',
    '/api/settings',
    '/api/fx',
    '/api/fields',
    '/api/collections',
    '/api/collections/templates',
    '/api/ledger',
    '/api/notify/log',
]

# 订阅：演示周期档位、多币种、买断，以及"服务→套餐档位"的两层结构
SUBS = [
    dict(name='Netflix', status='Active', price=15.49, currency='USD', cycle='monthly',
         next_renewal=day(6), url='https://www.netflix.com',
         extra={'category': '影音', 'payment_method': '信用卡', 'account': 'demo@example.com'}),
    dict(name='Spotify', status='Active', price=10.99, currency='USD', cycle='monthly',
         next_renewal=day(13), extra={'category': '影音', 'payment_method': '信用卡'}),
    dict(name='iCloud+', status='Active', price=21.0, currency='CNY', cycle='monthly',
         next_renewal=day(2), extra={'category': '存储', 'payment_method': '支付宝'}),
    dict(name='JetBrains All Products', status='Active', price=289.0, currency='USD',
         cycle='annual', next_renewal=day(74),
         extra={'category': '开发', 'payment_method': '信用卡'}),
    dict(name='Adobe Creative Cloud', status='Ending', price=52.99, currency='USD',
         cycle='monthly', next_renewal=day(21),
         notes='这一期到期就不续了',
         extra={'category': '设计'}),
    dict(name='Sublime Text', status='Active', price=99.0, currency='USD', cycle='lifetime',
         extra={'category': '开发'}),
    dict(name='Obsidian Sync', status='Unused', price=4.0, currency='USD', cycle='monthly',
         extra={'category': '效率'}),
]

# Proton 演示比价目录：父是在用的那档，子全是 Deferred 备选，不进统计也不进时间线
PROTON = dict(name='Proton', status='Active', price=9.99, currency='EUR', cycle='monthly',
              next_renewal=day(31), url='https://proton.me',
              extra={'category': '隐私', 'payment_method': '信用卡'})
PROTON_TIERS = [
    dict(name='Mail Plus', status='Deferred', price=3.99, currency='EUR', cycle='monthly',
         extra={'category': '隐私'}),
    dict(name='Proton Duo', status='Deferred', price=14.99, currency='EUR', cycle='monthly',
         extra={'category': '隐私'}),
    dict(name='Proton Family', status='Deferred', price=23.99, currency='EUR', cycle='monthly',
         extra={'category': '隐私'}),
]

# VPS：上次续费 + 周期的到期模型，规格列由模板字段自己拼出来
VPS = [
    dict(name='Hetzner', status='Active', price=4.51, currency='EUR', cycle='monthly',
         last_renewed=day(-9), url='https://www.hetzner.com',
         extra={'product': 'CX22', 'locations': ['Falkenstein'], 'purpose': '自建服务',
                'routes': ['直连'], 'cores': 2, 'ram_gb': 4, 'storage_gb': 40,
                'storage_type': 'NVMe', 'port_gbps': 1, 'traffic_tb': 20, 'ipv6': 1}),
    dict(name='RackNerd', status='Active', price=16.88, currency='USD', cycle='annual',
         last_renewed=day(-288),
         extra={'product': '1G KVM', 'locations': ['Los Angeles'], 'purpose': '备用',
                'routes': ['直连'], 'cores': 1, 'ram_gb': 1, 'storage_gb': 20,
                'storage_type': 'SSD', 'port_gbps': 1, 'traffic_tb': 2, 'ipv6': 1}),
    dict(name='BuyVM', status='Active', price=3.5, currency='USD', cycle='monthly',
         last_renewed=day(-24),
         extra={'product': 'Slice 1G', 'locations': ['Las Vegas'], 'purpose': '存储',
                'routes': ['直连'], 'cores': 1, 'ram_gb': 1, 'storage_gb': 20,
                'storage_type': 'SSD', 'extra_storage': 'Block Storage 256G',
                'port_gbps': 1, 'traffic_tb': 5, 'ipv6': 1}),
    dict(name='Vultr', status='Ended', price=6.0, currency='USD', cycle='monthly',
         last_renewed=day(-96), extra={'product': 'Regular 1G', 'locations': ['Tokyo']}),
]

INSURANCE = [
    dict(name='百万医疗', status='Active', price=1280.0, currency='CNY', cycle='annual',
         next_renewal=day(48),
         extra={'insurer': '示例保险', 'policy_type': '医疗', 'insured': '本人',
                'coverage': 3000000, 'policy_no': 'POL-0001'}),
    dict(name='车险', status='Active', price=4200.0, currency='CNY', cycle='annual',
         next_renewal=day(133),
         extra={'insurer': '示例财险', 'policy_type': '车险', 'insured': '本人',
                'coverage': 1000000, 'policy_no': 'POL-0002'}),
    dict(name='旅行意外险', status='Planned', price=180.0, currency='CNY', cycle='annual',
         extra={'insurer': '示例保险', 'policy_type': '旅行', 'insured': '家属'}),
]

DEMO_SETTINGS = {
    'fx.display': 'CNY',
    'ui.upcoming_days': '30',
}


class Client:
    def __init__(self, base):
        self.base = base.rstrip('/')

    def req(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.base + path, data=data, method=method,
                                   headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(r, timeout=30) as resp:
            raw = resp.read()
        return json.loads(raw) if raw else None

    def get(self, path):
        return self.req('GET', path)

    def post(self, path, body):
        return self.req('POST', path, body)

    def patch(self, path, body):
        return self.req('PATCH', path, body)


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def wait_ready(base, proc, timeout=30):
    """轮询 /api/health 直到服务起来；进程中途退出就立刻报错，别干等到超时"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            sys.exit(f'kalends 启动即退出（exit {proc.returncode}）')
        try:
            with urllib.request.urlopen(base + '/api/health', timeout=2):
                return
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            time.sleep(0.2)
    sys.exit('kalends 没能在超时内就绪')


def create(cli, key, item, parent_id=None):
    body = {k: v for k, v in item.items()}
    if parent_id is not None:
        body['parent_id'] = parent_id
    return cli.post(f'/api/collections/{key}/items', body)['id']


def seed(cli):
    colls = {c['key']: c for c in cli.get('/api/collections')}

    # 预置三库可删——这份演示不展示号码保号，SIM 库整个撤掉
    if 'sims' in colls:
        cli.req('DELETE', f"/api/collections/{colls['sims']['id']}")

    # 库键由后端的 next_coll_key 分配，传进去的会被忽略——照着返回值走
    ins = cli.post('/api/collections', {'name': '保险', 'template': 'insurance'})['key']

    for item in SUBS:
        create(cli, 'subs', item)
    proton = create(cli, 'subs', PROTON)
    for tier in PROTON_TIERS:
        create(cli, 'subs', tier, parent_id=proton)
    for item in VPS:
        create(cli, 'vps', item)
    for item in INSURANCE:
        create(cli, ins, item)

    cli.req('PUT', '/api/settings', DEMO_SETTINGS)


def seed_ledger(cli):
    """记两笔账让台账页有内容；renew 会改写日期，所以记完把日期按设计值补回去"""
    items = cli.get('/api/collections/vps/items')
    for name, last in (('Hetzner', day(-9)), ('BuyVM', day(-24))):
        it = next((x for x in items if x['name'] == name), None)
        if it is None:
            continue
        cli.post(f"/api/items/{it['id']}/renew", {})
        cli.patch(f"/api/items/{it['id']}", {'last_renewed': last})


SECRET_KEY = re.compile(r'token|password|secret', re.I)


def scrub(path, value):
    """演示快照进公开站点：像密钥的设置值一律不带出来"""
    if path != '/api/settings':
        return value
    return {k: ('' if SECRET_KEY.search(k) else v) for k, v in value.items()}


def export(cli):
    snap = {}
    for path in EXPORT_PATHS:
        snap[path] = scrub(path, cli.get(path))
    for c in cli.get('/api/collections'):
        p = f"/api/collections/{c['key']}/items"
        snap[p] = cli.get(p)
    return snap


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bin', default='target/release/kalends', help='kalends 二进制路径')
    ap.add_argument('--out', default='site/demo-data.js', help='快照输出路径')
    args = ap.parse_args()

    if not os.access(args.bin, os.X_OK):
        sys.exit(f'找不到可执行的 {args.bin}——先 cargo build --release')

    port = free_port()
    base = f'http://127.0.0.1:{port}'
    with tempfile.TemporaryDirectory(prefix='kalends-demo-') as data_dir:
        env = {**os.environ, 'KALENDS_DATA': data_dir, 'KALENDS_ADDR': f'127.0.0.1:{port}'}
        env.pop('KALENDS_PIN', None)
        proc = subprocess.Popen([os.path.abspath(args.bin)], env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            wait_ready(base, proc)
            cli = Client(base)
            seed(cli)
            seed_ledger(cli)
            snap = export(cli)
        finally:
            proc.terminate()
            proc.wait(timeout=10)

    payload = json.dumps(snap, ensure_ascii=False, separators=(',', ':'))
    with open(args.out, 'w', encoding='utf-8') as f:
        f.write('/* 由 scripts/demo-seed.py 从真后端导出，勿手改。 */\n')
        f.write(f'const DEMO_DATA = {payload};\n')
        f.write(f'const DEMO_BUILT = {json.dumps(TODAY.isoformat())};\n')
    print(f'{args.out}  {len(payload) / 1024:.0f} KB  {len(snap)} 条响应')


if __name__ == '__main__':
    main()
