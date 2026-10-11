//go:build !windows

package cfprobe

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInstanceLockRejectsLinksWithoutChangingTarget(t *testing.T) {
	for _, kind := range []string{"symbolic", "hard"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("TMPDIR", dir)
			target := filepath.Join(dir, "target")
			original := []byte("preserve this content\n")
			if err := os.WriteFile(target, original, 0o600); err != nil {
				t.Fatal(err)
			}
			lock := filepath.Join(dir, "cf-probe-test.lock")
			link := os.Symlink
			if kind == "hard" {
				link = os.Link
			}
			if err := link(target, lock); err != nil {
				t.Fatal(err)
			}
			release, err := acquireInstanceLock(Paths{ServiceName: "cf-probe-test"})
			if release != nil {
				release()
			}
			if err == nil {
				t.Fatal("expected linked lock to be rejected")
			}
			got, err := os.ReadFile(target)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != string(original) {
				t.Fatalf("target changed: %q", got)
			}
			info, err := os.Stat(target)
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != 0o600 {
				t.Fatalf("target mode changed: %v", info.Mode())
			}
		})
	}
}

func TestInstanceLockExcludesSecondInstanceAndCanBeReacquired(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	paths := Paths{ServiceName: "cf-probe-test"}
	release, err := acquireInstanceLock(paths)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	second, err := acquireInstanceLock(paths)
	if second != nil {
		second()
	}
	if err == nil {
		t.Fatal("second instance acquired the same lock")
	}
	release()
	third, err := acquireInstanceLock(paths)
	if err != nil {
		t.Fatal(err)
	}
	third()
}
