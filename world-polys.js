/**
 * world-polys.js
 * Fetches Natural Earth 110m land polygons (public domain) from a CDN and
 * exposes them as window.WORLD_POLYS — an array of rings, each ring being an
 * array of [lon, lat] pairs, exactly matching the format expected by drawGlobe().
 *
 * Source: https://www.naturalearthdata.com/  (public domain)
 * CDN:    https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_110m_land.geojson
 *
 * Usage in weather.html:
 *   <script src="world-polys.js"></script>
 *   … later, drawGlobe() checks window.WORLD_POLYS_READY before drawing.
 */

(function () {
  const CDN_URL =
    'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_110m_land.geojson';

  /**
   * Convert a GeoJSON FeatureCollection of Polygon / MultiPolygon features
   * into a flat array of rings, each ring = [[lon,lat], …].
   */
  function geojsonToRings(fc) {
    const rings = [];
    for (const feature of fc.features) {
      const geom = feature.geometry;
      if (!geom) continue;
      if (geom.type === 'Polygon') {
        // Only take the outer ring (index 0); skip holes.
        rings.push(geom.coordinates[0]);
      } else if (geom.type === 'MultiPolygon') {
        for (const poly of geom.coordinates) {
          rings.push(poly[0]);
        }
      }
    }
    return rings;
  }

  fetch(CDN_URL)
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (geojson) {
      window.WORLD_POLYS = geojsonToRings(geojson);
      window.WORLD_POLYS_READY = true;
      // Fire a custom event so the globe can redraw once data is available.
      window.dispatchEvent(new CustomEvent('worldpolysready'));
    })
    .catch(function (err) {
      console.warn('[world-polys.js] Failed to fetch Natural Earth data:', err);
      // Fall back to an empty array so the globe still renders (ocean only).
      window.WORLD_POLYS = [];
      window.WORLD_POLYS_READY = true;
      window.dispatchEvent(new CustomEvent('worldpolysready'));
    });
})();
