// build-isochrones generates precomputed isochrones for the Nearme demo.
//
// Reads the saved user locations from user-locations.json, calls Valhalla for
// walk contours and OTP2 (TravelTime sandbox) for transit contours via
// route-go, writes one GeoJSON Feature per (location, mode, minutes) under
// assets/data/isochrones/, and rewrites user-locations.json so each
// isochrone slot points at the generated file.
//
// Prerequisites:
//
//	# Both engines up, typically via route-go's docker-compose:
//	cd ../../../../route-go && make docker-all
//
// Usage:
//
//	# from demo/scripts/build-isochrones:
//	go run .
//
//	# or from the demo root, pointing at the right paths:
//	go run ./scripts/build-isochrones \
//	    -user-locations assets/data/user-locations.json \
//	    -out-dir        assets/data/isochrones \
//	    -web-path       assets/data/isochrones
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/Marco-Labs/route-go/pkg/models"
	"github.com/Marco-Labs/route-go/pkg/route"
	"github.com/Marco-Labs/route-go/pkg/valhalla"
)

// Keep in sync with TIME_PRESETS in demo/assets/js/nearme/main.js.
var (
	walkContours    = []float64{5, 15, 30}
	transitContours = []float64{15, 30, 45}
)

type coord struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

type userLocation struct {
	ID           string                       `json:"id"`
	Label        string                       `json:"label"`
	Icon         string                       `json:"icon"`
	Coordinates  coord                        `json:"coordinates"`
	Isochrones   map[string]map[string]string `json:"isochrones"`
	TransitStops map[string]string            `json:"transit_stops,omitempty"`
}

type userLocationsFile struct {
	Locations []userLocation `json:"locations"`
	Meta      map[string]any `json:"meta,omitempty"`
}

func main() {
	var (
		userLocFile = flag.String("user-locations", "../../assets/data/user-locations.json",
			"Path to user-locations.json (read + rewritten).")
		outDir = flag.String("out-dir", "../../assets/data/isochrones",
			"Filesystem directory to write GeoJSON Feature files into.")
		webPath = flag.String("web-path", "assets/data/isochrones",
			"Path prefix stored in user-locations.json (relative to the HTML files served by the demo).")
		transitDir = flag.String("transit-dir", "../../assets/data/transit",
			"Filesystem directory to write the transit layer (routes.geojson + stops/).")
		gtfsPath = flag.String("gtfs", "../../../../route-go/data/gtfs/20260211_170023_TMBarcelona.zip",
			"Path to the TMB GTFS zip used to generate the transit layer.")
		valhallaURL = flag.String("valhalla-url", "http://localhost:8002", "Valhalla base URL.")
		otpURL      = flag.String("otp-url", "http://localhost:8090", "OTP2 base URL.")
		generalize  = flag.Float64("generalize", 50,
			"Douglas-Peucker simplification tolerance in meters for walk contours (0 disables).")
		timeout = flag.Duration("timeout", 60*time.Second, "Per-request timeout.")
	)
	flag.Parse()

	if err := run(runOpts{
		userLocFile: *userLocFile,
		outDir:      *outDir,
		webPath:     *webPath,
		transitDir:  *transitDir,
		gtfsPath:    *gtfsPath,
		valhallaURL: *valhallaURL,
		otpURL:      *otpURL,
		generalize:  *generalize,
		timeout:     *timeout,
	}); err != nil {
		log.Fatal(err)
	}
}

type runOpts struct {
	userLocFile, outDir, webPath, transitDir, gtfsPath, valhallaURL, otpURL string
	generalize                                                              float64
	timeout                                                                 time.Duration
}

func run(o runOpts) error {
	data, err := os.ReadFile(o.userLocFile)
	if err != nil {
		return fmt.Errorf("reading user-locations: %w", err)
	}
	var locs userLocationsFile
	if err := json.Unmarshal(data, &locs); err != nil {
		return fmt.Errorf("parsing user-locations: %w", err)
	}
	if len(locs.Locations) == 0 {
		return fmt.Errorf("no locations in %s", o.userLocFile)
	}

	if err := os.MkdirAll(o.outDir, 0o755); err != nil {
		return fmt.Errorf("creating out-dir: %w", err)
	}

	fmt.Printf("loading GTFS %s ...\n", o.gtfsPath)
	feed, err := loadGTFS(o.gtfsPath)
	if err != nil {
		return fmt.Errorf("loading gtfs: %w", err)
	}
	fmt.Printf("  %d routes, %d stops\n", len(feed.Routes), len(feed.Stops))

	routesOut := filepath.Join(o.transitDir, "routes.geojson")
	if err := writeRoutesGeoJSON(feed, routesOut); err != nil {
		return fmt.Errorf("writing routes: %w", err)
	}
	fmt.Printf("wrote %s (%d routes)\n", routesOut, len(feed.Routes))

	valhallaClient := valhalla.New(valhalla.WithBaseURL(o.valhallaURL))
	routeClient := route.New(
		route.WithValhallaURL(o.valhallaURL),
		route.WithOTPURL(o.otpURL),
	)

	stopsWebPath := filepath.ToSlash(filepath.Join(filepath.Base(o.transitDir), "stops"))
	// Reconstruct the web-served stops path relative to whatever webPath points to.
	// Callers typically pass the filesystem path a few levels below the demo root
	// and a matching web-path; we want the served path to sit next to the
	// isochrones dir under assets/data. The simplest reliable option is to
	// derive it as `<parent of webPath>/transit/stops`.
	stopsWebPath = deriveTransitStopsWebPath(o.webPath)
	now := time.Now()

	for i := range locs.Locations {
		loc := &locs.Locations[i]
		origin := models.Location{Lat: loc.Coordinates.Lat, Lon: loc.Coordinates.Lng}
		fmt.Printf("[%s] %.5f, %.5f\n", loc.ID, origin.Lat, origin.Lon)

		walkIso, err := computeWalk(valhallaClient, origin, o.generalize, o.timeout)
		if err != nil {
			return fmt.Errorf("[%s] walk: %w", loc.ID, err)
		}
		walkPaths, err := writeContours(o.outDir, o.webPath, loc.ID, "walk", walkContours, walkIso)
		if err != nil {
			return fmt.Errorf("[%s] walk write: %w", loc.ID, err)
		}

		transitIso, err := computeTransit(routeClient, origin, now, o.timeout)
		if err != nil {
			return fmt.Errorf("[%s] transit: %w", loc.ID, err)
		}
		transitPaths, err := writeContours(o.outDir, o.webPath, loc.ID, "transit", transitContours, transitIso)
		if err != nil {
			return fmt.Errorf("[%s] transit write: %w", loc.ID, err)
		}

		transitStopPaths := map[string]string{}
		for _, mins := range transitContours {
			key := roundMin(mins)
			contour := findContour(transitIso, key)
			if contour == nil {
				continue
			}
			stopFile := fmt.Sprintf("%s-%d.geojson", loc.ID, key)
			fsPath := filepath.Join(o.transitDir, "stops", stopFile)
			n, err := writeStopsInPolygon(feed, contour.Geometry, fsPath)
			if err != nil {
				return fmt.Errorf("[%s] transit stops %d: %w", loc.ID, key, err)
			}
			fmt.Printf("  %-28s  %d stops\n", stopFile, n)
			transitStopPaths[fmt.Sprintf("%d", key)] = filepath.ToSlash(filepath.Join(stopsWebPath, stopFile))
		}

		loc.Isochrones = map[string]map[string]string{
			"walk":    walkPaths,
			"transit": transitPaths,
		}
		loc.TransitStops = transitStopPaths
	}

	locs.Meta = map[string]any{
		"note": "isochrones are paths (relative to demo root) to GeoJSON Feature files. " +
			"A null/missing slot falls back to a circle in core/proximity.js. " +
			"transit_stops points at Point FeatureCollections of stops inside each transit polygon. " +
			"Regenerate with demo/scripts/build-isochrones.",
		"generated_at":       now.Format(time.RFC3339),
		"walk_generalize":    o.generalize,
		"transit_depart":     now.Format(time.RFC3339),
		"walk_contours":      walkContours,
		"transit_contours":   transitContours,
		"transit_routes_url": filepath.ToSlash(filepath.Join(deriveTransitRoutesWebPath(o.webPath), "routes.geojson")),
	}

	out, err := json.MarshalIndent(locs, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding user-locations: %w", err)
	}
	if err := os.WriteFile(o.userLocFile, append(out, '\n'), 0o644); err != nil {
		return fmt.Errorf("writing user-locations: %w", err)
	}
	fmt.Printf("\nwrote %s\n", o.userLocFile)
	return nil
}

// deriveTransitStopsWebPath assumes webPath is something like "assets/data/isochrones"
// and returns "assets/data/transit/stops".
func deriveTransitStopsWebPath(webPath string) string {
	parent := filepath.ToSlash(filepath.Dir(webPath))
	return filepath.ToSlash(filepath.Join(parent, "transit", "stops"))
}

func deriveTransitRoutesWebPath(webPath string) string {
	parent := filepath.ToSlash(filepath.Dir(webPath))
	return filepath.ToSlash(filepath.Join(parent, "transit"))
}

func findContour(iso *models.Isochrone, minutes int) *models.Contour {
	for i := range iso.Contours {
		if roundMin(iso.Contours[i].Minutes) == minutes {
			return &iso.Contours[i]
		}
	}
	return nil
}

func computeWalk(c *valhalla.Client, origin models.Location, generalize float64, timeout time.Duration) (*models.Isochrone, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	req := valhalla.IsochroneRequest{
		Location: origin,
		Costing:  models.CostingPedestrian,
		Contours: toValhallaContours(walkContours),
		Polygons: true,
	}
	if generalize > 0 {
		req.Generalize = &generalize
	}
	return c.Isochrone(ctx, req)
}

func computeTransit(c *route.Client, origin models.Location, depart time.Time, timeout time.Duration) (*models.Isochrone, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	return c.Isochrone(ctx, origin,
		route.WithMode(models.Transit),
		route.WithContours(transitContours...),
		route.WithDepartureAt(depart),
		route.WithPolygons(true),
	)
}

func toValhallaContours(mins []float64) []valhalla.Contour {
	out := make([]valhalla.Contour, len(mins))
	for i, m := range mins {
		out[i] = valhalla.Contour{Time: m}
	}
	return out
}

// writeContours writes one GeoJSON Feature per requested contour and returns
// a "minutes → web path" map for embedding in user-locations.json.
//
// Matching strategy: minutes from the response take precedence; if a requested
// contour isn't present we fall back to positional matching so the slot still
// gets filled when the engine rounds or re-orders.
func writeContours(outDir, webPath, locID, mode string, wantMins []float64, iso *models.Isochrone) (map[string]string, error) {
	byMin := make(map[int]models.Contour, len(iso.Contours))
	for _, c := range iso.Contours {
		byMin[roundMin(c.Minutes)] = c
	}

	result := make(map[string]string, len(wantMins))
	for idx, mins := range wantMins {
		key := roundMin(mins)
		c, ok := byMin[key]
		if !ok && idx < len(iso.Contours) {
			c = iso.Contours[idx]
			ok = true
		}
		if !ok {
			return nil, fmt.Errorf("missing contour %d min in %s response", key, mode)
		}

		feature := models.NewFeature(c.Geometry, map[string]any{
			"location": locID,
			"mode":     mode,
			"minutes":  key,
		})
		fname := fmt.Sprintf("%s-%s-%d.geojson", locID, mode, key)
		fpath := filepath.Join(outDir, fname)
		data, err := json.MarshalIndent(feature, "", "  ")
		if err != nil {
			return nil, err
		}
		if err := os.WriteFile(fpath, append(data, '\n'), 0o644); err != nil {
			return nil, err
		}
		fmt.Printf("  %-28s  %s\n", fname, humanSize(len(data)))
		result[fmt.Sprintf("%d", key)] = filepath.ToSlash(filepath.Join(webPath, fname))
	}
	return result, nil
}

func roundMin(m float64) int {
	if m < 0 {
		return int(m - 0.5)
	}
	return int(m + 0.5)
}

func humanSize(n int) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MiB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KiB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%d B", n)
	}
}
