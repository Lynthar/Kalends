#!/usr/bin/env python3
"""把 assets/ 与 site/ 组装成 GitHub Pages 要发布的目录。

演示页就是产品界面本身，只多一份顶掉 api() 的 shim——所以这里只搬运与改写路径，
不碰 assets/ 源码。每条改写都断言命中：漏改一条就是整站白屏，必须当场炸。

    python3 scripts/build-pages.py --out dist

前置是 scripts/demo-seed.py 已经产出 site/demo-data.js。
"""
import argparse
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 演示页不该带这两行：/config.js 服务端就没有这个路由，
# manifest 的 start_url 指向站点根，在 Pages 的子路径下会装出一个打不开的 PWA
DROP_LINES = [
    '<link rel="manifest" href="/manifest.webmanifest">',
    '<script src="/config.js"></script>',
]

# 快照必须排在 shim 前面（shim 直接读 DEMO_DATA），两者都要早于 pages.js 的 boot()
INJECT_AFTER_CORE = '''<script src="demo-data.js"></script>
<script src="demo-shim.js"></script>'''


def drop_lines(html):
    for line in DROP_LINES:
        if line not in html:
            sys.exit(f'assets/index.html 里没有要删的 {line!r}——改写规则过期了')
        html = html.replace(line + '\n', '')
    return html


def relativize(html):
    """根绝对路径改成相对：Pages 是子路径站点，/style.css 会打到用户主页去"""
    html, n = re.subn(r'(src|href)="/(?!/)', r'\1="', html)
    if not n:
        sys.exit('assets/index.html 里一条根绝对路径都没有——改写规则过期了')
    return html


def inject(html):
    core = '<script src="js/core.js"></script>'
    if core not in html:
        sys.exit(f'找不到 {core}，插不进 shim')
    html = html.replace(core, core + '\n' + INJECT_AFTER_CORE)
    return html.replace('</head>', '<link rel="stylesheet" href="demo-shim.css">\n</head>')


def build_demo(out):
    src = os.path.join(ROOT, 'assets')
    os.makedirs(out)
    shutil.copytree(os.path.join(src, 'js'), os.path.join(out, 'js'))
    for name in ('style.css', 'icon.svg'):
        shutil.copy(os.path.join(src, name), out)
    for name in ('demo-shim.js', 'demo-shim.css', 'demo-data.js'):
        path = os.path.join(ROOT, 'site', name)
        if not os.path.exists(path):
            sys.exit(f'缺 site/{name}——先跑 scripts/demo-seed.py')
        shutil.copy(path, out)

    with open(os.path.join(src, 'index.html'), encoding='utf-8') as f:
        html = inject(relativize(drop_lines(f.read())))
    left = re.findall(r'\S*="/[^"]*"', html)
    if left:
        sys.exit(f'改写后仍有根绝对路径：{left}')
    with open(os.path.join(out, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(html)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='dist', help='输出目录，会被清空重建')
    args = ap.parse_args()

    out = os.path.abspath(args.out)
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)

    site = os.path.join(ROOT, 'site')
    for name in ('index.html', 'landing.css'):
        shutil.copy(os.path.join(site, name), out)
    shutil.copy(os.path.join(ROOT, 'assets', 'icon.svg'), out)
    # Pages 默认走 Jekyll，会吞掉下划线开头的文件；这份站点不需要它
    open(os.path.join(out, '.nojekyll'), 'w').close()

    build_demo(os.path.join(out, 'demo'))
    print(f'{args.out}/ 组装完成')


if __name__ == '__main__':
    main()
