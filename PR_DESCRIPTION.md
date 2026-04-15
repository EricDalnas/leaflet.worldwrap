# Pull Request: Add Leaflet.WorldWrap to plugin list

## Summary

This PR adds **Leaflet.WorldWrap** to the Leaflet plugins page under the
*Vector layers* section.

- **Plugin name:** Leaflet.WorldWrap  
- **Author:** Eric Dalnas  
- **Repository:** https://github.com/edalnas/leaflet.worldwrap  
- **License:** MIT  
- **Leaflet version:** 1.x  

## What it does

Leaflet's tile layer repeats the world seamlessly when panning east or west.
Vector layers (polylines, polygons, circles, markers) do not — they disappear
or draw incorrect geometry at the ±180° antimeridian.

Existing plugins such as `leaflet.antimeridian` solve this by **splitting**
features into two pieces at the boundary. This breaks the geometry for anything
that is circle, has a popup, or will be processed downstream.

**Leaflet.WorldWrap takes a different approach:**

1. **No splitting.** Coordinates are normalised so consecutive vertices never
   make a jump of more than 180° of longitude. A Tokyo-to-San-Francisco
   polyline stored as `[..., 170°, -170°, ...]` is corrected to
   `[..., 170°, 190°, ...]` so it draws across the Pacific, not across Eurasia.

2. **Shadow copies.** One clone of each tracked layer is maintained per
   visible world copy, shifted by the appropriate multiple of 360°. Clones are
   created and destroyed in real time on the `move` event as the user pans,
   so there is no pop-in after panning stops.

3. **Zero API changes.** A single map option enables the plugin:
   ```js
   L.map('map', { worldWrap: true });
   ```
   All layers added to that map — including GeoJSON, FeatureGroups, and any
   LayerGroup — are handled automatically.

## Supported layer types

`L.Marker`, `L.Circle`, `L.CircleMarker`, `L.Polyline`, `L.Polygon`,
`L.Rectangle`, `L.GeoJSON`, `L.FeatureGroup`, `L.LayerGroup`

## Demo

https://edalnas.github.io/leaflet.worldwrap/demo.html

---

*Plugin entry for `plugins.md`:*

```
- **[Leaflet.WorldWrap](https://github.com/edalnas/leaflet.worldwrap)**
  Seamlessly wraps vector layers (polylines, polygons, circles, markers,
  GeoJSON) across the antimeridian without splitting them. Features are
  normalised and duplicated into every visible world copy in real time.
```
