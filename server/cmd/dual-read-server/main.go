package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/skys-mission/dual-read/server/internal/buildinfo"
	"github.com/skys-mission/dual-read/server/internal/config"
	"github.com/skys-mission/dual-read/server/internal/server"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "config":
			os.Exit(runConfig(os.Args[2:]))
		case "serve":
			os.Exit(runServe(os.Args[2:]))
		case "version", "-version", "--version":
			fmt.Println(buildinfo.Summary())
			os.Exit(0)
		case "help", "-h", "--help":
			printUsage()
			os.Exit(0)
		}
	}
	// Default: serve (back-compat with historical flag-only invocation).
	os.Exit(runServe(os.Args[1:]))
}

func printUsage() {
	fmt.Fprintf(os.Stderr, `dual-read-server — Dual Read translation gateway

Usage:
  dual-read-server [serve] [-config PATH] [-data-dir DIR]
  dual-read-server config check  [-data-dir DIR]
  dual-read-server config migrate --from v1 [-data-dir DIR] [-dry-run]
  dual-read-server version

`)
}

func runServe(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var configPath string
	var dataDir string
	fs.StringVar(&configPath, "config", "", "path to bootstrap TOML (optional; static listen/admin settings)")
	fs.StringVar(&dataDir, "data-dir", "", "directory for runtime.json + secrets.json (default: data or DUAL_READ_DATA_DIR)")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	store, err := config.Open(config.OpenOptions{
		BootstrapPath: configPath,
		DataDir:       dataDir,
	})
	if err != nil {
		_, _ = os.Stderr.WriteString("failed to open config: " + err.Error() + "\n")
		return 1
	}

	cfg, err := store.Effective()
	if err != nil {
		_, _ = os.Stderr.WriteString("failed to load config: " + err.Error() + "\n")
		return 1
	}

	srv, err := server.New(store)
	if err != nil {
		_, _ = os.Stderr.WriteString("failed to create server: " + err.Error() + "\n")
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	fmt.Fprintf(os.Stderr, "tip: open admin at http://%s:%d%s\n", cfg.Server.Host, cfg.Server.Port, cfg.Admin.Path)
	fmt.Fprintf(os.Stderr, "tip: runtime config at %s\n", store.RuntimePath())
	fmt.Fprintf(os.Stderr, "tip: secrets file at %s\n", store.SecretsPath())

	if err := srv.Run(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		_, _ = os.Stderr.WriteString("server error: " + err.Error() + "\n")
		return 1
	}
	return 0
}

func runConfig(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: dual-read-server config <check|migrate> …")
		return 2
	}
	switch args[0] {
	case "check":
		return runConfigCheck(args[1:])
	case "migrate":
		return runConfigMigrate(args[1:])
	default:
		fmt.Fprintf(os.Stderr, "unknown config subcommand %q\n", args[0])
		return 2
	}
}

func runConfigCheck(args []string) int {
	fs := flag.NewFlagSet("config check", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var dataDir string
	fs.StringVar(&dataDir, "data-dir", "", "data directory (default: data)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	res, err := config.CheckDataDir(dataDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		return 1
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(res)
	if !res.OK {
		return 1
	}
	return 0
}

func runConfigMigrate(args []string) int {
	fs := flag.NewFlagSet("config migrate", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var dataDir string
	var from string
	var dryRun bool
	fs.StringVar(&dataDir, "data-dir", "", "data directory (default: data)")
	fs.StringVar(&from, "from", "", "source schema (required: v1)")
	fs.BoolVar(&dryRun, "dry-run", false, "print plan without writing")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if from != "v1" {
		fmt.Fprintln(os.Stderr, "config migrate requires --from v1")
		return 2
	}
	res, err := config.MigrateV1ToV2(config.MigrateOptions{DataDir: dataDir, DryRun: dryRun})
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		return 1
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(res)
	return 0
}
