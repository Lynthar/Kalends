FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/kalends /usr/local/bin/kalends
ENV KALENDS_ADDR=0.0.0.0:4180 KALENDS_DATA=/data
EXPOSE 4180
VOLUME /data
# 自检走二进制自己（镜像里没有 curl / wget，为这一件事装包不值当）。
# compose 的 restart 策略不会因为 unhealthy 重启容器，这里图的是 docker ps 一眼看得出状态。
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD ["kalends", "--health"]
CMD ["kalends"]
