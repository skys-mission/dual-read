package buildinfo_test

import (
	"strings"
	"testing"

	"github.com/skys-mission/dual-read/server/internal/buildinfo"
)

func TestSummaryContainsFields(t *testing.T) {
	s := buildinfo.Summary()
	if !strings.Contains(s, buildinfo.Version) {
		t.Fatalf("summary %q missing version", s)
	}
	if !strings.Contains(s, buildinfo.Commit) {
		t.Fatalf("summary %q missing commit", s)
	}
	if !strings.Contains(s, buildinfo.Date) {
		t.Fatalf("summary %q missing date", s)
	}
}
