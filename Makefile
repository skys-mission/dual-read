.PHONY: all build build-server build-extension check-artifacts check-store check-release check-server-coverage check-npm-audit check-golangci sbom package-amo-sources assemble-release release-dry-run lint-extension lint-server dev-extension dev-extension-firefox package clean test test-server test-extension test-e2e test-e2e-perf probe run-server install-server docker-build docker-smoke docker-valkey-smoke

all: build

build: build-server build-extension

dev-extension:
	chmod +x ./scripts/dev-extension.sh
	./scripts/dev-extension.sh chrome

dev-extension-firefox:
	chmod +x ./scripts/dev-extension.sh
	./scripts/dev-extension.sh firefox

build-server:
	./scripts/build-server.sh

build-extension:
	chmod +x ./scripts/build-extension.sh
	./scripts/build-extension.sh

check-artifacts:
	chmod +x ./scripts/check-extension-artifacts.sh
	./scripts/check-extension-artifacts.sh

check-store:
	chmod +x ./scripts/check-store-consistency.sh
	./scripts/check-store-consistency.sh

check-release:
	chmod +x ./scripts/check-release-version.sh
	./scripts/check-release-version.sh $(VERSION)

package-amo-sources:
	chmod +x ./scripts/package-amo-sources.sh
	./scripts/package-amo-sources.sh

assemble-release:
	chmod +x ./scripts/assemble-release.sh
	./scripts/assemble-release.sh

release-dry-run:
	chmod +x ./scripts/release-dry-run.sh
	./scripts/release-dry-run.sh

check-server-coverage:
	chmod +x ./scripts/check-server-coverage.sh
	./scripts/check-server-coverage.sh

check-npm-audit:
	chmod +x ./scripts/check-npm-audit.sh
	./scripts/check-npm-audit.sh

check-golangci:
	chmod +x ./scripts/check-golangci.sh
	./scripts/check-golangci.sh

lint-extension:
	cd extension && npm run lint

lint-server: check-golangci

sbom:
	chmod +x ./scripts/generate-sbom.sh
	./scripts/generate-sbom.sh

package: build
	@echo "Packaging complete. Outputs are in dist/"

clean:
	rm -rf dist/ extension/output/ extension/.output/

test: test-server test-extension

test-server:
	cd server && go test ./...

test-extension:
	cd extension && npm run compile && npm run lint && npm test

test-e2e:
	cd extension && npm run build && npm run build:firefox && npx playwright install --with-deps chromium firefox && npm run e2e

test-e2e-perf:
	cd extension && npm run build && npx playwright install --with-deps chromium && npm run e2e:perf

# Real-website collector regression: detects duplicate/overlapping translation
# units across a set of live sites (no API key needed). Pass URLS="a b" to override.
probe:
	cd extension && npm run probe $(URLS)

install-server:
	cd server && go install ./cmd/dual-read-server

run-server:
	cd server && go run ./cmd/dual-read-server

docker-build:
	chmod +x ./scripts/docker-build.sh
	./scripts/docker-build.sh

docker-smoke:
	chmod +x ./scripts/docker-smoke.sh
	./scripts/docker-smoke.sh

docker-valkey-smoke:
	chmod +x ./scripts/docker-valkey-smoke.sh
	./scripts/docker-valkey-smoke.sh
