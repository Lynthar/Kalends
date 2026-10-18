# 用户指南

这份指南讲怎么把 Kalends 跑起来、备份和恢复、升级和回滚，以及提醒没来时怎么查。功能介绍与环境变量见 [README](../README.zh-CN.md)。

Kalends 是单个二进制，数据全在一个目录里：SQLite 库文件、条目图标 `logos/`、自动备份 `backups/` 和明文导出 `export/`。这个目录必须在运行机的本地盘上，不要放在 SMB 或 NFS 挂载路径下，网络文件系统的锁不可靠。

## 部署

### Docker Compose（推荐）

适合常驻在一台家庭服务器或 NAS 上：

```bash
docker build -t kalends:local .   # 要 BuildKit（Docker 23 起默认）
mkdir -p /path/to/appdata/kalends
chown -R 10001:10001 /path/to/appdata/kalends   # 容器以 uid 10001 运行，数据目录要先交给它
mkdir -p /path/to/compose/kalends
cp deploy/compose.yaml /path/to/compose/kalends/
cd /path/to/compose/kalends && docker compose up -d
curl -sf --retry 5 --retry-connrefused http://127.0.0.1:4180/api/health   # 刚起的几秒连不上属正常，会自动重试
```

镜像没有发布到任何镜像仓库。`compose.yaml` 里的 `image: kalends:local` 就是上面 `docker build` 在本机建出来的那个，不先 build 的话 `compose up` 会去拉一个不存在的镜像。

`compose.yaml` 有两处要按自己的情况改：

- **数据卷路径**：改成上面 `chown` 过的那个目录。
- **时区**：文件里写的是 `TZ: Asia/Shanghai`，换成你所在的时区（IANA 名，如 `Europe/Berlin`）。镜像本身不设 `TZ`，自己写 compose 或用 `docker run` 时漏了它，容器就跑在 UTC 上，「今天」、剩余天数、摘要的发送时刻都会错位。启动日志里有一行 `local time …, TZ=…`，用来核对。

容器只绑 `127.0.0.1:4180`，局域网访问交给反向代理，见下文「远程访问」。

如果你在 v0.1.0 之前就从源码建过镜像，那时的容器以 root 运行。换新镜像前先对已有的数据目录执行同一条 `chown -R 10001:10001`，否则新容器写不进 `/data`，起不来，日志里会写出是哪个路径打不开。要退回旧镜像，把属主 `chown` 回 root 即可。

### 预编译二进制

[Releases](https://github.com/Lynthar/Kalends/releases) 提供三种 Linux 包：x86_64 与 aarch64 的 glibc 版（要求 glibc 2.34 及以上），以及 x86_64 的静态 musl 版。更老的 x86_64 系统或 Alpine 用 musl 版，更老的 ARM 系统用 Docker 或从源码构建。

```bash
tar xzf kalends-*-x86_64-unknown-linux-gnu.tar.gz
sudo install -m755 kalends-*/kalends /usr/local/bin/kalends
KALENDS_DATA=/path/to/data kalends
```

发布页附 `SHA256SUMS`。只下了一个包时用 `sha256sum -c --ignore-missing SHA256SUMS` 校验，不加 `--ignore-missing` 会因为其余包不在而退出 1。要常驻运行，交给 systemd 之类的进程管理器。

### 从源码构建

要 Rust 1.91 及以上：

```bash
cargo build --release
KALENDS_DATA=/path/to/data ./target/release/kalends
```

## 远程访问

反向代理以 Caddy 为例：

```
:4443 {
    reverse_proxy 127.0.0.1:4180
}
```

局域网设备访问 `http://<服务器IP>:4443`。手机浏览器里「添加到主屏幕」后可以当独立应用用，但没有离线缓存，要连得上服务器才能打开。

出门在外要访问，走 Tailscale、WireGuard 这类私网方案，不要把端口直接暴露到公网。设置页里的 PIN 挡不住公网上的人：

- PIN 是明文全等比较，没有失败次数限制，也没有退避。在能连到这台机器的网络里，短 PIN 可以被穷举。它防的是同一私网里的其他人或设备顺手打开。
- `/api/health` 不过 PIN，好让容器探针看得见服务状态。没带 PIN 的请求只拿到状态码与 `ok`，计数与版本号要带 PIN 才给。

## 备份与恢复

### 自动备份

本地时间每天 03:30 之后，Kalends 自动做两件事：

- 往 `backups/` 写一份数据库快照 `snapshot-YYYY-MM-DD.db`，保留最近 14 份；
- 往 `export/` 写一份全表 JSONL 明文导出，只留最新一份。

设置页的「立即备份」会当场做同样的两件事。同一天再做一次，会覆盖当天那份快照。

快照与库文件里，渠道密钥和代理口令都是明文；JSONL 导出里这两样已经遮掉。

应用自己的快照之外，建议把整个数据目录纳入主机的整机备份，连同 `kalends.db-wal` 一起：最近的写入可能还只在它里面。

### 恢复

恢复用内置命令。它把快照装配成一个全新的数据目录，并当场验证：

```bash
kalends restore --from /path/to/data/backups/snapshot-2026-01-01.db --to /path/to/data-restored
```

命令做这几件事：

1. 把快照复制成新目录里的 `kalends.db`。目标目录必须不存在或为空，恢复永远不覆盖在用的数据。
2. 跑 `integrity_check` 与外键检查，并确认快照的数据库版本不高于当前二进制。
3. 快照在 `<数据目录>/backups/` 下时，从这个数据目录把 `logos/` 整份复制过去。
4. 核对条目引用的图标是否都在，缺的逐个列出。

快照里只有数据库，图标取的是原数据目录现在的 `logos/`，快照之后换过或删掉的旧图标恢复不出来。缺的图标会被逐个点名，到界面上重传即可。

`--from` 也可以指向整机备份里的 `kalends.db`。旁边的 `kalends.db-wal` 会一并并入新库，源文件不动。这种情况下第 3 步不会发生，要自己把同一份备份里的 `logos/` 复制到新目录。

退出码：

- `0`：完整恢复。
- `1`：恢复失败，目标目录已还原成原样；或者数据库完好，但有引用的图标缺失（会逐个列出）。
- `2`：用法错误。

恢复成功后，把 `KALENDS_DATA` 指向新目录，再启动。

**Docker 部署**用同一个镜像跑这条命令。新目录先建好并交给 uid 10001，否则容器写不进去，命令直接失败。原数据目录可以只读挂进去，`logos/` 照样能从里面复制出来：

```bash
mkdir -p /path/to/appdata/kalends-restored
chown 10001:10001 /path/to/appdata/kalends-restored
docker run --rm \
  -v /path/to/appdata/kalends:/data:ro \
  -v /path/to/appdata/kalends-restored:/restored \
  kalends:local kalends restore --from /data/backups/snapshot-2026-01-01.db --to /restored
```

退出码为 `0` 后，把 `compose.yaml` 的数据卷改指 `/path/to/appdata/kalends-restored`，再 `docker compose up -d`。

## 升级与回滚

**升级**：拉取新代码，重新 `docker build`，再 `docker compose up -d`。想留一条回滚的路，build 之前先 `docker tag kalends:local kalends:prev`，否则旧镜像会被新的覆盖。

新版本要改数据库结构时，应用会在迁移之前往 `backups/` 写一份 `pre-migration-v<N>.db`，启动日志里有一行 `pre-migration snapshot: …`。这份快照写不进去（比如磁盘满了），应用会拒绝启动，腾出空间再试。

**回滚**分两种情况：

- 启动日志里没有 `pre-migration snapshot`，说明这次升级没动数据库结构，直接换回旧镜像即可：`docker tag kalends:prev kalends:local`，再 `docker compose up -d`。
- 跑过迁移的，不能带着库回滚：旧二进制遇到更新版本写过的库会拒绝启动，这是保护，不是故障。这时用迁移前的快照恢复：
  ```bash
  kalends restore --from /path/to/data/backups/pre-migration-v<N>.db --to /path/to/data-restored
  ```
  Docker 部署照上一节的 `docker run` 写法跑。然后把 `compose.yaml` 的数据卷改指新目录、`image` 改成 `kalends:prev`，再 `docker compose up -d`。升级之后写入的数据会丢。

## 提醒没来时

按这个顺序查：

1. **设置页「通知发送记录」**。每次投递，成败都记一条，失败的原因写在那一行里。这里空着，说明根本没轮到发，往下查。失败后分别隔 30 分钟、1 小时、2 小时、4 小时重试，第五次仍失败就放弃这一条。修好渠道后，下一个提醒档位和次日的摘要照常发。
2. **渠道开关与凭据**。Telegram 和邮件都要勾选启用，凭据要填齐。「发送测试」拿表单里当前填的值当场发一条，不保存。邮件只走加密连接（默认隐式 TLS，或勾 STARTTLS），服务器证书要由公共 CA 签发。局域网里的明文中继、自签证书或私有 CA 签发证书的 SMTP 服务器都接不上。
3. **阈值与状态**。下面几条都是设计如此：
   - 提醒阈值留空，表示只发每日摘要。
   - 静音的条目（状态关了提醒，或者这一期归自动续费管）不发逐项提醒，但仍出现在每日摘要里。
   - 逾期的条目只提醒一次，之后只出现在每日摘要里。
   - 改了阈值之后，已经提醒过的条目只有进入比上次更紧的档位才会再提醒。
4. **时区**。容器跑在 UTC 上时，「今天」会错位，摘要也会在别的钟点发出。核对启动日志里的 `local time` 一行，见上文「部署」。
