#!/usr/bin/env python3
"""Regression checks for selective CI and the shared Go coverage gate."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
CHECKS = {"extension", "server", "docker", "store", "dependencies"}


class CIRoutingTests(unittest.TestCase):
    def classify(self, paths=(), *args):
        result = subprocess.run(
            ["bash", str(ROOT / "scripts/ci-changes.sh"), *args],
            input=b"".join(path.encode() + b"\0" for path in paths),
            capture_output=True, check=True,
        )
        outputs = dict(line.split("=") for line in result.stdout.decode().splitlines())
        self.assertEqual(set(outputs), CHECKS)
        return {key for key, value in outputs.items() if value == "true"}

    def test_changes_select_their_consumers(self):
        cases = [
            ([], set()),
            (["README.md", "server/docs/DEPLOY.md", ".github/dependabot.yml"], set()),
            (["docs/store/PERMISSIONS.md"], set()),
            (["PRIVACY.md"], {"store"}),
            (["extension/lib/renderer.ts"], {"extension"}),
            (["extension/e2e/fixtures/pages/article.html"], {"extension"}),
            (["extension/e2e/page with\na newline.html"], {"extension"}),
            (["extension/public/_locales/en/messages.json"], {"extension", "store"}),
            (["extension/wxt.config.ts"], {"extension", "store"}),
            (["extension/package-lock.json"], {"extension", "dependencies"}),
            (["extension/package.json"], {"extension", "dependencies", "store"}),
            (["server/internal/server/server.go"], {"server", "docker"}),
            (["server/go.mod"], {"server", "docker", "dependencies"}),
            (["server/Dockerfile"], {"server", "docker", "dependencies"}),
            (["scripts/docker-valkey-smoke.sh"], {"docker"}),
            (["scripts/check-server-coverage.sh"], {"server"}),
            (["scripts/check-extension-artifacts.sh"], {"extension"}),
            (["scripts/check-store-consistency.sh"], {"store"}),
            (["extension/lib/renderer.ts", "server/go.sum"],
             {"extension", "server", "docker", "dependencies"}),
        ]
        for paths, expected in cases:
            with self.subTest(paths=paths):
                self.assertEqual(self.classify(paths), expected)

    def test_ci_and_unknown_configuration_fail_safe(self):
        for path in ["Makefile", ".github/workflows/ci.yml", "scripts/ci-changes.sh",
                     "scripts/test-ci-config.py", "new-config.json"]:
            with self.subTest(path=path):
                self.assertEqual(self.classify([path]), CHECKS)
        self.assertEqual(self.classify([], "--all"), CHECKS)

    def test_renames_keep_the_removed_source_in_scope(self):
        with tempfile.TemporaryDirectory() as tmp:
            def git(*args):
                return subprocess.check_output(["git", "-C", tmp, *args])
            git("init", "-q")
            (Path(tmp) / "source.ts").write_text("export {};\n")
            git("add", ".")
            git("-c", "user.name=CI Test", "-c", "user.email=ci@example.invalid",
                "commit", "-qm", "fixture")
            git("mv", "source.ts", "README.md")
            paths = git("diff", "--cached", "--name-only", "--no-renames", "-z")
            self.assertEqual(self.classify(paths.decode().strip("\0").split("\0")), CHECKS)

    def test_required_extension_gate_fails_for_missing_or_failed_work(self):
        workflow = (ROOT / ".github/workflows/ci.yml").read_text()
        step = workflow.split("- name: Require all selected extension checks\n", 1)[1]
        script = step.split("        run: |\n", 1)[1].split("\n  server:\n", 1)[0]
        script = "\n".join(line[10:] for line in script.splitlines())
        cases = [
            ("success", "false", "false", "skipped", "skipped", "skipped", True),
            ("success", "true", "false", "success", "success", "skipped", True),
            ("success", "false", "true", "skipped", "skipped", "success", True),
            ("success", "true", "true", "success", "success", "skipped", True),
            ("failure", "", "", "skipped", "skipped", "skipped", False),
            ("success", "true", "false", "failure", "skipped", "skipped", False),
            ("success", "true", "false", "success", "failure", "skipped", False),
            ("success", "true", "false", "skipped", "skipped", "skipped", False),
            ("success", "false", "true", "skipped", "skipped", "skipped", False),
            ("success", "false", "true", "skipped", "skipped", "cancelled", False),
        ]
        keys = ["CHANGES_RESULT", "EXTENSION_CHANGED", "SERVER_CHANGED",
                "BUILD_RESULT", "E2E_RESULT", "PROXY_RESULT"]
        for *values, success in cases:
            with self.subTest(values=values):
                result = subprocess.run(["bash", "-eo", "pipefail", "-c", script],
                                        env={**os.environ, **dict(zip(keys, values))},
                                        capture_output=True)
                self.assertEqual(result.returncode == 0, success, result.stderr.decode())


class CoverageGateTests(unittest.TestCase):
    def check_profile(self, counts):
        module = next(line.split()[1] for line in (ROOT / "server/go.mod").read_text().splitlines()
                      if line.startswith("module "))
        with tempfile.NamedTemporaryFile(mode="w") as profile:
            profile.write("mode: atomic\n")
            for package, count in counts.items():
                profile.write(f"{module}/internal/{package}/file.go:1.1,2.2 5 {count}\n")
            profile.flush()
            return subprocess.run(["bash", str(ROOT / "scripts/check-server-coverage.sh"),
                                   profile.name], capture_output=True)

    def test_all_critical_packages_have_executed_statements(self):
        result = self.check_profile({"server": 1, "runtime": 2, "metrics": 1})
        self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_missing_or_uncovered_package_fails(self):
        for counts in [{"server": 1, "runtime": 1},
                       {"server": 1, "runtime": 1, "metrics": 0},
                       {"server": 1, "runtime": 1, "metrics/subpackage": 1}]:
            with self.subTest(counts=counts):
                self.assertNotEqual(self.check_profile(counts).returncode, 0)


if __name__ == "__main__":
    unittest.main()
