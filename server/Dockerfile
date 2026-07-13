# Dual Read Server — production image (linux/amd64 + linux/arm64 via buildx)
#
#   docker buildx build --platform linux/amd64,linux/arm64 -t dual-read-server .
#   See docs/DEPLOY.md for Compose / TLS / read-only rootfs.

# syntax=docker/dockerfile:1

ARG GO_VERSION=1.25
ARG ALPINE_VERSION=3.21

# ----- build -----
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS builder

ARG TARGETOS=linux
ARG TARGETARCH=amd64
ARG VERSION=dev
ARG COMMIT=unknown
ARG DATE=unknown

RUN apk add --no-cache ca-certificates git

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath \
    -ldflags="-s -w -X github.com/skys-mission/dual-read/server/internal/buildinfo.Version=${VERSION} -X github.com/skys-mission/dual-read/server/internal/buildinfo.Commit=${COMMIT} -X github.com/skys-mission/dual-read/server/internal/buildinfo.Date=${DATE}" \
    -o /out/dual-read-server ./cmd/dual-read-server

# ----- runtime -----
FROM alpine:${ALPINE_VERSION}

RUN apk add --no-cache ca-certificates tzdata \
  && addgroup -g 10001 -S dualread \
  && adduser -u 10001 -S -H -G dualread dualread \
  && mkdir -p /app/data \
  && chown -R dualread:dualread /app

WORKDIR /app

COPY --from=builder --chown=dualread:dualread /out/dual-read-server /app/dual-read-server
COPY --from=builder --chown=dualread:dualread /build/config.example.toml /app/config.example.toml

# Persistent state only — mount a volume here (required for read-only rootfs).
VOLUME ["/app/data"]

USER dualread:dualread
EXPOSE 8080

ENV OPENAI_API_KEY="" \
    DUAL_READ_HOST=0.0.0.0 \
    DUAL_READ_PORT=8080 \
    DUAL_READ_DATA_DIR=/app/data \
    DUAL_READ_LOG_LEVEL=info

# No secrets are baked into the image. Pass keys via env / Compose secrets / mounts.
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/livez || exit 1

ENTRYPOINT ["/app/dual-read-server"]
CMD ["-data-dir", "/app/data"]
