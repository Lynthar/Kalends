<div align="center">

<img src="assets/icon.svg" alt="Kalends" width="96">

# Kalends

[![license](https://img.shields.io/github/license/Lynthar/Kalends)](LICENSE)
[![release](https://img.shields.io/github/v/release/Lynthar/Kalends)](https://github.com/Lynthar/Kalends/releases)

**[在线演示](https://lynthar.github.io/Kalends/demo/)**（只读，数据是合成的）·
[项目主页](https://lynthar.github.io/Kalends/)

</div>

自托管的续费台账：订阅、SIM 保号、VPS，凡是有下一个日期的都记得下。单二进制单 SQLite 文件。

[English](README.md) | 简体中文

凡是有「下一个日期」的东西都归到一条时间线上。订阅、每 181 天得充一次才能保住号码的
预付费 SIM、VPS、域名、保险、会过期的证件。

我做它是为了替掉手里几个 Notion database：只能在线用，库一大就卡，还说不清一个状态
到底算不算支出。数据模型还是那一套——库加带类型的列——但落成一个二进制、一个 SQLite
文件，没有账号，不往外发任何东西。丢在 NAS 上跑着，可以忘了它的存在。

## 功能

- **七个预置模板**——订阅、SIM 卡、VPS 实例、域名、保险、证件，外加一个空白的。
  列是有类型的，排序、筛选、单元格怎么渲染，都由类型决定。
- **到期日有两种写法。** 直接存下一个日期，或者存「上次续费 + 周期」让它自己算。
  周期从周到三年，另有终身和任意天数——所以 181 天的 SIM 保号是个普通设置，不是特例。
- **状态值自带语义。** 每个状态自己声明：算不算支出、要不要提醒、上不上时间线。
- **提醒与日历。** Telegram bot 和 SMTP 邮件，按「提前 N 天」的阈值加每日摘要，
  去重过所以重启不会重发，宕机之后会补上；另有 `/calendar.ics` 订阅源给日历应用。
- **钱按原币记。** 价格按你输入的币种存、分币种汇总；折算是一个可以打开的视图。
- **备份自己会跑。** 每晚 03:30 之后打一次 SQLite 快照，滚动保留 14 份；另有一份全表
  JSONL 导出——那份不装 Kalends 也读得懂。

## 安装

**预编译二进制只有 Linux。** 从 [Releases](https://github.com/Lynthar/Kalends/releases) 取：

```bash
tar xzf kalends-v0.1.0-x86_64-unknown-linux-gnu.tar.gz
KALENDS_DATA=./data TZ=Asia/Shanghai ./kalends-v0.1.0-x86_64-unknown-linux-gnu/kalends
```

另有 `aarch64` 版给 ARM 机器和 NAS，`musl` 版给老 glibc 或 Alpine，同批带 `SHA256SUMS`。

**Docker**——compose 是本地构建的，没有发布任何镜像：

```bash
docker build -t kalends:local .
sudo chown -R 10001:10001 /path/to/appdata/kalends
docker compose -f deploy/compose.yaml up -d
```

**从源码跑：**

```bash
cargo run
```

服务起在 `http://127.0.0.1:4180`，数据落 `./data/`。如果仓库放在网络共享上，
先把 `CARGO_TARGET_DIR` 指到本地盘——cargo 和 SMB 处不来。

## 用法

```bash
KALENDS_DATA=./data KALENDS_ADDR=127.0.0.1:4180 TZ=Asia/Shanghai ./kalends
```

另外两种模式：

```bash
kalends --health                                    # 给容器 healthcheck 用
kalends restore --from backups/snapshot-2026-08-25.db --to ./data-new
```

日常：在手机上「添加到主屏幕」，用起来跟应用一样；在设置页填好 Telegram 或 SMTP 之后
给自己发一条测试通知；设一个 ICS token，然后从日历应用订阅 `/calendar.ics?token=…`。

## 配置

四个环境变量，其余全在设置页里改。

| 变量 | 默认 | 说明 |
|---|---|---|
| `KALENDS_ADDR` | `127.0.0.1:4180` | 容器镜像里改成 `0.0.0.0:4180` |
| `KALENDS_DATA` | `data` | 容器里是 `/data` |
| `TZ` | 无 | **一定要设。** 容器默认 UTC，「今天」会错位 |
| `RUST_LOG` | `info` | |

设置页里的：可选的 PIN、ICS token、共用的出网代理、显示币种、Telegram 与 SMTP 凭据、
提醒阈值、摘要时间。

## 能力边界

- **单用户，这是设计。** 没有账号也没有权限。那个可选的 PIN 只能挡住一个好奇的室友，
  仅此而已。两个浏览器标签页停在旧数据上，会互相覆盖。
- **不是给公网用的。** 该走 Tailscale 或 VPN，而不是开个公网端口再加个 PIN。
- **数据库必须在本地盘。** SQLite 在 SMB 或 NFS 上的锁不可靠，不值得拿唯一一份数据去赌。
- **界面只有中文。** 没有 i18n 层，所以界面、以及 `restore` 和 `--health` 的命令行输出
  也都是中文。
- **搜索是普通的 `LIKE`。** 几百条无感；没有全文索引，也还没有虚拟滚动。

## 文档

- [用户指南](docs/user-guide.md) —— Docker Compose、Caddy 反代示例、裸机运行、恢复、
  升级与回滚、通知排查。

## 许可证

GNU Affero 通用公共许可证 v3.0 only —— 见 [LICENSE](LICENSE)。Copyright (c) 2026 Lynthar。
