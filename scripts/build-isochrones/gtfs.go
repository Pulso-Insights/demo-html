// GTFS parsing + transit layer generation for the Nearme demo.
//
// Produces two kinds of assets:
//
//   - demo/assets/data/transit/routes.geojson (shared) — one LineString per
//     route, using a representative (longest) shape. Properties include
//     short/long names, route_type, and route_color.
//   - demo/assets/data/transit/stops/{loc}-{min}.geojson — Point features for
//     stops (location_type=0) inside a given transit isochrone polygon.
//
// Only the four GTFS files we need are parsed; stop_times.txt (60 MB) is
// ignored — we don't care about schedules here.
package main

import (
	"archive/zip"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"

	"github.com/pulso-codes/route-go/pkg/models"
)

type gtfsStop struct {
	ID       string
	Name     string
	Lat      float64
	Lon      float64
	LocType  int
	RouteIDs []string // routes serving this stop, sorted
}

type gtfsRoute struct {
	ID         string
	ShortName  string
	LongName   string
	Type       int
	Color      string // "#RRGGBB" or ""
	TextColor  string
	ShapePts   [][2]float64 // longest shape for this route, as [lon, lat]
}

type gtfsFeed struct {
	Stops      []gtfsStop
	Routes     []gtfsRoute
	routesByID map[string]gtfsRoute // lookup for enriching stops
}

// loadGTFS reads stops, routes, trips, and shapes from a GTFS zip and picks
// one representative (longest) shape per route.
func loadGTFS(zipPath string) (*gtfsFeed, error) {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return nil, fmt.Errorf("open gtfs zip: %w", err)
	}
	defer zr.Close()

	readCSV := func(name string, fn func(row map[string]string) error) error {
		for _, f := range zr.File {
			if f.Name != name {
				continue
			}
			rc, err := f.Open()
			if err != nil {
				return err
			}
			defer rc.Close()
			return parseCSV(rc, fn)
		}
		return fmt.Errorf("gtfs: %s not found in zip", name)
	}

	// Stops.
	var stops []gtfsStop
	err = readCSV("stops.txt", func(row map[string]string) error {
		lat, _ := strconv.ParseFloat(row["stop_lat"], 64)
		lon, _ := strconv.ParseFloat(row["stop_lon"], 64)
		loc, _ := strconv.Atoi(row["location_type"])
		stops = append(stops, gtfsStop{
			ID:      row["stop_id"],
			Name:    row["stop_name"],
			Lat:     lat,
			Lon:     lon,
			LocType: loc,
		})
		return nil
	})
	if err != nil {
		return nil, err
	}

	// Routes (metadata).
	routeMeta := map[string]gtfsRoute{}
	err = readCSV("routes.txt", func(row map[string]string) error {
		t, _ := strconv.Atoi(row["route_type"])
		routeMeta[row["route_id"]] = gtfsRoute{
			ID:        row["route_id"],
			ShortName: row["route_short_name"],
			LongName:  row["route_long_name"],
			Type:      t,
			Color:     hexColor(row["route_color"]),
			TextColor: hexColor(row["route_text_color"]),
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	// Trips map each route to its shape candidates, and each trip to its route
	// (needed to join stop_times → routes per stop).
	routeShapes := map[string]map[string]bool{}
	tripRoute := map[string]string{}
	err = readCSV("trips.txt", func(row map[string]string) error {
		routeID := row["route_id"]
		tripID := row["trip_id"]
		shapeID := row["shape_id"]
		if routeID != "" && tripID != "" {
			tripRoute[tripID] = routeID
		}
		if routeID == "" || shapeID == "" {
			return nil
		}
		m, ok := routeShapes[routeID]
		if !ok {
			m = map[string]bool{}
			routeShapes[routeID] = m
		}
		m[shapeID] = true
		return nil
	})
	if err != nil {
		return nil, err
	}

	// stop_times is big (~60 MB, a few M rows). We only keep the stop_id →
	// route_id relationship via the trip lookup.
	stopRouteSet := map[string]map[string]bool{}
	err = readCSV("stop_times.txt", func(row map[string]string) error {
		routeID, ok := tripRoute[row["trip_id"]]
		if !ok {
			return nil
		}
		stopID := row["stop_id"]
		if stopID == "" {
			return nil
		}
		m, ok := stopRouteSet[stopID]
		if !ok {
			m = map[string]bool{}
			stopRouteSet[stopID] = m
		}
		m[routeID] = true
		return nil
	})
	if err != nil {
		return nil, err
	}

	// Collect all shape points grouped by shape_id (only for shapes we use).
	wantedShapes := map[string]bool{}
	for _, shapes := range routeShapes {
		for s := range shapes {
			wantedShapes[s] = true
		}
	}
	type shapeRow struct {
		Seq int
		Pt  [2]float64
	}
	shapePts := map[string][]shapeRow{}
	err = readCSV("shapes.txt", func(row map[string]string) error {
		id := row["shape_id"]
		if !wantedShapes[id] {
			return nil
		}
		lat, _ := strconv.ParseFloat(row["shape_pt_lat"], 64)
		lon, _ := strconv.ParseFloat(row["shape_pt_lon"], 64)
		seq, _ := strconv.Atoi(row["shape_pt_sequence"])
		shapePts[id] = append(shapePts[id], shapeRow{Seq: seq, Pt: [2]float64{lon, lat}})
		return nil
	})
	if err != nil {
		return nil, err
	}

	// Sort each shape by sequence, drop malformed.
	shapeLines := map[string][][2]float64{}
	for id, rows := range shapePts {
		sort.Slice(rows, func(i, j int) bool { return rows[i].Seq < rows[j].Seq })
		pts := make([][2]float64, 0, len(rows))
		for _, r := range rows {
			pts = append(pts, r.Pt)
		}
		if len(pts) >= 2 {
			shapeLines[id] = pts
		}
	}

	// For each route, pick the longest (most points) shape as representative.
	var routes []gtfsRoute
	for routeID, shapeSet := range routeShapes {
		meta, ok := routeMeta[routeID]
		if !ok {
			continue
		}
		var bestPts [][2]float64
		for shapeID := range shapeSet {
			pts := shapeLines[shapeID]
			if len(pts) > len(bestPts) {
				bestPts = pts
			}
		}
		if len(bestPts) < 2 {
			continue
		}
		meta.ShapePts = bestPts
		routes = append(routes, meta)
	}
	sort.Slice(routes, func(i, j int) bool {
		if routes[i].Type != routes[j].Type {
			return routes[i].Type < routes[j].Type
		}
		return routes[i].ShortName < routes[j].ShortName
	})

	// Index routes by ID and attach route-id lists to each stop.
	routesByID := make(map[string]gtfsRoute, len(routes))
	for _, r := range routes {
		routesByID[r.ID] = r
	}
	for i := range stops {
		if set, ok := stopRouteSet[stops[i].ID]; ok {
			ids := make([]string, 0, len(set))
			for id := range set {
				if _, hasMeta := routesByID[id]; hasMeta {
					ids = append(ids, id)
				}
			}
			sort.Slice(ids, func(a, b int) bool {
				ra, rb := routesByID[ids[a]], routesByID[ids[b]]
				if ra.Type != rb.Type {
					return ra.Type < rb.Type // metro (1) before bus (3)
				}
				return ra.ShortName < rb.ShortName
			})
			stops[i].RouteIDs = ids
		}
	}

	return &gtfsFeed{Stops: stops, Routes: routes, routesByID: routesByID}, nil
}

func parseCSV(r io.Reader, fn func(row map[string]string) error) error {
	reader := csv.NewReader(r)
	reader.FieldsPerRecord = -1
	header, err := reader.Read()
	if err != nil {
		return err
	}
	for {
		rec, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		row := make(map[string]string, len(header))
		for i, h := range header {
			if i < len(rec) {
				row[h] = rec[i]
			}
		}
		if err := fn(row); err != nil {
			return err
		}
	}
	return nil
}

func hexColor(c string) string {
	if c == "" {
		return ""
	}
	return "#" + c
}

// writeRoutesGeoJSON writes one Feature per route as a FeatureCollection.
func writeRoutesGeoJSON(feed *gtfsFeed, outPath string) error {
	features := make([]models.GeoJSONFeature, 0, len(feed.Routes))
	for _, r := range feed.Routes {
		coords, err := json.Marshal(r.ShapePts)
		if err != nil {
			return err
		}
		props := map[string]any{
			"route_id":    r.ID,
			"short_name":  r.ShortName,
			"long_name":   r.LongName,
			"route_type":  r.Type,
			"color":       r.Color,
			"text_color":  r.TextColor,
		}
		features = append(features, models.NewFeature(models.GeoJSONGeometry{
			Type:        "LineString",
			Coordinates: coords,
		}, props))
	}
	fc := models.NewFeatureCollection(features...)
	return writeJSON(outPath, fc)
}

// writeStopsInPolygon filters stops (location_type=0) inside the polygon
// geometry and writes them as a Point FeatureCollection.
func writeStopsInPolygon(feed *gtfsFeed, poly models.GeoJSONGeometry, outPath string) (int, error) {
	rings, err := decodePolygon(poly)
	if err != nil {
		return 0, err
	}

	features := make([]models.GeoJSONFeature, 0, 256)
	for _, s := range feed.Stops {
		if s.LocType != 0 {
			continue
		}
		if !pointInPolygons(s.Lon, s.Lat, rings) {
			continue
		}
		coords, err := json.Marshal([2]float64{s.Lon, s.Lat})
		if err != nil {
			return 0, err
		}
		routesInfo := make([]map[string]any, 0, len(s.RouteIDs))
		for _, rID := range s.RouteIDs {
			r, ok := feed.routesByID[rID]
			if !ok {
				continue
			}
			routesInfo = append(routesInfo, map[string]any{
				"short_name": r.ShortName,
				"long_name":  r.LongName,
				"color":      r.Color,
				"text_color": r.TextColor,
				"route_type": r.Type,
			})
		}
		features = append(features, models.NewFeature(models.GeoJSONGeometry{
			Type:        "Point",
			Coordinates: coords,
		}, map[string]any{
			"stop_id":   s.ID,
			"stop_name": s.Name,
			"routes":    routesInfo,
		}))
	}
	fc := models.NewFeatureCollection(features...)
	if err := writeJSON(outPath, fc); err != nil {
		return 0, err
	}
	return len(features), nil
}

func writeJSON(outPath string, v any) error {
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(outPath, append(data, '\n'), 0o644)
}

// decodePolygon unpacks a GeoJSON Polygon or MultiPolygon into a flat list of
// ring-groups (each group is one polygon: outer ring + optional holes). Ray
// casting treats each group independently.
func decodePolygon(g models.GeoJSONGeometry) ([][][][2]float64, error) {
	switch g.Type {
	case "Polygon":
		var rings [][][]float64
		if err := json.Unmarshal(g.Coordinates, &rings); err != nil {
			return nil, err
		}
		return [][][][2]float64{ringsToPairs(rings)}, nil
	case "MultiPolygon":
		var polys [][][][]float64
		if err := json.Unmarshal(g.Coordinates, &polys); err != nil {
			return nil, err
		}
		out := make([][][][2]float64, 0, len(polys))
		for _, p := range polys {
			out = append(out, ringsToPairs(p))
		}
		return out, nil
	default:
		return nil, fmt.Errorf("unsupported geometry %q", g.Type)
	}
}

func ringsToPairs(rings [][][]float64) [][][2]float64 {
	out := make([][][2]float64, 0, len(rings))
	for _, ring := range rings {
		pairs := make([][2]float64, 0, len(ring))
		for _, p := range ring {
			if len(p) < 2 {
				continue
			}
			pairs = append(pairs, [2]float64{p[0], p[1]})
		}
		out = append(out, pairs)
	}
	return out
}

// pointInPolygons returns true if the point is inside at least one polygon's
// outer ring and not in any of its holes. Handles MultiPolygon.
func pointInPolygons(lon, lat float64, polys [][][][2]float64) bool {
	for _, rings := range polys {
		if len(rings) == 0 {
			continue
		}
		if !pointInRing(lon, lat, rings[0]) {
			continue
		}
		inHole := false
		for _, hole := range rings[1:] {
			if pointInRing(lon, lat, hole) {
				inHole = true
				break
			}
		}
		if !inHole {
			return true
		}
	}
	return false
}

// pointInRing uses the ray-casting algorithm. Ring is a closed polygon
// (first == last point) but we don't depend on that.
func pointInRing(lon, lat float64, ring [][2]float64) bool {
	inside := false
	n := len(ring)
	for i, j := 0, n-1; i < n; j, i = i, i+1 {
		xi, yi := ring[i][0], ring[i][1]
		xj, yj := ring[j][0], ring[j][1]
		intersect := ((yi > lat) != (yj > lat)) &&
			(lon < (xj-xi)*(lat-yi)/(yj-yi)+xi)
		if intersect {
			inside = !inside
		}
	}
	return inside
}
