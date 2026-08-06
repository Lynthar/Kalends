#!/usr/bin/env python3
"""重新生成 src/fx.rs 里的内置平均汇率表。

内置表是离线部署唯一的折算依据，也是联网拉取覆盖不到的币种的兜底。取一段时间的
日汇率算均值而不是取某一天的即期价——单日快照会把一次波动固化到下一个发版周期。

    python3 scripts/update-fx-baseline.py            # 最近 30 天
    python3 scripts/update-fx-baseline.py --days 90

数据来自欧洲央行的参考汇率（Frankfurter，无需 key）。只发 GET，只改 src/fx.rs 里
BASELINE / BASELINE_PERIOD 那两段，别的一行不碰。发版前跑一次，把 diff 一起提交。
"""
import argparse
import datetime as dt
import json
import pathlib
import re
import statistics
import sys
import urllib.request

API = "https://api.frankfurter.dev/v1/{start}..{end}?base=USD"
FX_RS = pathlib.Path(__file__).resolve().parent.parent / "src" / "fx.rs"


def fetch(start, end):
    url = API.format(start=start, end=end)
    print(f"GET {url}", file=sys.stderr)
    # 必须显式带 UA：默认的 Python-urllib/x.y 被这个接口特判拒掉（403），
    # 换成任何其他标识都放行
    req = urllib.request.Request(url, headers={"User-Agent": "kalends-fx-baseline"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def averages(payload):
    """按币种取区间均值；只收在每个交易日都有报价的币种，免得半程上线的币种把均值算偏。"""
    days = sorted(payload["rates"])
    if not days:
        sys.exit("接口没返回任何交易日")
    acc = {}
    for day in days:
        for code, rate in payload["rates"][day].items():
            acc.setdefault(code, []).append(rate)
    full = {c: v for c, v in acc.items() if len(v) == len(days)}
    dropped = sorted(set(acc) - set(full))
    if dropped:
        print(f"跳过报价不全的币种：{', '.join(dropped)}", file=sys.stderr)
    out = {c: round(statistics.fmean(v), 4) for c, v in full.items()}
    out["USD"] = 1.0  # 基准币自己不在 rates 里，但表里必须有
    return days, dict(sorted(out.items()))


def rewrite(rates, days):
    src = FX_RS.read_text()
    period = f"{days[0]} – {days[-1]}"
    body = "\n".join(f'    ("{c}", {v}),' for c, v in rates.items())
    new_table = f"pub const BASELINE: &[(&str, f64)] = &[\n{body}\n];"

    src, n1 = re.subn(
        r'pub const BASELINE_PERIOD: &str = "[^"]*";',
        f'pub const BASELINE_PERIOD: &str = "{period}";',
        src,
    )
    src, n2 = re.subn(
        r"pub const BASELINE: &\[\(&str, f64\)\] = &\[.*?\n\];",
        new_table,
        src,
        flags=re.S,
    )
    if n1 != 1 or n2 != 1:
        sys.exit(f"src/fx.rs 里没找到该替换的那两段（period={n1} table={n2}），请检查文件结构")
    FX_RS.write_text(src)
    print(f"已写入 {len(rates)} 个币种，区间 {period}（{len(days)} 个交易日）")
    print("接着跑一次 cargo test：内置表的排序与正数不变式有单测守着")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30, help="取样天数（默认 30）")
    a = ap.parse_args()
    end = dt.date.today()
    start = end - dt.timedelta(days=a.days)
    payload = fetch(start.isoformat(), end.isoformat())
    days, rates = averages(payload)
    rewrite(rates, days)


if __name__ == "__main__":
    main()
