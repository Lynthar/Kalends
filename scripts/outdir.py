"""脚本共用：认领一个输出目录并清空重建。"""
import os
import shutil
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def claim(outdir, sentinel):
    """校验并清空 outdir，返回其绝对路径。误传的路径（HOME、仓库、生产数据目录……）
    会被整树删掉，所以只清「不存在 / 空 / 带 sentinel 标记」的目录，其余一律拒绝。"""
    out = os.path.realpath(outdir)
    home = os.path.realpath(os.path.expanduser('~'))
    for fatal in (os.path.sep, home, os.path.realpath(REPO)):
        if out == fatal or fatal.startswith(out + os.path.sep):
            sys.exit(f'不清空 {out}：那是根 / HOME / 仓库，或它们的上级')
    if os.path.exists(out):
        if not os.path.isdir(out):
            sys.exit(f'{out} 不是目录')
        if os.listdir(out) and not os.path.exists(os.path.join(out, sentinel)):
            sys.exit(f'{out} 已有内容且缺 {sentinel} 标记（不像本脚本上一轮的输出），拒绝清空；换个新路径')
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    open(os.path.join(out, sentinel), 'w').close()
    return out
