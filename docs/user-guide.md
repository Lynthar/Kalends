# 部署 / Deployment

Kalends 是单个二进制 + 单个 SQLite 文件，怎么跑都行；推荐 Docker Compose 常驻一台家庭服务器/NAS。

## Docker Compose（推荐）

```bash
docker build -t kalends:local .
mkdir -p /path/to/appdata/kalends
chown -R 10001:10001 /path/to/appdata/kalends   # 容器内以非 root（uid 10001）运行，数据卷要先交给它
cp deploy/compose.yaml /path/to/compose/kalends/
cd /path/to/compose/kalends && docker compose up -d
curl -sf http://127.0.0.1:4180/api/health
```

`compose.yaml` 里按需修改数据卷路径与时区；容器默认只绑 `127.0.0.1:4180`，由你的反向代理对局域网提供访问。**镜像没有发布到任何镜像仓库**——`image: kalends:local` 指的就是上面那条 `docker build` 在本机产出的镜像，不先 build 的话 `compose up` 会去拉一个不存在的镜像。

**从旧版（root 运行的镜像）升级**：换镜像前先在宿主机对既有数据卷执行同一条 `chown -R 10001:10001`，否则新容器写不进 `/data`、起不来（日志会明说）；`chown` 回 root 即可回退旧镜像。基础镜像已钉 digest，升级基础镜像＝显式改 `Dockerfile` 里的 `@sha256:` 值。

## 反向代理示例（Caddy）

```
:4443 {
    reverse_proxy 127.0.0.1:4180
}
```

局域网设备访问 `http://<服务器IP>:4443` 即可；手机浏览器「添加到主屏幕」可当作全屏独立应用使用（需在线，无离线缓存）。

## 单模块部署（可选）

只需要其中一个模块时，在 compose 的 `environment` 加一行：

```yaml
      KALENDS_MODULES: renewals   # 纯续费中心（订阅 / SIM / VPS）
      # KALENDS_MODULES: media    # 纯媒体库
```

未选模块整体不存在：接口不挂载（404）、界面无入口、后台任务不启动。随时改回全开重启即可。

## 裸机运行

取一个预编译二进制（[Releases](https://github.com/Lynthar/Kalends/releases)，Linux x86_64 / aarch64 / 静态 musl），配一个 systemd 单元即可：

```bash
tar xzf kalends-*-x86_64-unknown-linux-gnu.tar.gz
sudo install -m755 kalends-*/kalends /usr/local/bin/kalends
KALENDS_DATA=/path/to/data kalends
```

发布页附 `SHA256SUMS`，`sha256sum -c SHA256SUMS` 可校验。或者自己编译：

```bash
cargo build --release
KALENDS_DATA=/path/to/data ./target/release/kalends
```

环境变量：`KALENDS_ADDR`（默认 `127.0.0.1:4180`）、`KALENDS_DATA`（默认 `./data`）、`KALENDS_MODULES`。

## 恢复 / Restore

数据目录里 `backups/` 存着每晚的快照（保留 14 份）。恢复用内置命令，装配并当场验证一个全新数据目录：

```bash
kalends restore --from /path/to/data/backups/snapshot-2026-01-01.db --to /path/to/data-restored
```

命令会复制快照、做 `integrity_check`、从原数据目录把 `covers/` 与 `logos/` 一并带上，并核对条目引用的图标/海报是否在位；之后把 `KALENDS_DATA`（或 compose 的数据卷）指向新目录即可。退出码 `0` 为完整恢复；`1` 表示数据库完好但有引用文件缺失（会逐个列出）。目标目录必须为空——恢复永不覆盖在用数据。

升级版本时，应用会在跑数据库迁移之前自动往 `backups/` 落一份 `pre-migration-v<N>.db`；落不下去（如磁盘满）会拒绝启动。回滚部署或迁移出问题时，从这份快照恢复。

## 升级与回滚 / Upgrade & Rollback

- **升级**：重新 `docker build` + `docker compose up -d`。应用在跑数据库迁移**之前**会自动往 `backups/` 落一份 `pre-migration-v<N>.db`；落不下去（如磁盘满）会拒绝启动，先腾空间再试。
- **回滚**：数据库结构没动过的升级直接换回旧镜像即可。**跑过迁移的升级不能带库回滚**——旧二进制遇到更新的数据库会拒绝启动（这是保护，不是故障）。此时用迁移前快照恢复：`kalends restore --from backups/pre-migration-v<N>.db --to <新目录>`，把数据卷指向新目录后再起旧镜像。

## 通知排查 / Notifications Troubleshooting

提醒没来时按顺序看：

1. **设置页「通知发送记录」**：每次投递成败都记一条，失败带原因（悬停「失败」看全文）。这里空着说明决策层就没发——往下查。
2. **渠道开关与凭据**：Telegram / 邮件要勾选启用且凭据齐全；「发送测试」按钮当场验证。
3. **阈值与语义**：提醒阈值留空＝只发每日摘要；条目静音（muted）不发逐项提醒但仍进摘要；**逾期条目只在首轮提醒一次**，之后只出现在每日摘要里——这些都是设计行为。
4. **时区**：容器默认 UTC，「今天」会错位——compose 里设 `TZ`，启动日志会打印本地时间供核对。

## 注意

- **SQLite 数据文件必须在本地磁盘**，不要放 SMB/NFS 网络挂载路径（网络文件系统的锁不可靠）。
- 数据目录（db + covers + logos + backups + export）纳入主机的整机备份即可；应用自身每日 03:30 做快照轮转与 JSONL 明文导出。
- 出门在外访问建议走 Tailscale/WireGuard 之类的私网方案，不要直接暴露公网端口。
- **PIN 是私网内的一道薄门，不是公网防线**：它是明文全等比较，没有失败次数限制，也没有退避——短 PIN 在能连到本机的网络里可以被穷举。它挡的是"同一私网里的其他人/设备顺手打开"，不足以替代不暴露公网端口这条。
