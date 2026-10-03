package cfprobe

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRouteReportsValidateAndBoundFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "routes.json")
	for _, raw := range []string{"broken", "null", "[]", "{}", `{"telecom":"` + strings.Repeat("x", maxRouteReportBytes) + `"}`} {
		if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		if got := readRouteReport(path); got != nil {
			t.Fatalf("accepted invalid or oversized report (%d bytes)", len(raw))
		}
	}
	if readRouteReport(path+".missing") != nil {
		t.Fatal("missing file must be omitted")
	}
	if err := os.WriteFile(path, []byte(`{"telecom":"CN2","probed_at":"2026-10-03T00:00:00Z"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if !json.Valid(readRouteReport(path)) {
		t.Fatal("valid route object should be included")
	}
}

func TestRouteReportCacheRefreshAndSnapshotIsolation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "routes.json")
	if err := os.WriteFile(path, []byte(`{"telecom":"CN2"}`), 0600); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{"return_route": path}
	var cache routeReportCache
	now := time.Now()
	first := cache.fieldsFromFiles(now, files)
	first["return_route"][0] = '!'
	if !json.Valid(cache.fieldsFromFiles(now.Add(time.Second), files)["return_route"]) {
		t.Fatal("caller mutated cached bytes")
	}
	if err := os.WriteFile(path, []byte(`{"telecom":"163"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(cache.fieldsFromFiles(now.Add(30*time.Second), files)["return_route"]), "CN2") {
		t.Fatal("cache should bound repeated reads")
	}
	if !strings.Contains(string(cache.fieldsFromFiles(now.Add(time.Minute), files)["return_route"]), "163") {
		t.Fatal("new scanner result was not refreshed")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if len(cache.fieldsFromFiles(now.Add(2*time.Minute), files)) != 0 {
		t.Fatal("deleted report must no longer be sent")
	}
}

func TestPublicIPv4OverrideSurvivesConfigRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.conf")
	cfg := defaultConfig()
	cfg.PublicIPv4 = "192.0.2.10"
	if err := writeConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	got, err := readConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.PublicIPv4 != cfg.PublicIPv4 {
		t.Fatal("local NAT override was lost")
	}
	cfg.PublicIPv4 = "2001:db8::10"
	if err := writeConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	got, err = readConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.PublicIPv4 != "" {
		t.Fatal("IPv6 must not be used as an IPv4 override")
	}
}
