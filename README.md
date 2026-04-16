# Leaflet.WorldWrap

A [Leaflet](https://leafletjs.com) plugin that makes vector layers render
correctly and continuously across the antimeridian (the ±180° longitude line).

**[Live Demo](https://ericdalnas.github.io/leaflet.worldwrap/demo.html)** — pan east or west, zoom in and out, and watch features appear seamlessly in every world copy.

## The Problem

Leaflet's tile layer already repeats the world seamlessly when you pan left or
right. Vector layers do not. A route crossing the Pacific disappears at ±180°,
or draws a line straight across the entire map in the wrong direction.

Other approaches split the feature into two pieces at the antimeridian. This
breaks the geometry, the popup, any downstream GIS processing, and looks wrong
at the seam.

## The Approach

1. Coordinates are **normalised** so consecutive vertices never jump more than
   180° of longitude, eliminating the "wrong-way" line across the map.
2. A **shadow clone** is maintained for every tracked layer in each world copy
   that is currently visible on screen (plus a one-world buffer on each side so
   clones exist before they scroll into view).
3. As you pan, stale shadows are **removed** and new ones are **created** in
   real time on Leaflet's `move` event — not just after panning stops — so
   there is no visible pop-in during fast panning.

## Installation

**Script tag:**
```html
<script src="leaflet.worldwrap.js"></script>
```

## Usage

Pass `worldWrap: true` when creating your map. Every layer you add after that
is handled automatically — no changes to your layer code required. worldCopyJump should be set to false (this is the default).

```js
var map = L.map('map', {
    worldWrap: true,
    center: [10, 180],
    zoom: 3
});

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

// These all just work — no special handling needed:
L.polyline([[35, 139], [40, -150], [37, -122]]).addTo(map);
L.polygon([[-12, 176], [-12, -179], [-22, -179], [-22, 176]]).addTo(map);
L.circle([0, 180], { radius: 800000 }).addTo(map);
L.marker([21, -157]).addTo(map);
L.geoJSON(myGeoJsonData).addTo(map);
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `worldWrap` | `boolean` | `false` | Enable world-wrapping for this map. |

## Supported Layer Types

| Type | Notes |
|---|---|
| `L.Marker` | Shadow markers update in real time during drag. |
| `L.Circle` | Shadow placed at shifted centre; radius unchanged. |
| `L.CircleMarker` | Pixel-radius circle; only centre is shifted. |
| `L.Polyline` | Coordinates normalised to prevent wrong-way lines. |
| `L.Polygon` | Includes `L.Rectangle`. Rings are each normalised. |
| `L.GeoJSON` | Each child feature is tracked individually. |
| `L.FeatureGroup` | Each child layer is tracked individually. |
| `L.LayerGroup` | Recurses into children; watches for future adds/removes. |

## How It Works — World Index Arithmetic

The map viewport spans some range of longitude, e.g. 90°W to 270°E when
looking at the Pacific. Leaflet divides the longitude line into 360°-wide
strips called **world copies**. World 0 is −180° to +180°. World −1 is
−540° to −180°. World +1 is +180° to +540°, and so on.

```js
// World index from a longitude:
Math.floor((lng + 180) / 360)
```

On every `move` event the plugin computes which world indices are visible,
adds a shadow shifted by `k × 360°` for each visible world `k ≠ 0`, and
removes any shadow for a world that is no longer visible.

## Known Limitations

- **Segments must span less than 180° of longitude**: The normalisation step
  always chooses the shorter arc between consecutive vertices. If two adjacent
  points are more than 180° apart (e.g. a line from 10°W to 175°E going
  eastward), the algorithm will pick the wrong direction and the segment will
  draw the long way around. Split such segments at an intermediate point before
  adding them to the map.

- **Editing geometry shadows**: Dragging a marker shadow propagates the new
  position back to the original and refreshes all copies. However, editing
  polygon or polyline geometry on a shadow with Leaflet.draw or
  Leaflet.transform does not propagate back to the original.

- **Performance with large layer counts**: Each tracked layer gets one full
  Leaflet clone per visible world copy (typically 2–4 at normal zoom levels).
  For small to medium datasets this is negligible. At large scales — thousands
  of features, or a dense GeoJSON layer — the overhead of maintaining and
  rendering that many extra SVG/Canvas elements can become noticeable.

## Browser / Leaflet Compatibility

Tested against Leaflet 1.9.x. Should work with any Leaflet 1.x build.
No external dependencies beyond Leaflet itself.

ES5-compatible; no transpilation required.

## Contributing

Bug reports and pull requests are welcome on
[GitHub](https://github.com/edalnas/leaflet.worldwrap).

## License

MIT © [Eric Dalnas](https://github.com/edalnas)
