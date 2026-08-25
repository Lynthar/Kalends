# 基础镜像钉 digest：升级基础镜像是显式动作（换这里的值），不是每次构建的隐式变量
FROM rust:1-bookworm@sha256:e536cf316987faedfe8ae120f83b70c7df0068fdb4fc9efcce55c71a625001d5 AS build
WORKDIR /src
COPY . .
RUN cargo build --release --locked

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
# /data 在镜像里就归非 root 用户：匿名卷继承这份属主；bind mount 则要宿主先 chown（见 docs/user-guide.md）
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 kalends \
    && useradd --system --uid 10001 --gid 10001 --shell /usr/sbin/nologin kalends \
    && mkdir -p /data && chown kalends:kalends /data
COPY --from=build /src/target/release/kalends /usr/local/bin/kalends
ENV KALENDS_ADDR=0.0.0.0:4180 KALENDS_DATA=/data
EXPOSE 4180
VOLUME /data
USER kalends
# 自检走二进制自己（镜像里没有 curl / wget，为这一件事装包不值当）。
# compose 的 restart 策略不会因为 unhealthy 重启容器，这里图的是 docker ps 一眼看得出状态。
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD ["kalends", "--health"]
CMD ["kalends"]
