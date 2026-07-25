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
CMD ["kalends"]
