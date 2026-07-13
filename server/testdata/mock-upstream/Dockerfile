FROM golang:1.25-alpine AS builder
WORKDIR /src
COPY main.go .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /mock-upstream ./main.go

FROM alpine:3.21
RUN addgroup -g 10001 -S mock && adduser -u 10001 -S -H -G mock mock
COPY --from=builder /mock-upstream /mock-upstream
USER mock:mock
EXPOSE 8081
ENTRYPOINT ["/mock-upstream"]
