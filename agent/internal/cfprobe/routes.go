package cfprobe

import (
	"encoding/json"
	"io"
	"os"
	"sync"
	"time"
)

const maxRouteReportBytes = 64 * 1024

var routeReportFiles = map[string]string{
	"return_route":      "/var/lib/cfsm-return-route/zhejiang.json",
	"return_route_ipv6": "/var/lib/cfsm-return-route/zhejiang-v6.json",
	"forward_routes":    "/var/lib/cfsm-forward-route/routes.json",
}

// Scanners and probe transport share a file protocol rather than generated-code patches.
// Cache bounds filesystem/JSON work during active two-second reporting.
type routeReportCache struct {
	mu        sync.Mutex
	checkedAt time.Time
	values    map[string]json.RawMessage
}

func readRouteReport(path string) json.RawMessage {
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, maxRouteReportBytes+1))
	if err != nil || len(raw) > maxRouteReportBytes {
		return nil
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || len(object) == 0 {
		return nil
	}
	return json.RawMessage(raw)
}

func (cache *routeReportCache) fields(now time.Time) map[string]json.RawMessage {
	return cache.fieldsFromFiles(now, routeReportFiles)
}

func (cache *routeReportCache) fieldsFromFiles(now time.Time, files map[string]string) map[string]json.RawMessage {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.values == nil || now.Before(cache.checkedAt) || now.Sub(cache.checkedAt) >= time.Minute {
		cache.values = make(map[string]json.RawMessage)
		for field, path := range files {
			if value := readRouteReport(path); value != nil {
				cache.values[field] = value
			}
		}
		cache.checkedAt = now
	}
	// Callers may marshal the result outside the lock. Return an independent snapshot.
	result := make(map[string]json.RawMessage, len(cache.values))
	for field, value := range cache.values {
		result[field] = append(json.RawMessage(nil), value...)
	}
	return result
}
