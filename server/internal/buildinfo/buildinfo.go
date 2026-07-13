// Package buildinfo holds linker-injected release metadata.
package buildinfo

import "fmt"

// Defaults are for local/dev builds. Release CI overwrites via -ldflags -X.
var (
	Version = "dev"
	Commit  = "unknown"
	Date    = "unknown"
)

// Summary is a single-line identity string for CLI / logs.
func Summary() string {
	return fmt.Sprintf("%s (%s) built %s", Version, Commit, Date)
}
