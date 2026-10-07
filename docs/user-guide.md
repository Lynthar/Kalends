# 部署 / Deployment

Kalends 是单个二进制 + 单个 SQLite 文件，怎么跑都行；推荐 Docker Compose 常驻一台家庭服务器/NAS。

## Docker Compose（推荐）

```bash
docker build -t kalends:local .   # 要 BuildKit（Docker 23 起默认）
mkdir -p /path/to/appdata/kalends
chown -R 10001:10001 /path/to/appdata/kalends   # 容器内以非 root（uid 10001）运行，数据卷要先交给它
mkdir -p /path/to/compose/kalends
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

## 裸机运行

取一个预编译二进制（[Releases](https://github.com/Lynthar/Kalends/releases)，Linux x86_64 / aarch64 / 静态 musl；两个 glibc 版要求 glibc 2.34 及以上，更老的 ARM 系统用 Docker 或从源码构建），配一个 systemd 单元即可：

```bash
tar xzf kalends-*-x86_64-unknown-linux-gnu.tar.gz
sudo install -m755 kalends-*/kalends /usr/local/bin/kalends
KALENDS_DATA=/path/to/data kalends
```

发布页附 `SHA256SUMS`，`sha256sum -c --ignore-missing SHA256SUMS` 可校验（只下了一个包时，不加 `--ignore-missing` 会因其余包缺席而退 1）。或者自己编译：

```bash
cargo build --release
KALENDS_DATA=/path/to/data ./target/release/kalends
```

环境变量：`KALENDS_ADDR`（默认 `127.0.0.1:4180`）、`KALENDS_DATA`（默认 `./data`）。

## 恢复 / Restore

数据目录里 `backups/` 存着每晚的快照（保留 14 份）。恢复用内置命令，装配并当场验证一个全新数据目录：

```bash
kalends restore --from /path/to/data/backups/snapshot-2026-01-01.db --to /path/to/data-restored
```

命令会复制快照、做 `integrity_check`、从原数据目录把 `logos/` 一并带上，并核对条目引用的图标是否在位（快照只含数据库：图标取自原数据目录现在的 `logos/`，之后换过或删掉的旧图标恢复不出来，命令会逐个点名，重传即可）；之后把 `KALENDS_DATA`（或 compose 的数据卷）指向新目录即可。`--from` 也可以直接指向整机备份里的 `kalends.db`：旁边的 `kalends.db-wal` 会一并并入，源文件不动。退出码 `0` 为完整恢复；`1` 为恢复失败（目标目录还原成原样），或数据库完好但有引用文件缺失（会逐个列出）；`2` 为用法错误。目标目录必须为空——恢复永不覆盖在用数据。

**Docker 部署**用同一个镜像跑这条命令：新目录先建好并交给 uid 10001（容器里以它运行，写不进去会直接失败），原数据卷只读挂进去即可，`logos/` 照样从里面带出来：

```bash
mkdir -p /path/to/appdata/kalends-restored
chown 10001:10001 /path/to/appdata/kalends-restored
docker run --rm \
  -v /path/to/appdata/kalends:/data:ro \
  -v /path/to/appdata/kalends-restored:/restored \
  kalends:local kalends restore --from /data/backups/snapshot-2026-01-01.db --to /restored
```

退出码为 `0` 之后，把 `compose.yaml` 的数据卷改指 `/path/to/appdata/kalends-restored`，再 `docker compose up -d`。

升级版本时，应用会在跑数据库迁移之前自动往 `backups/` 落一份 `pre-migration-v<N>.db`；落不下去（如磁盘满）会拒绝启动。回滚部署或迁移出问题时，从这份快照恢复。

## 升级与回滚 / Upgrade & Rollback

- **升级**：重新 `docker build` + `docker compose up -d`。应用在跑数据库迁移**之前**会自动往 `backups/` 落一份 `pre-migration-v<N>.db`；落不下去（如磁盘满）会拒绝启动，先腾空间再试。
- **回滚**：数据库结构没动过的升级直接换回旧镜像即可。**跑过迁移的升级不能带库回滚**——旧二进制遇到更新的数据库会拒绝启动（这是保护，不是故障）。此时用迁移前快照恢复：`kalends restore --from backups/pre-migration-v<N>.db --to <新目录>`，把数据卷指向新目录后再起旧镜像。

## 通知排查 / Notifications Troubleshooting

提醒没来时按顺序看：

1. **设置页「通知发送记录」**：每次投递成败都记一条，失败的原因写在那一行下面。这里空着说明决策层就没发——往下查。失败后按 30 分钟 / 1 / 2 / 4 小时退避重试，第五次仍失败就放弃这一条（修好渠道后，下一个提醒档位与次日摘要照常发）。
2. **渠道开关与凭据**：Telegram / 邮件要勾选启用且凭据齐全；「发送测试」按钮拿表单里当前填的值当场验证，不保存。邮件只走加密连接（默认隐式 TLS，或勾 STARTTLS），证书要由公共 CA 签发——局域网的明文中继、自签证书或私有 CA 的 SMTP 服务器都接不上。
3. **阈值与语义**：提醒阈值留空＝只发每日摘要；条目静音（muted）不发逐项提醒但仍进摘要；**逾期条目只在首轮提醒一次**，之后只出现在每日摘要里；改了阈值之后，已经提醒过的条目只有进入比上次更紧的档才会再提醒——这些都是设计行为。
4. **时区**：容器默认 UTC，「今天」会错位——compose 里设 `TZ`，启动日志会打印本地时间供核对。

## 注意

- **SQLite 数据文件必须在本地磁盘**，不要放 SMB/NFS 网络挂载路径（网络文件系统的锁不可靠）。
- 整个数据目录（含 `kalends.db-wal`，最近的写入可能只在它里面）纳入主机的整机备份即可；应用自身每日 03:30 做快照轮转与 JSONL 明文导出。导出里的渠道密钥与代理口令已遮掉，快照与库文件里是明文。
- 出门在外访问建议走 Tailscale/WireGuard 之类的私网方案，不要直接暴露公网端口。
- **PIN 是私网内的一道薄门，不是公网防线**：它是明文全等比较，没有失败次数限制，也没有退避——短 PIN 在能连到本机的网络里可以被穷举。它挡的是"同一私网里的其他人/设备顺手打开"，不足以替代不暴露公网端口这条。`/api/health` 不过这道门，好让容器探针看得见库：没带 PIN 只回状态码与 `ok`，计数要带 PIN 才给。
