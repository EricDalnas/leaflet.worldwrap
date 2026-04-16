/**
 * Leaflet.WorldWrap
 * https://github.com/edalnas/leaflet.worldwrap
 *
 * A Leaflet plugin that makes vector layers render correctly and continuously
 * across the antimeridian (the ±180° longitude line).
 *
 *
 * How it works
 * ------------
 *
 *   1. Normalises coordinates so consecutive vertices never jump more than
 *      180° of longitude (eliminating the "wrong-way" line).
 *   2. Keeps exactly one "shadow" clone of every tracked layer in each world
 *      copy that is currently visible on screen (plus a one-world buffer on
 *      each side so clones are ready before they scroll into view).
 *   3. As the user pans, shadows that scroll out of range are removed and
 *      new ones are added — all in real time on the 'move' event, not just
 *      after panning stops.
 *
 * Usage
 * -----
 *   var map = L.map('map', { worldWrap: true });
 *
 *   // That's it.  Every layer you add to this map is handled automatically.
 *   L.polyline([...]).addTo(map);
 *   L.marker([...]).addTo(map);
 *   L.geoJSON({ ... }).addTo(map);
 *
 * Options
 * -------
 *   worldWrap  {boolean}  Enable the plugin for this map.  Default: false.
 *
 * Supported layer types
 * ---------------------
 *   L.Marker, L.Circle, L.CircleMarker, L.Polyline, L.Polygon,
 *   L.Rectangle, L.GeoJSON, L.FeatureGroup, L.LayerGroup
 *   (any LayerGroup is recursed into and its children are tracked individually)
 *
 * Known limitations
 * -----------------
 *   Segments must span less than 180° of longitude.  The normalisation step
 *   works by always choosing the shorter arc between consecutive vertices.
 *   If two adjacent points are more than 180° apart (e.g. a line from 10°W
 *   to 175°E going eastward), the algorithm will choose the wrong direction
 *   and the segment will draw the long way around.  Split such segments at
 *   an intermediate point before adding them to the map.
 *
 *   Dragging a marker shadow propagates the new position back to the original
 *   and refreshes all copies.  Editing geometry with Leaflet.draw or
 *   Leaflet.transform on a shadow does not propagate back to the original.
 *
 * @author  Eric Dalnas
 * @license MIT
 * @version 2.0.0
 */
(function (factory) {
    // Support AMD (RequireJS), CommonJS (Node / Browserify / webpack),
    // and plain browser globals.
    if (typeof define === 'function' && define.amd) {
        define(['leaflet'], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('leaflet'));
    } else {
        if (typeof L === 'undefined') {
            throw new Error('Leaflet must be loaded before Leaflet.WorldWrap');
        }
        factory(L);
    }
}(function (L) {
    'use strict';

    // =========================================================================
    // Coordinate helpers
    // =========================================================================

    /**
     * Shift `lng` so it sits within 180° of `ref`.
     *
     * This is the core primitive that prevents "wrong-way" segments.  Given
     * two adjacent vertices, you call normLng(nextLng, prevLng) to ensure the
     * next point is always reached by the shorter arc, not the one that wraps
     * all the way around the globe.
     *
     * Examples:
     *   normLng(-170, 170)  →  190   (keep going east past the antimeridian)
     *   normLng( 170, -170) → -190   (keep going west past the antimeridian)
     */
    function normLng(lng, ref) {
        while (lng - ref > 180)  lng -= 360;
        while (lng - ref < -180) lng += 360;
        return lng;
    }

    /**
     * Return true if `v` looks like a Leaflet LatLng (or a plain {lat, lng}
     * object, which Leaflet accepts in most places).
     */
    function isLL(v) {
        return v instanceof L.LatLng ||
            (v && typeof v.lat === 'number' && typeof v.lng === 'number');
    }

    /**
     * Normalise a flat array of LatLng points so no two consecutive longitudes
     * differ by more than 180°.  The first point is left unchanged; every
     * subsequent point is shifted to minimise the jump from the previous.
     */
    function normRing(ll) {
        if (!ll || !ll.length) return [];
        var out = [L.latLng(ll[0].lat, ll[0].lng)];
        for (var i = 1; i < ll.length; i++) {
            out.push(L.latLng(ll[i].lat, normLng(ll[i].lng, out[i - 1].lng)));
        }
        return out;
    }

    /**
     * Recursively normalise any LatLng structure.
     *
     * Leaflet stores polyline coordinates as a flat array of LatLngs, but
     * polygons and multipolygons use nested arrays (rings inside rings).  This
     * function walks whatever structure it receives and normalises every ring.
     */
    function normCoords(c) {
        if (!c || !c.length) return c;
        // If the first element is a LatLng we have a flat ring; otherwise
        // recurse one level deeper.
        return isLL(c[0]) ? normRing(c) : c.map(normCoords);
    }

    /**
     * Return a copy of a LatLng structure with every longitude shifted by `d`
     * degrees.  Used to position shadow copies in neighbouring world strips.
     */
    function shiftCoords(c, d) {
        if (!c || !c.length) return c;
        if (isLL(c[0])) {
            return c.map(function (p) { return L.latLng(p.lat, p.lng + d); });
        }
        return c.map(function (s) { return shiftCoords(s, d); });
    }

    // =========================================================================
    // Layer helpers
    // =========================================================================

    /**
     * Return true for layer types that this plugin knows how to clone and
     * position in other world copies.
     *
     * Note the prototype order: L.Circle extends L.CircleMarker which extends
     * L.Path, and L.Polygon extends L.Polyline.  The instanceof checks in
     * cloneShifted() must test the more-specific subclass first.
     */
    function wrappable(layer) {
        return layer instanceof L.Marker       ||
               layer instanceof L.CircleMarker ||   // catches L.Circle too
               layer instanceof L.Polyline;          // catches L.Polygon / L.Rectangle too
    }

    /**
     * Attach a dragend handler to a marker shadow so that dragging the shadow
     * writes the new position back to the original marker (offset removed),
     * then triggers a full refresh so all shadows snap to the new position.
     */
    function attachShadowDrag(shadow, orig, offset, wwMap) {
        var handler = function () {
            var p = shadow.getLatLng();
            orig.setLatLng([p.lat, p.lng - offset]);
            wwMap._wwRefresh();
        };
        shadow.on('dragend', handler);
        shadow._wwDragHandler = handler;
    }

    /** Shallow-copy an options object (used to give each clone its own copy). */
    function cloneOpts(o) {
        var c = {};
        if (o) {
            for (var k in o) {
                if (o.hasOwnProperty(k)) c[k] = o[k];
            }
        }
        return c;
    }

    /**
     * Create a new layer that is an exact copy of `src` with all longitudes
     * shifted by `d` degrees.
     *
     * The clone gets the same style options, popup content, and tooltip content
     * as the original.  It is marked with `_wwShadow = true` so the plugin can
     * identify it and avoid double-tracking it.
     *
     * The prototype-chain ordering (Circle before CircleMarker, Polygon before
     * Polyline) is deliberate — without it the wrong constructor would be
     * chosen for subclasses.
     */
    function cloneShifted(src, d) {
        var o = cloneOpts(src.options);
        var cl;

        if (src instanceof L.Marker) {
            var mp = src.getLatLng();
            cl = L.marker([mp.lat, mp.lng + d], o);

        } else if (src instanceof L.Circle) {
            // Must come before CircleMarker because Circle extends CircleMarker
            var cp = src.getLatLng();
            cl = L.circle([cp.lat, cp.lng + d], o);

        } else if (src instanceof L.CircleMarker) {
            var cmp = src.getLatLng();
            cl = L.circleMarker([cmp.lat, cmp.lng + d], o);

        } else if (src instanceof L.Polygon) {
            // Must come before Polyline because Polygon extends Polyline
            cl = L.polygon(shiftCoords(src.getLatLngs(), d), o);

        } else if (src instanceof L.Polyline) {
            cl = L.polyline(shiftCoords(src.getLatLngs(), d), o);

        } else {
            return null;
        }

        // Copy popup and tooltip content.  Wrapped in try/catch because not
        // every layer type implements getPopup/getTooltip.
        try {
            if (src.getPopup()) {
                var pp = src.getPopup();
                cl.bindPopup(pp.getContent(), cloneOpts(pp.options));
            }
        } catch (_) {}

        try {
            if (src.getTooltip()) {
                var tt = src.getTooltip();
                cl.bindTooltip(tt.getContent(), cloneOpts(tt.options));
            }
        } catch (_) {}

        return cl;
    }

    // =========================================================================
    // World-index arithmetic
    // =========================================================================

    /**
     * Return an array of integer "world indices" that are currently visible in
     * the map viewport, plus a one-world buffer on each side.
     *
     * Each world is a 360°-wide longitude strip.  World 0 is the canonical
     * strip from -180° to +180°.  World -1 is -540° to -180°, world +1 is
     * +180° to +540°, and so on — exactly matching the tile offsets that
     * Leaflet's tile layer already renders.
     *
     * The +/-1 buffer means shadow copies are created one full world ahead of
     * the viewport edge, so they are already present and rendered when they
     * scroll into view — eliminating any visible pop-in during fast panning.
     *
     * Example at zoom 3 centred on the Pacific:
     *   viewport west ≈ 0°, east ≈ 360°  →  worlds [−1, 0, 1, 2]
     */
    function visibleWorlds(map) {
        var b  = map.getBounds();
        var lo = Math.floor((b.getWest() + 180) / 360) - 1;   // one buffer left
        var hi = Math.floor((b.getEast() + 180) / 360) + 1;   // one buffer right
        var out = [];
        for (var k = lo; k <= hi; k++) out.push(k);
        return out;
    }

    // =========================================================================
    // Map extension
    // =========================================================================

    // Register the worldWrap option so it appears in map.options and can be
    // passed in the L.map() constructor.
    L.Map.mergeOptions({ worldWrap: false });

    // Capture the originals before we patch them.  We call these directly when
    // adding/removing shadow layers to avoid infinite recursion through our own
    // overrides.
    var _add = L.Map.prototype.addLayer;
    var _rem = L.Map.prototype.removeLayer;

    // addInitHook runs once per map instance after the map is constructed.
    L.Map.addInitHook(function () {
        if (!this.options.worldWrap) return;

        // _wwLayers maps each original layer to its tracking record:
        //   { shadows: { [worldIndex]: shadowLayer, ... } }
        this._wwLayers = new Map();

        // _wwBusy is a simple recursion guard.  When we add or remove shadow
        // layers via _origAdd/_origRem we set this flag so our addLayer /
        // removeLayer overrides know not to try to track those shadow layers.
        this._wwBusy = false;

        // 'move' fires on every animation frame during a pan or zoom, giving
        // us real-time shadow updates.  'viewreset' fires after zoom animations
        // complete and after the map is resized.
        this.on('move zoom viewreset', this._wwRefresh, this);
    });

    L.Map.include({

        /**
         * Begin tracking a layer (or every child of a LayerGroup).
         *
         * Called automatically from our addLayer override.  Safe to call
         * multiple times — layers that are already tracked are skipped.
         */
        _wwTrack: function (layer) {
            if (!this._wwLayers || layer._wwShadow) return;

            // LayerGroups (including L.GeoJSON and L.FeatureGroup) are not
            // cloneable themselves, but we track each of their children.
            // We also listen for future children being added or removed.
            if (layer instanceof L.LayerGroup) {
                layer.eachLayer(this._wwTrack, this);
                var self = this;
                // Store handler references so they can be removed in _wwUntrack.
                var wwLayerAdd = function (e) { self._wwTrack(e.layer);   };
                var wwLayerRem = function (e) { self._wwUntrack(e.layer); };
                layer.on('layeradd',    wwLayerAdd);
                layer.on('layerremove', wwLayerRem);
                layer._wwGroupHandlers = { add: wwLayerAdd, rem: wwLayerRem };
                return;
            }

            if (!wrappable(layer) || this._wwLayers.has(layer)) return;

            // Fix antimeridian crossings in existing path coordinates before
            // we start cloning.  Without this, a Tokyo→SF polyline stored as
            // [..., 170°, -170°, ...] would draw a line across the whole map
            // instead of across the Pacific.
            if (layer instanceof L.Polyline) {
                layer.setLatLngs(normCoords(layer.getLatLngs()));
            }

            // Register the layer with an empty shadows map.
            this._wwLayers.set(layer, { shadows: {} });

            // When the *original* marker is dragged, refresh all shadows once
            // the drag ends.  We skip real-time 'move' updates for performance;
            // shadows snap to the correct position on dragend instead.
            if (layer instanceof L.Marker) {
                var wwMap = this;
                var wwDragEndHandler = function () { wwMap._wwRefresh(); };
                layer.on('dragend', wwDragEndHandler);
                layer._wwMoveHandler = wwDragEndHandler;
            }

            // Patch setStyle so that any style change on the original layer
            // (color, weight, opacity, etc.) is immediately forwarded to all
            // shadow copies.  Without this, shadows keep the style they were
            // cloned with and fall out of sync after the first setStyle call.
            if (layer.setStyle && !layer._wwStylePatched) {
                var map = this;
                // Save the original so it can be restored in _wwUntrack,
                // releasing the closure's reference to this map.
                var _hadOwn = layer.hasOwnProperty('setStyle');
                var _origSetStyle = layer.setStyle;
                layer.setStyle = function (style) {
                    // Apply to the original first.
                    _origSetStyle.call(layer, style);
                    // Then mirror to every shadow.
                    var rec = map._wwLayers && map._wwLayers.get(layer);
                    if (rec) {
                        for (var k in rec.shadows) {
                            rec.shadows[k].setStyle(style);
                        }
                    }
                    return layer;
                };
                layer._wwOrigSetStyle    = _origSetStyle;
                layer._wwHadOwnSetStyle  = _hadOwn;
                layer._wwStylePatched    = true;
            }

            // Place this layer's first round of shadows.
            this._wwRefresh();
        },

        /**
         * Stop tracking a layer and remove all of its shadow copies from the
         * map.  Called automatically from our removeLayer override.
         */
        _wwUntrack: function (layer) {
            if (layer instanceof L.LayerGroup) {
                layer.eachLayer(this._wwUntrack, this);
                // Remove the layeradd/layerremove listeners we attached in
                // _wwTrack so the group no longer holds a closure to this map.
                if (layer._wwGroupHandlers) {
                    layer.off('layeradd',    layer._wwGroupHandlers.add);
                    layer.off('layerremove', layer._wwGroupHandlers.rem);
                    delete layer._wwGroupHandlers;
                }
                return;
            }

            var rec = this._wwLayers && this._wwLayers.get(layer);
            if (!rec) return;

            // Remove every shadow clone.  _wwBusy prevents our removeLayer
            // override from trying to untrack the shadows themselves.
            this._wwBusy = true;
            for (var k in rec.shadows) {
                if (rec.shadows[k]._wwDragHandler) {
                    rec.shadows[k].off('dragend', rec.shadows[k]._wwDragHandler);
                }
                _rem.call(this, rec.shadows[k]);
            }
            this._wwBusy = false;

            this._wwLayers.delete(layer);

            // Restore the original setStyle so the patched closure (which
            // holds a reference to this map) does not prevent GC of either.
            if (layer._wwStylePatched) {
                if (layer._wwHadOwnSetStyle) {
                    layer.setStyle = layer._wwOrigSetStyle;
                } else {
                    delete layer.setStyle;   // fall back to the prototype method
                }
                delete layer._wwOrigSetStyle;
                delete layer._wwHadOwnSetStyle;
                delete layer._wwStylePatched;
            }

            // Remove the dragend listener added for original markers.
            if (layer._wwMoveHandler) {
                layer.off('dragend', layer._wwMoveHandler);
                delete layer._wwMoveHandler;
            }
        },

        /**
         * Reconcile the shadow copies for one layer against the `need` set.
         *
         * `need` is a plain object whose keys are the world indices that
         * currently require a shadow (every visible world except 0, which is
         * covered by the original layer).  It is computed once per refresh
         * cycle in _wwRefresh and passed here to avoid redundant getBounds()
         * calls when many layers are being synced in the same frame.
         *
         * Any existing shadow whose world is not in `need` is removed.
         * Any world in `need` that doesn't yet have a shadow gets one created.
         */
        _wwSync: function (layer, need) {
            var rec = this._wwLayers.get(layer);
            if (!rec) return;

            var sh = rec.shadows;

            // Remove shadows for worlds that are no longer visible.
            for (var sk in sh) {
                if (!need[sk]) {
                    if (sh[sk]._wwDragHandler) {
                        sh[sk].off('dragend', sh[sk]._wwDragHandler);
                    }
                    _rem.call(this, sh[sk]);
                    delete sh[sk];
                }
            }

            // Create shadows for worlds that just became visible;
            // update position for existing shadows of movable point layers.
            for (var nk in need) {
                var nki = parseInt(nk, 10);
                var d   = nki * 360;
                if (!sh[nk]) {
                    var cl = cloneShifted(layer, d);
                    if (cl) {
                        cl._wwShadow = true;    // prevents double-tracking
                        _add.call(this, cl);
                        sh[nk] = cl;
                        // Draggable marker shadows write back to the original
                        // on dragend so dragging any copy moves the real marker.
                        if (layer instanceof L.Marker && layer.options.draggable) {
                            attachShadowDrag(cl, layer, d, this);
                        }
                    }
                } else if (layer instanceof L.Marker ||
                           layer instanceof L.Circle ||
                           layer instanceof L.CircleMarker) {
                    // Point layers can move (drag, setLatLng) — keep the
                    // shadow's position in sync with the original.
                    var p = layer.getLatLng();
                    sh[nk].setLatLng([p.lat, p.lng + d]);
                }
            }
        },

        /**
         * Recompute the visible world set and sync every tracked layer.
         *
         * Called on every 'move', 'zoom', and 'viewreset' event.  We compute
         * getBounds() and build the `need` set exactly once here and pass it
         * into each _wwSync call, rather than recomputing it per layer.
         */
        _wwRefresh: function () {
            if (!this._wwLayers || this._wwBusy || !this._loaded) return;

            var worlds = visibleWorlds(this);

            // Build the set of world indices that need shadows.
            // World 0 is always covered by the original layer, so we skip it.
            var need = {};
            for (var i = 0; i < worlds.length; i++) {
                if (worlds[i] !== 0) need[worlds[i]] = true;
            }

            // Sync all tracked layers in a single pass.
            this._wwBusy = true;
            var self = this;
            this._wwLayers.forEach(function (_, layer) {
                self._wwSync(layer, need);
            });
            this._wwBusy = false;
        }

    });

     /**
     * Override addLayer so that any layer added to a worldWrap-enabled map is
     * automatically tracked.  The _wwBusy guard prevents shadow layers from
     * being tracked recursively.
     */
    L.Map.prototype.addLayer = function (layer) {
        _add.call(this, layer);
        if (this.options.worldWrap && !this._wwBusy) {
            this._wwTrack(layer);
        }
        return this;
    };

    /**
     * Override removeLayer so that removing any tracked layer also removes all
     * of its shadow copies.
     */
    L.Map.prototype.removeLayer = function (layer) {
        if (this.options.worldWrap && !this._wwBusy) {
            this._wwUntrack(layer);
        }
        _rem.call(this, layer);
        return this;
    };

    return L.WorldWrap;

}));
