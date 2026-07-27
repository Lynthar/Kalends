# 部署 / Deployment

Kalends 是单个二进制 + 单个 SQLite 文件，怎么跑都行；推荐 Docker Compose 常驻一台家庭服务器/NAS。

## Docker Compose（推荐）

```bash
docker build -t kalends:local .
mkdir -p /path/to/appdata/kalends
cp deploy/compose.yaml /path/to/compose/kalends/
cd /path/to/compose/kalends && docker compose up -d
curl -sf http://127.0.0.1:4180/api/health
```

`compose.yaml` 里按需修改数据卷路径与时区；容器默认只绑 `127.0.0.1:4180`，由你的反向代理对局域网提供访问。

## 反向代理示例（Caddy）

```
:4443 {
    reverse_proxy 127.0.0.1:4180
}
```

局域网设备访问 `http://<服务器IP>:4443` 即可；手机浏览器「添加到主屏幕」可获得 PWA 体验。

## 单模块部署（可选）

只需要其中一个模块时，在 compose 的 `environment` 加一行：

```yaml
      KALENDS_MODULES: renewals   # 纯续费中心（订阅 / SIM / VPS）
      # KALENDS_MODULES: media    # 纯媒体库
```

未选模块整体不存在：接口不挂载（404）、界面无入口、后台任务不启动。随时改回全开重启即可。

## 裸机运行

```bash
cargo build --release
KALENDS_DATA=/path/to/data ./target/release/kalends
```

环境变量：`KALENDS_ADDR`（默认 `127.0.0.1:4180`）、`KALENDS_DATA`（默认 `./data`）、`KALENDS_MODULES`。

## 注意

- **SQLite 数据文件必须在本地磁盘**，不要放 SMB/NFS 网络挂载路径（网络文件系统的锁不可靠）。
- 数据目录（db + covers + logos + backups + export）纳入主机的整机备份即可；应用自身每日 03:30 做快照轮转与 JSONL 明文导出。
- 出门在外访问建议走 Tailscale/WireGuard 之类的私网方案，不要直接暴露公网端口；对外暴露前先在设置页启用 PIN。
