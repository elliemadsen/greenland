// === CONFIG ===
const TIMELINE_SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vS4vK_K5j7xcOA8Xj0emE_oXbSe1dYFDuXJi2ytNcvKprG_5qMja_U9uH6ZFd5n51gmfd6rqOibu-90/pub?gid=301895579&single=true&output=csv";

// List of possible extensions
const extensions = ["jpg", "jpeg", "png", "webp"];

// Parsed rows from the timeline sheet, in original sheet order. Declared
// this early because computeYearLayout() (called eagerly below, before the
// CSV has loaded) reads it -- referencing a `let` before its own later
// declaration line runs is a ReferenceError, not just an empty array.
let timelineRows = [];

// Function to get the existing file path
function getExistingImagePath(baseName) {
  for (const ext of extensions) {
    const path = `img/${baseName}.${ext}`;
    try {
      const request = new XMLHttpRequest();
      request.open("HEAD", path, false); // synchronous
      request.send();
      if (request.status !== 404) {
        return path; // found a valid file
      }
    } catch (err) {
      // ignore
    }
  }
  return null; // no file found
}

// === MapLibre Basemap ===
const DEFAULT_MAP_CENTER = [-42, 71];
const DEFAULT_MAP_ZOOM = 2.6;
const CLOSEUP_MAP_ZOOM = 9;
const SLIGHT_ZOOM_LEVEL = 5.5; // "Zoom in slightly" -- e.g. the DYE cluster, several sites at once

const map = new maplibregl.Map({
  container: "map",
  style: `https://api.maptiler.com/maps/hybrid/style.json?key=q2l5v7peOG9LJxJlnEZ2`,
  center: DEFAULT_MAP_CENTER,
  zoom: DEFAULT_MAP_ZOOM,
  pitch: 0,
  interactive: false,
  attributionControl: false,
});

map.on("style.load", () => {
  // Mercator flattens high-latitude landmasses like Greenland into a wildly
  // oversized, stretched shape. Globe projection renders true relative size.
  map.setProjection({ type: "globe" });
});

map.on("load", () => {
  // Remove all text and label layers
  map.getStyle().layers.forEach((layer) => {
    if (layer.type === "symbol") {
      map.removeLayer(layer.id);
    }
  });

  // The satellite imagery over the Greenland ice sheet interior is often
  // close to featureless flat grey/white at closeup zoom levels (real snow
  // surface with little color variation, and/or coarse source imagery over
  // such a remote area). A hillshade layer computed from actual elevation
  // data reveals real surface relief (crevasse fields, sastrugi, ice domes)
  // that flat color imagery alone doesn't show.
  map.addSource("terrain-rgb", {
    type: "raster-dem",
    url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=q2l5v7peOG9LJxJlnEZ2`,
    tileSize: 256,
  });
  map.addLayer({
    id: "hillshade",
    type: "hillshade",
    source: "terrain-rgb",
    paint: {
      "hillshade-exaggeration": 0.9,
    },
  });

  // Add a dark overlay to dim the satellite imagery
  map.addLayer({
    id: "darken-overlay",
    type: "background",
    paint: {
      "background-color": "rgba(0, 0, 0, 0.35)",
    },
    before: map.getStyle().layers[0]?.id,
  });
  // map is ready for markers
  mapReady = true;
  // The CSV fetch and this map "load" event race each other -- whichever
  // finishes first must not skip this (precomputeSiteLabelOffsets no-ops
  // until both mapReady and siteGroups are in place, so calling it from
  // both finish lines is what actually guarantees it always runs once).
  precomputeSiteLabelOffsets();
  // ensure any events that should be visible at initial position get added
  updateScrollMarker();
});

// Create a small DOM element for a site marker (dot + label). The dot's
// color and the label's text are set later and can change over time (a site
// can be renamed, transferred, or decommissioned) via updateMapForYear.
function createSiteMarkerElement() {
  const el = document.createElement("div");
  el.className = "event-marker";
  const dot = document.createElement("span");
  dot.className = "dot";
  const label = document.createElement("span");
  label.className = "label";
  el.appendChild(dot);
  el.appendChild(label);
  return el;
}

// Measure and compute horizontal offset so the DOT (not the whole element,
// which includes the label) is centered exactly at the map coordinate, and
// fold in that site's precomputed (one-time, not dynamic) label-repulsion
// offset. Done after layout has a chance to flush so label sizes are
// accurate, and re-run whenever the label text changes length (e.g. a rename).
function centerMarkerDot(marker, el, siteKey) {
  requestAnimationFrame(() => {
    try {
      const dot = el.querySelector(".dot");
      if (dot) {
        const elRect = el.getBoundingClientRect();
        const dotRect = dot.getBoundingClientRect();
        const dotCenter = dotRect.left - elRect.left + dotRect.width / 2;
        const elCenter = elRect.width / 2;
        const offsetX = Math.round(elCenter - dotCenter);
        const repulsion = siteLabelOffsets.get(siteKey) || { dx: 0, dy: 0 };
        marker.setOffset([offsetX + repulsion.dx, repulsion.dy]);
      }
    } catch (err) {
      console.warn("Could not compute event marker offset:", err);
    }
  });
}

function addSiteMarker(site, status) {
  if (!mapReady) return;
  const el = createSiteMarkerElement();
  el.querySelector(".label").textContent = status.name;
  if (status.state !== "active") el.classList.add(status.state);

  const marker = new maplibregl.Marker({ element: el, anchor: "center" })
    .setLngLat([site.lon, site.lat])
    .addTo(map);

  centerMarkerDot(marker, el, site.key);
  activeSiteMarkers.set(site.key, {
    marker,
    el,
    lastName: status.name,
    lastState: status.state,
  });
}

function removeSiteMarker(site) {
  const entry = activeSiteMarkers.get(site.key);
  if (entry) {
    entry.marker.remove();
    activeSiteMarkers.delete(site.key);
  }
}

// Show a dot for each site once its (first) start year is reached, hide
// ones that haven't started yet, and update label/color in place as sites
// get renamed, transferred, or decommissioned while scrolling through years.
const currentYearBadge = document.getElementById("current-year-badge");

function updateMapForYear(currentYear, contentOffset) {
  if (currentYearBadge) currentYearBadge.textContent = currentYear;

  if (!Array.isArray(siteGroups)) return;
  siteGroups.forEach((site) => {
    const status = getSiteStatusAtOffset(site, contentOffset);
    const entry = activeSiteMarkers.get(site.key);

    if (!status) {
      if (entry) removeSiteMarker(site);
      return;
    }

    if (!entry) {
      addSiteMarker(site, status);
      return;
    }

    if (entry.lastName !== status.name || entry.lastState !== status.state) {
      entry.el.querySelector(".label").textContent = status.name;
      entry.el.classList.remove("transferred", "abandoned");
      if (status.state !== "active") entry.el.classList.add(status.state);
      entry.lastName = status.name;
      entry.lastState = status.state;
      centerMarkerDot(entry.marker, entry.el, site.key);
    }
  });

  updateRowCamera(contentOffset);
}

// Label positions are computed ONCE (not on every map move/pan/zoom), so
// they never wobble as the camera flies around -- a fixed pixel offset per
// site, applied via the marker's own setOffset alongside its dot-centering
// offset (see centerMarkerDot), which MapLibre re-projects correctly on its
// own without any further recalculation needed.
let siteLabelOffsets = new Map();

function precomputeSiteLabelOffsets() {
  siteLabelOffsets = new Map();
  if (!mapReady || siteGroups.length === 0) return;

  // Measure each site's label off-screen using its eventual/final name, so
  // the separation math has realistic sizes even for sites that haven't
  // appeared yet chronologically.
  const measureHost = document.createElement("div");
  measureHost.style.position = "fixed";
  measureHost.style.visibility = "hidden";
  measureHost.style.whiteSpace = "nowrap";
  measureHost.className = "event-marker";
  document.body.appendChild(measureHost);

  const items = siteGroups.map((site) => {
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = currentSiteName(site);
    measureHost.innerHTML = "";
    measureHost.appendChild(label);
    const rect = label.getBoundingClientRect();
    const pos = map.project([site.lon, site.lat]);
    return {
      site,
      baseX: pos.x,
      baseY: pos.y,
      width: rect.width || 60,
      height: rect.height || 16,
      dx: 0,
      dy: 0,
    };
  });
  measureHost.remove();

  const pad = 4;
  const maxDrift = 36;
  for (let iter = 0; iter < 40; iter++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        const ax = a.baseX + a.dx;
        const ay = a.baseY + a.dy;
        const bx = b.baseX + b.dx;
        const by = b.baseY + b.dy;

        const overlapX = (a.width + b.width) / 2 + pad - Math.abs(ax - bx);
        const overlapY = (a.height + b.height) / 2 + pad - Math.abs(ay - by);

        if (overlapX > 0 && overlapY > 0) {
          moved = true;
          if (overlapX < overlapY) {
            const dir = ax <= bx ? -1 : 1;
            a.dx += dir * overlapX * 0.5;
            b.dx -= dir * overlapX * 0.5;
          } else {
            const dir = ay <= by ? -1 : 1;
            a.dy += dir * overlapY * 0.5;
            b.dy -= dir * overlapY * 0.5;
          }
        }
      }
    }
    if (!moved) break;
  }

  items.forEach((item) => {
    siteLabelOffsets.set(item.site.key, {
      dx: Math.max(-maxDrift, Math.min(maxDrift, item.dx)),
      dy: Math.max(-maxDrift, Math.min(maxDrift, item.dy)),
    });
  });

  // Refresh any markers that were already placed before offsets existed
  // (possible if a site's start year is reached before this has run once).
  activeSiteMarkers.forEach((entry, key) => {
    centerMarkerDot(entry.marker, entry.el, key);
  });
}

// === Row-driven map camera ===
// Camera moves are entirely explicit now, driven only by "Zoom in" / "Zoom
// out" / "Zoom in slightly" Map Event rows -- not inferred from any row
// having a Lat/Lon. The sheet author places these rows exactly where a
// transition should happen (typically with a "Zoom out" between two
// different places), so there's no automatic reset-first heuristic here.
let activeLocationKey = "default";
const CAMERA_DURATION = 1600;

function flyCameraTo(key, lon, lat, zoomLevel) {
  if (key === activeLocationKey) return;
  activeLocationKey = key;
  map.flyTo({
    center: key === "default" ? DEFAULT_MAP_CENTER : [lon, lat],
    zoom: key === "default" ? DEFAULT_MAP_ZOOM : zoomLevel,
    essential: true,
    duration: CAMERA_DURATION,
  });
}

function updateRowCamera(contentOffset) {
  if (!mapReady || !yearLayout) return;
  const active = yearLayout.activeZoomEventAtOffset(contentOffset);
  if (!active) {
    flyCameraTo("default", null, null, DEFAULT_MAP_ZOOM);
    return;
  }
  const { mapEvent, lat, lon } = active.row;
  if (mapEvent === "Zoom out") {
    flyCameraTo("default", null, null, DEFAULT_MAP_ZOOM);
  } else if (mapEvent === "Zoom in slightly") {
    flyCameraTo(`slight:${lat},${lon}`, lon, lat, SLIGHT_ZOOM_LEVEL);
  } else {
    flyCameraTo(`${lat},${lon}`, lon, lat, CLOSEUP_MAP_ZOOM);
  }
}

// A row's own card(s) tied to a place shouldn't be readable before the map
// has actually zoomed to *some* event -- not just scrolled near one. Gated
// loosely (any non-default camera state, not an exact-coordinate match) so
// a single mismatched/rounded coordinate in the sheet can't strand a card
// permanently hidden, and so a "Zoom in slightly" covering several sites at
// once (the DYE cluster) doesn't fail to match any single site's own point.
let settledLocationKey = "default";
map.on("moveend", () => {
  settledLocationKey = activeLocationKey;
  updateCardVisibilityForCamera();
});

function updateCardVisibilityForCamera() {
  const contentDiv = document.getElementById("content");
  const zoomedIn = settledLocationKey !== "default";
  contentDiv.querySelectorAll("[data-row-index]").forEach((card) => {
    const idx = parseInt(card.dataset.rowIndex, 10);
    const row = timelineRows[idx];
    if (!row || !row.hasLocation) {
      card.classList.remove("awaiting-arrival");
      return;
    }
    card.classList.toggle("awaiting-arrival", !zoomedIn);
  });
}

// === Timeline / Scroll marker setup ===
// timeline rail's year-label range (independent of the actual row data range)
const startYear = 1940;
const endYear = 2025;
const yearsDiv = document.getElementById("years");

const yearLabelEls = [];
for (let y = startYear; y <= endYear; y += 5) {
  const el = document.createElement("div");
  el.className = "year-label";
  el.textContent = y;
  el.dataset.year = y;
  yearsDiv.appendChild(el);
  yearLabelEls.push(el);
}

// Vertical layout is driven directly by the ordered timeline rows. A row
// with real content (text/image) gets a full slot; a bare Map Event row
// gets much less -- just enough to have its own distinct position -- except
// a zoom-type event, which gets a generous slot so its flyTo has room to
// land before the reader scrolls past it. Skipped calendar years still
// insert extra empty space, so scrolling paces out over elapsed time.
const CONTENT_ROW_HEIGHT = 650;
const EVENT_ROW_HEIGHT = 20;
const ZOOM_ROW_HEIGHT = 450;
const ROW_GAP = 40;
const YEAR_GAP_PIXELS = 100;
const ZOOM_EVENT_TYPES = ["Zoom in", "Zoom out", "Zoom in slightly"];
const SITE_EVENT_TYPES = ["Start", "End", "Ownership Transfer", "Rename"];
// Small lead so a zoom's flyTo can start just before the reader reaches its
// row, without skipping ahead through the row's own generous height.
const ZOOM_LEAD_PIXELS = 150;
// Minimum scroll distance a "Zoom in"/"Zoom in slightly" stays the active
// camera target once triggered, before a later zoom-type row (typically a
// "Zoom out") is allowed to take over -- guarantees any status-changing row
// (Ownership Transfer, End, Rename) placed shortly after it, and the flyTo
// animation itself, both get room to actually happen before the camera
// leaves.
const ZOOM_DWELL_PIXELS = 400;

function rowHeightFor(row) {
  if (row.hasContent) return CONTENT_ROW_HEIGHT;
  if (ZOOM_EVENT_TYPES.includes(row.mapEvent)) return ZOOM_ROW_HEIGHT;
  return EVENT_ROW_HEIGHT;
}

function computeYearLayout() {
  const padding = 200;
  const placements = [];
  let cursor = padding;
  let prevYear = null;

  timelineRows.forEach((row) => {
    if (prevYear !== null) {
      cursor += Math.max(0, row.year - prevYear) * YEAR_GAP_PIXELS;
    }
    const top = cursor;
    const bottom = top + rowHeightFor(row);
    placements.push({ row, top, bottom, year: row.year });

    cursor = bottom + ROW_GAP;
    prevYear = row.year;
  });

  const contentHeight = Math.max(padding * 2, Math.round(cursor + padding));

  // Pixel position of a given calendar year, interpolated between the rows
  // that bracket it (rows are the only real anchor points now).
  function yearTop(year) {
    if (placements.length === 0) return padding;
    if (year <= placements[0].year) return placements[0].top;
    if (year >= placements[placements.length - 1].year) {
      return placements[placements.length - 1].top;
    }
    for (let i = 0; i < placements.length - 1; i++) {
      const a = placements[i];
      const b = placements[i + 1];
      if (year >= a.year && year <= b.year) {
        if (b.year === a.year) return a.top;
        const t = (year - a.year) / (b.year - a.year);
        return a.top + t * (b.top - a.top);
      }
    }
    return placements[placements.length - 1].top;
  }

  // Inverse of yearTop, for the year-label/marker highlighting. Strictly
  // before the first row's own position, this reads as startYear (not that
  // row's year) -- so a page load at scrollTop 0 shows a year before
  // anything has happened yet, and doesn't reveal that row's map markers
  // until the reader has actually scrolled into its transition gap.
  function yearAtContentOffset(offset) {
    if (placements.length === 0) return startYear;
    if (offset < placements[0].top) return startYear;
    if (offset >= placements[placements.length - 1].top) {
      return placements[placements.length - 1].year;
    }
    for (let i = 0; i < placements.length - 1; i++) {
      const a = placements[i];
      const b = placements[i + 1];
      if (offset >= a.top && offset <= b.top) {
        if (b.top === a.top) return a.year;
        const t = (offset - a.top) / (b.top - a.top);
        return Math.round(a.year + t * (b.year - a.year));
      }
    }
    return placements[placements.length - 1].year;
  }

  // The most recent zoom-type Map Event row at or before this offset. Uses
  // a small lead so its flyTo can start just ahead of actually reaching it,
  // AND a minimum dwell distance once a zoom becomes active, so a "Zoom
  // out" (or another Zoom in) placed only a short distance after it -- e.g.
  // an Ownership Transfer/End row sandwiched right before the Zoom out --
  // can't supersede it before there's been room for that in-between row to
  // register and for the flyTo to actually finish. Two floors enforce this:
  // (1) never earlier than the immediately preceding row's own top, whatever
  // that row is -- ZOOM_LEAD_PIXELS is only meant to give a small head start
  // within the gap right before a zoom row, not to reach backward past
  // *another* row that happens to sit closer than that (e.g. a same-year
  // "Ownership Transfer" row only 60px ahead of its "Zoom out"); (2) a
  // minimum dwell since a "Zoom in"/"Zoom in slightly" became active, as a
  // floor even when nothing else happens to sit in between. Not applied
  // when the active placement is itself a "Zoom out", since returning to
  // the default view isn't a place that needs protecting from being cut
  // short.
  function activeZoomEventAtOffset(offset) {
    let active = null;
    let previousBottom = -Infinity;
    for (const placement of placements) {
      if (ZOOM_EVENT_TYPES.includes(placement.row.mapEvent)) {
        const dwellFloor =
          active && active.row.mapEvent !== "Zoom out"
            ? active.top + ZOOM_DWELL_PIXELS
            : -Infinity;
        const earliestTrigger = Math.max(
          placement.top - ZOOM_LEAD_PIXELS,
          // The FULL preceding row (its bottom, not just its top) has to be
          // behind us -- using its top would let this trigger fire at the
          // exact same offset the preceding row first reveals itself at,
          // which reads as simultaneous rather than "after".
          previousBottom,
          dwellFloor
        );
        if (offset >= earliestTrigger) {
          active = placement;
        } else {
          break;
        }
      }
      previousBottom = placement.bottom;
    }
    return active;
  }

  return {
    padding,
    placements,
    contentHeight,
    yearTop,
    yearAtContentOffset,
    activeZoomEventAtOffset,
  };
}

let yearLayout = computeYearLayout();

// The rail reads as a plain, evenly-spaced ruler (1940 to 2025) independent
// of how content is actually distributed -- content pacing/camera timing
// stays entirely row-driven (see computeYearLayout), but the visual rail is
// simple and predictable. The scroll marker's *position on this scale* is
// still driven by the true current year (see updateScrollMarker), so it
// stays aligned with these labels even though the underlying content isn't
// evenly spaced at all.
function uniformYearFraction(year) {
  return (year - startYear) / (endYear - startYear);
}

// Position each year label evenly along the rail.
function positionYearLabels() {
  const timelinePanel = document.getElementById("timeline");
  const parentHeight = timelinePanel.clientHeight || window.innerHeight;

  yearLabelEls.forEach((el) => {
    const y = parseInt(el.dataset.year, 10);
    el.style.top = `${uniformYearFraction(y) * parentHeight}px`;
  });

  renderSiteLegend();
}

// === Expandable vertical site legend ===
const TIMELINE_WIDTH = 54; // must match #timeline's width in style.css
const legendToggle = document.getElementById("legend-toggle");
const siteLegendEl = document.getElementById("site-legend");
const siteLegendColumnsEl = document.getElementById("site-legend-columns");
const mapLegendEl = document.getElementById("map-legend");
let siteLegendOpen = false;

// One column per site: a vertical bar (colored active/transferred/abandoned
// by y-position, using the same evenly-spaced year<->pixel mapping as the
// year labels) and small vertical text with the site's current name.
function renderSiteLegend() {
  if (!siteLegendColumnsEl) return;
  const timelinePanel = document.getElementById("timeline");
  const parentHeight = timelinePanel.clientHeight || window.innerHeight;
  const toY = (year, colHeight) => uniformYearFraction(year) * colHeight;

  siteLegendColumnsEl.innerHTML = "";

  siteGroups.forEach((site) => {
    const col = document.createElement("div");
    col.className = "site-col";
    siteLegendColumnsEl.appendChild(col); // live in the DOM so its own height and the label height below are measurable

    // .site-col's own rendered height is #site-legend-columns' height minus
    // its 20px top+bottom padding -- NOT the same as parentHeight (the
    // timeline's height, used only as a fallback/reference scale) above.
    // Positioning against parentHeight instead of this actual local height
    // let labels/bars run past the column's real bottom edge, clipped off
    // by #site-legend's overflow:hidden a few pixels in.
    const colHeight = col.clientHeight || parentHeight;

    // Anchored at the bottom of the column, not above each bar's own start
    // -- a label positioned right above the bar's start clipped off-screen
    // for any site starting near 1940 (right at the top of the rail), since
    // there was no room above it to clamp into.
    const label = document.createElement("div");
    label.className = "site-label";
    label.textContent = currentSiteName(site);
    col.appendChild(label);

    const labelHeight = label.offsetHeight || 40;
    const labelTop = Math.max(0, colHeight - labelHeight - 8);
    label.style.top = `${labelTop}px`;

    // Trimmed so the bar stops right above the label instead of running on
    // through it -- otherwise an ongoing site's bar (extending to "now")
    // draws straight through its own bottom-anchored label text.
    const barBottomLimit = labelTop - 4;

    const track = document.createElement("div");
    track.className = "site-bar-track";
    getSiteBarSegments(site).forEach((seg) => {
      const top = Math.min(toY(seg.from, colHeight), barBottomLimit);
      const bottom = Math.min(toY(seg.to, colHeight), barBottomLimit);
      if (bottom <= top) return;
      const segEl = document.createElement("div");
      segEl.className = `site-bar-segment ${seg.status}`;
      segEl.style.top = `${top}px`;
      segEl.style.height = `${bottom - top}px`;
      track.appendChild(segEl);
    });
    col.appendChild(track);
  });

  if (siteLegendOpen) sizeSiteLegend();
}

// Width depends only on how many site columns there are, computed in JS
// (rather than left as "auto") so the open/close width transition can animate.
function sizeSiteLegend() {
  const colWidth = 11; // must match .site-col's width in style.css
  const gap = 3; // must match #site-legend-columns' gap in style.css
  const padding = 20;
  const count = siteGroups.length;
  const width =
    count > 0 ? count * colWidth + (count - 1) * gap + padding * 2 : 0;
  siteLegendEl.style.width = `${width}px`;
  legendToggle.style.left = `${TIMELINE_WIDTH + width}px`;
  return width;
}

// The vertical site legend is a plain overlay on top of the (permanently
// static) basemap -- resizing #map to make room for it caused a visible
// glitch on the map itself, so the map's size/position never changes here.
// Hidden by default, appearing only on hover/click of the arrow. The dot
// legend (#map-legend) is separate and always visible (see
// updateChromeVisibility) -- it doesn't hide/collapse with this toggle.
// Its own width stays fixed, but its LEFT position tracks the toggle's (see
// below), so it always sits just to the right of wherever the Gantt bars
// currently end -- flush against the timeline when collapsed, sliding
// right to stay flush against the toggle when they pop out -- rather than
// overlapping/covering the bars, which is what happened when its width
// used to grow to match theirs instead.
function setSiteLegendOpen(open) {
  siteLegendOpen = open;
  let ganttWidth = 0;
  if (open) {
    renderSiteLegend();
    ganttWidth = sizeSiteLegend();
    legendToggle.textContent = "‹";
    legendToggle.setAttribute("aria-label", "Hide site legend");
  } else {
    siteLegendEl.style.width = "0px";
    legendToggle.style.left = `${TIMELINE_WIDTH}px`;
    legendToggle.textContent = "›";
    legendToggle.setAttribute("aria-label", "Show site legend");
  }
  if (mapLegendEl) {
    mapLegendEl.style.left = `${TIMELINE_WIDTH + ganttWidth}px`;
  }
}

// Hover the arrow to expand; move off both the arrow and the open panel to
// auto-collapse (a short grace period so crossing the gap between them
// doesn't flicker it shut). Click still works too, mainly for touch devices.
let closeLegendTimer = null;
function cancelLegendClose() {
  if (closeLegendTimer) {
    clearTimeout(closeLegendTimer);
    closeLegendTimer = null;
  }
}
function scheduleLegendClose() {
  cancelLegendClose();
  closeLegendTimer = setTimeout(() => {
    setSiteLegendOpen(false);
    closeLegendTimer = null;
  }, 220);
}

if (legendToggle) {
  // A real click is always preceded by a mouseenter, which already opens
  // the panel -- a toggle here would immediately flip it shut again right
  // after opening. Click only reinforces "make sure it's open" (relevant
  // for touch, where hover doesn't fire); closing is mouseleave's job.
  legendToggle.addEventListener("click", () => {
    cancelLegendClose();
    setSiteLegendOpen(true);
  });
  legendToggle.addEventListener("mouseenter", () => {
    cancelLegendClose();
    setSiteLegendOpen(true);
  });
  legendToggle.addEventListener("mouseleave", scheduleLegendClose);
}
if (siteLegendEl) {
  siteLegendEl.addEventListener("mouseenter", cancelLegendClose);
  siteLegendEl.addEventListener("mouseleave", scheduleLegendClose);
}

const marker = document.getElementById("scroll-marker");

// Sites shown as dots on the map, built from the timeline sheet's own Map
// Event rows (Start/End/Ownership Transfer/Rename) -- there's no separate
// Locations sheet anymore. Grouped by coordinate, since a site can have
// multiple events over time (e.g. Thule Air Base renamed to Pituffik Space
// Base in 2023) -- events at the same coordinate are one continuous site.
let siteGroups = [];

// Active map markers, keyed by site.key (coordinate), since a site's label
// can change over time even while the marker itself stays up.
const activeSiteMarkers = new Map();
let mapReady = false;

function siteKeyFor(lat, lon) {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

function buildSiteGroupsFromTimeline(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    if (!row.mapEvent || !SITE_EVENT_TYPES.includes(row.mapEvent)) return;
    if (!row.hasLocation) return;
    const key = siteKeyFor(row.lat, row.lon);
    if (!groups.has(key)) {
      groups.set(key, { key, lat: row.lat, lon: row.lon, events: [] });
    }
    groups.get(key).events.push({
      year: row.year,
      type: row.mapEvent,
      name: row.name,
      rowIndex: row.index,
    });
  });
  const result = Array.from(groups.values());
  // Sort by sheet row order (not year) -- unambiguous even when two events
  // share a calendar year, and it's what the reveal-lag lookup below relies
  // on for "this event's row" positioning.
  result.forEach((g) => g.events.sort((a, b) => a.rowIndex - b.rowIndex));
  result.sort((a, b) => a.events[0].rowIndex - b.events[0].rowIndex);
  return result;
}

// A site's current display name: whichever Start/Rename event most recently
// applied (Ownership Transfer/End don't change the name).
function currentSiteName(site) {
  for (let i = site.events.length - 1; i >= 0; i--) {
    const ev = site.events[i];
    if (ev.type === "Start" || ev.type === "Rename") return ev.name;
  }
  return site.events[site.events.length - 1]?.name || "";
}

// Replays a site's event stream up to a given scroll position: active once
// Started, transferred once an Ownership Transfer has occurred (unless
// since ended), abandoned once Ended. Returns null if nothing has fired yet.
//
// Gated on each event's OWN row position, not on calendar year: a Start row
// often shares its exact year with the "Zoom in" row just above it (e.g.
// Thule's Zoom in and Start are both 1951), and large year gaps elsewhere
// insert blank same-year padding rows well before the real event -- so
// "year has been reached" can go true long before the reader has actually
// scrolled to that row. No extra buffer is added on top of the row's own
// position: the generous height reserved for zoom-type rows (see
// ZOOM_ROW_HEIGHT) already gives a Start row real scroll-distance after its
// Zoom in, and ZOOM_DWELL_PIXELS (see activeZoomEventAtOffset) keeps a
// later Zoom out from cutting that distance short.
function getSiteStatusAtOffset(site, contentOffset) {
  let currentName = null;
  let state = null;
  for (const ev of site.events) {
    const placement = yearLayout && yearLayout.placements[ev.rowIndex];
    const revealOffset = placement ? placement.top : Infinity;
    if (contentOffset < revealOffset) break;
    if (ev.type === "Start") {
      currentName = ev.name;
      state = "active";
    } else if (ev.type === "Rename") {
      currentName = ev.name;
    } else if (ev.type === "Ownership Transfer") {
      state = "transferred";
    } else if (ev.type === "End") {
      state = "abandoned";
    }
  }
  if (state === null) return null;
  return { name: currentName, state };
}

// A site's lifespan as colored segments for the vertical Gantt legend:
// active (green) until an Ownership Transfer (if any), then transferred
// (blue), until an End, then abandoned (red) from there to "now". Rename
// doesn't start a new segment (just changes the displayed name elsewhere).
function getSiteBarSegments(site) {
  const segments = [];
  let segStart = null;
  let segStatus = null;

  site.events.forEach((ev) => {
    if (ev.type === "Start") {
      segStart = ev.year;
      segStatus = "active";
    } else if (ev.type === "Ownership Transfer" && segStart !== null) {
      segments.push({ from: segStart, to: ev.year, status: segStatus });
      segStart = ev.year;
      segStatus = "transferred";
    } else if (ev.type === "End" && segStart !== null) {
      segments.push({ from: segStart, to: ev.year, status: segStatus });
      segments.push({ from: ev.year, to: endYear, status: "abandoned" });
      segStart = null;
      segStatus = null;
    }
  });

  if (segStart !== null) {
    segments.push({ from: segStart, to: endYear, status: segStatus });
  }
  return segments;
}

// scrolling container (we render scrollbar on #app)
const scrollContainer = document.getElementById("app") || window;

// #content is preceded in the scroll flow by #intro-wrapper (the full-height
// title screen plus the intro text below it), so scroll position has to be
// re-based to #content's own coordinate space before it can be run through
// yearLayout.
function getTitleHeight() {
  const introWrapper = document.getElementById("intro-wrapper");
  return introWrapper ? introWrapper.offsetHeight : 0;
}

// Current scroll position as a 0-1 fraction of the way through #content.
function getScrollFraction() {
  if (!yearLayout || yearLayout.contentHeight <= 0) return 0;
  let scrollTop = 0;
  if (scrollContainer === window) {
    scrollTop = window.scrollY;
  } else {
    scrollTop = scrollContainer.scrollTop;
  }
  const contentScrollY = Math.max(0, scrollTop - getTitleHeight());
  return Math.max(0, Math.min(1, contentScrollY / yearLayout.contentHeight));
}

// Scroll the page so a given 0-1 fraction through #content is at the top of
// the viewport. Used by the clickable/draggable scroll marker.
function setScrollFraction(fraction) {
  if (!yearLayout) return;
  fraction = Math.max(0, Math.min(1, fraction));
  const targetContentY = fraction * yearLayout.contentHeight;
  const rawTarget = getTitleHeight() + targetContentY;

  const viewportHeight = window.innerHeight;
  let maxScroll;
  if (scrollContainer === window) {
    maxScroll = document.documentElement.scrollHeight - viewportHeight;
  } else {
    maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
  }
  const targetScrollTop = Math.max(0, Math.min(maxScroll, rawTarget));

  if (scrollContainer === window) {
    window.scrollTo({ top: targetScrollTop });
  } else {
    scrollContainer.scrollTop = targetScrollTop;
  }
}

// The timeline rail, current-year badge, and bottom-right legend stay
// invisible through the title/intro screen, fading in as the reader
// approaches the end of the intro text (so they're not competing with it),
// fully visible by the time #content actually begins. Applied to the actual
// visible elements individually (not a zero-size wrapper) so the fade is
// never abrupt.
function updateChromeVisibility() {
  const introWrapper = document.getElementById("intro-wrapper");
  const timelinePanel = document.getElementById("timeline");
  const mapLegend = document.getElementById("map-legend");
  if (!introWrapper) return;

  const introHeight = introWrapper.offsetHeight;
  const scrollTop =
    scrollContainer === window ? window.scrollY : scrollContainer.scrollTop;

  const fadeStart = introHeight * 0.6;
  const fadeEnd = introHeight;
  const opacity =
    fadeEnd > fadeStart
      ? Math.max(0, Math.min(1, (scrollTop - fadeStart) / (fadeEnd - fadeStart)))
      : 1;

  const visible = opacity > 0.05;
  [timelinePanel, legendToggle, siteLegendEl].forEach((el) => {
    if (!el) return;
    el.style.opacity = opacity;
    el.style.pointerEvents = visible ? "" : "none";
  });
  if (currentYearBadge) currentYearBadge.style.opacity = opacity;
  if (mapLegend) mapLegend.style.opacity = opacity;
}

function updateScrollMarker() {
  updateChromeVisibility();
  if (!yearLayout || yearLayout.contentHeight <= 0) return;

  const fraction = getScrollFraction();
  const contentOffset = fraction * yearLayout.contentHeight;
  const currentYear = yearLayout.yearAtContentOffset(contentOffset);

  // The rail shows years evenly spaced (see uniformYearFraction), so the
  // marker's position comes from the current year on that same even scale
  // -- not from raw scroll fraction -- to stay aligned with the labels even
  // though the underlying content isn't evenly spaced at all.
  const timelinePanel = document.getElementById("timeline");
  const parentHeight = timelinePanel.clientHeight || window.innerHeight;
  const markerHeight = marker.offsetHeight || 30;
  const markerTop = uniformYearFraction(currentYear) * (parentHeight - markerHeight);
  marker.style.top = `${markerTop}px`;

  updateMapForYear(currentYear, contentOffset);
}

if (scrollContainer === window) {
  window.addEventListener("scroll", updateScrollMarker);
} else {
  scrollContainer.addEventListener("scroll", updateScrollMarker);
}

// === Clickable / draggable scroll marker ===
const timelineEl = document.getElementById("timeline");

function jumpToTimelinePointer(clientY) {
  const rect = timelineEl.getBoundingClientRect();
  const railFraction = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
  // The rail position is a year on the evenly-spaced scale; convert that
  // back to where that year's content actually is (yearTop, row-driven) to
  // find the scroll fraction to jump to -- not the raw rail fraction, which
  // would land on whatever year happens to be there in the non-uniform
  // content layout instead of the year the reader actually clicked on.
  const targetYear = startYear + railFraction * (endYear - startYear);
  const contentOffset = yearLayout ? yearLayout.yearTop(targetYear) : 0;
  const scrollFraction =
    yearLayout && yearLayout.contentHeight > 0
      ? contentOffset / yearLayout.contentHeight
      : railFraction;
  setScrollFraction(scrollFraction);
  updateScrollMarker();
}

let isDraggingMarker = false;

marker.addEventListener("pointerdown", (e) => {
  isDraggingMarker = true;
  marker.setPointerCapture(e.pointerId);
  jumpToTimelinePointer(e.clientY);
  e.stopPropagation();
});

marker.addEventListener("pointermove", (e) => {
  if (!isDraggingMarker) return;
  jumpToTimelinePointer(e.clientY);
});

function endMarkerDrag(e) {
  if (!isDraggingMarker) return;
  isDraggingMarker = false;
  try {
    marker.releasePointerCapture(e.pointerId);
  } catch (err) {
    // ignore
  }
}

marker.addEventListener("pointerup", endMarkerDrag);
marker.addEventListener("pointercancel", endMarkerDrag);

// Clicking anywhere else on the timeline rail jumps straight to that point.
timelineEl.addEventListener("click", (e) => {
  jumpToTimelinePointer(e.clientY);
});

window.addEventListener("resize", () => {
  // recompute marker placement on resize
  updateLayout();
  updateScrollThumb();
  updateScrollMarker();
});
window.addEventListener("load", () => {
  // ensure marker is placed on initial load
  updateLayout();
  updateScrollThumb();
  updateScrollMarker();
});

// === Timeline rows (single combined sheet: text, photos, and Map Events) ===
// Each row is either text-only, an image+caption, or a bare Map Event (no
// visible content -- purely a marker/camera trigger), in the exact order
// the sheet gives them (not re-sorted).
async function loadTimelineCSV() {
  try {
    const res = await fetch(TIMELINE_SHEET_CSV_URL);
    const csvText = await res.text();
    const data = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
    }).data;

    const rows = [];
    data.forEach((raw) => {
      const year = parseInt(raw["Year"], 10);
      if (!year || isNaN(year)) return;

      const mapEvent = (raw["Map Event"] || "").trim();
      const name = (raw["Name"] || "").trim();
      const lat = parseFloat(raw["Lat"]);
      const lon = parseFloat(raw["Lon"]);
      const hasLocation = !isNaN(lat) && !isNaN(lon);

      const imageId = (raw["Image"] || "").trim();
      const imageSource = (raw["Image Source"] || "").trim();
      const caption = (raw["Caption"] || "").trim();
      const hasContent = !!caption || !!imageId;

      if (!hasContent && !mapEvent) return; // nothing to show, nothing to trigger

      // index is this row's own position in the FILTERED array (matching
      // yearLayout.placements' indexing 1:1), not its raw position in the
      // sheet -- rows get skipped above, so the two diverge once any row
      // before this one has been dropped.
      rows.push({
        index: rows.length,
        year,
        mapEvent,
        name,
        lat: hasLocation ? lat : null,
        lon: hasLocation ? lon : null,
        hasLocation,
        imageId,
        imageSource,
        caption,
        hasContent,
      });
    });

    timelineRows = rows;
    siteGroups = buildSiteGroupsFromTimeline(rows);
    createTimelineCards(rows);
    updateCardVisibilityForCamera();
    updateLayout();
    // The window "load" event (which also calls this) can fire before this
    // CSV fetch resolves, computing the thumb's height against the tiny
    // placeholder layout that exists before real rows are in -- leaving it
    // stuck oversized forever since nothing recomputed it afterward.
    updateScrollThumb();
    updateScrollMarker();
    precomputeSiteLabelOffsets();
  } catch (err) {
    console.error("Error loading timeline CSV:", err);
  }
}

// === Create timeline cards ===
function createTimelineCards(rows) {
  const contentDiv = document.getElementById("content");

  rows.forEach((row) => {
    if (!row.hasContent) return; // bare Map Event rows render nothing

    const card = document.createElement("div");
    card.dataset.rowIndex = row.index;
    card.dataset.year = row.year;
    card.style.position = "absolute";

    if (row.imageId) {
      card.className = "image-card";
      const fullPath = getExistingImagePath(row.imageId);

      if (fullPath) {
        card.innerHTML = `
          <img src="${fullPath}" alt="${row.caption}" />
          <div class="card-caption">
            <p class="caption-text">${row.caption}</p>
          </div>
        `;
      } else {
        console.warn(`No image found for ${row.imageId}`);
        card.innerHTML = `
          <div class="missing">Image missing for ${row.imageId}</div>
          <div class="card-caption">
            <p class="caption-text">${row.caption || ""}</p>
          </div>
        `;
      }

      card.addEventListener("click", (e) => {
        e.stopPropagation();
        openCardFullScreen(card, row);
      });

      const imgEl = card.querySelector("img");
      if (imgEl && !imgEl.complete) {
        imgEl.addEventListener("load", () => {
          // clear any previous placed flag so layout can place it using correct dims
          delete card.dataset.placed;
          updateLayout();
          updateScrollMarker();
        });
      }
    } else {
      card.className = "text-card";
      card.innerHTML = `<div class="text-card-inner">${row.caption}</div>`;
    }

    contentDiv.appendChild(card);
  });

  // Reveal cards only when they enter near the viewport for better UX
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        entry.target.classList.toggle("visible", entry.isIntersecting);
      });
    },
    { root: null, rootMargin: "400px 0px 400px 0px", threshold: 0.01 }
  );
  contentDiv
    .querySelectorAll(".image-card, .text-card")
    .forEach((c) => observer.observe(c));
}

// Overlay element for closing expanded view (used by FLIP clone)
let overlayEl = null;
function ensureOverlay() {
  if (!overlayEl) {
    overlayEl = document.createElement("div");
    overlayEl.className = "overlay-closeup";
    document.body.appendChild(overlayEl);
  }
}

// FLIP-style open/close: clones the WHOLE card (its shared blurred
// background panel included, not just the raw image) so that background
// visibly moves and scales up together with the image, instead of a plain
// floating image appearing while the card's own panel stays behind.
let currentClone = null;
let currentOriginalCard = null;

function openCardFullScreen(card, row) {
  ensureOverlay();
  const img = card.querySelector("img");
  if (!img) return;

  if (currentClone) closeImgFullScreen();

  const cardRect = card.getBoundingClientRect();
  const imgRect = img.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // The whole card (image + caption) scales up together as one unit (see
  // `scale` below), so oversized bounds here don't just make the image
  // bigger -- they blow up the caption text by the same factor, since it's
  // scaled along with everything else rather than laid out fresh at the
  // larger size.
  const maxW = vw * 0.5;
  const maxH = vh * 0.62;
  const aspect =
    (img.naturalWidth || imgRect.width) / (img.naturalHeight || imgRect.height);

  let targetImgW = Math.min(maxW, aspect * maxH);
  let targetImgH = targetImgW / aspect;
  if (targetImgH > maxH) {
    targetImgH = maxH;
    targetImgW = targetImgH * aspect;
  }
  const scale = targetImgW / imgRect.width;

  const clone = card.cloneNode(true);
  clone.style.position = "fixed";
  clone.style.left = `${cardRect.left}px`;
  clone.style.top = `${cardRect.top}px`;
  clone.style.width = `${cardRect.width}px`;
  clone.style.maxWidth = "none";
  clone.style.margin = "0";
  clone.style.overflow = "hidden";
  clone.style.transition = "transform 320ms ease";
  clone.style.transformOrigin = "top left";
  clone.style.zIndex = 100001;
  clone.style.cursor = "default";
  clone.style.pointerEvents = "none";

  // The caption is scaled up right along with the image by the clone's own
  // transform below (one transform, one animation, for the whole card) --
  // so its rendered text size ends up different for every photo, tracking
  // whatever `scale` that image's aspect ratio happened to produce. A
  // counter-transform here cancels that out, keeping it pinned to its
  // natural (unscaled) size regardless of `scale`. No transition needed on
  // it -- composed with the clone's own animating transform, it rides
  // along for free, landing on a net visual scale of exactly 1 once the
  // clone's animation finishes.
  const captionEl = clone.querySelector(".card-caption");
  if (captionEl) {
    if (row && row.imageSource) {
      const link = document.createElement("a");
      link.href = row.imageSource;
      link.target = "_blank";
      link.rel = "noopener";
      link.className = "fullscreen-source-link";
      link.textContent = "Image Source";
      captionEl.appendChild(link);
    }
    captionEl.style.transformOrigin = "top left";
  }

  // Appended before measuring captionEl below -- offsetHeight on a node
  // that isn't attached to the document yet always reads 0 (there's no
  // layout to measure), which was silently zeroing out the whole
  // reserved-height calculation just below.
  document.body.appendChild(clone);
  card.style.visibility = "hidden";
  currentOriginalCard = card;
  currentClone = clone;

  // Measured AFTER appending the source link, since that adds its own
  // height -- this is the caption's true natural (unscaled) height.
  const captionNaturalHeight = captionEl ? captionEl.offsetHeight : 0;

  // The clone's own height, left to "auto", would size the card as if the
  // caption still occupied its full natural height -- but the counter-
  // transform above changes what the caption actually renders as, without
  // changing the space normal flow reserves for it (transforms never
  // affect layout). Setting the height explicitly instead, in the same
  // (pre-transform) coordinate space the clone's own scale transform
  // operates in, keeps the card's edge landing exactly where the image and
  // the now constant-size caption actually end -- not too tall (an empty
  // gap below the caption for photos needing little zoom-in) or too short
  // (the caption cropped/overflowing for photos needing to shrink slightly
  // to fit the height bound).
  const cardPaddingTop = 6; // .image-card's own CSS padding-top; its bottom padding is 0
  const safetyMargin = 6; // small buffer against sub-pixel rounding in the measurements above
  const unscaledCloneHeight =
    cardPaddingTop + imgRect.height + captionNaturalHeight / scale + safetyMargin;
  clone.style.height = `${unscaledCloneHeight}px`;

  overlayEl.style.display = "block";
  overlayEl.style.pointerEvents = "auto";
  requestAnimationFrame(() => {
    overlayEl.style.opacity = "1";
  });

  const scaledW = cardRect.width * scale;
  const scaledH = unscaledCloneHeight * scale;
  const cx = (vw - scaledW) / 2;
  const cy = (vh - scaledH) / 2;
  const tx = cx - cardRect.left;
  const ty = cy - cardRect.top;

  requestAnimationFrame(() => {
    clone.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    if (captionEl) captionEl.style.transform = `scale(${1 / scale})`;
  });

  overlayEl.onclick = closeImgFullScreen;
}

function closeImgFullScreen() {
  if (!currentClone) return;
  currentClone.style.transform = "none";
  const captionEl = currentClone.querySelector(".card-caption");
  if (captionEl) captionEl.style.transform = "none";
  if (overlayEl) {
    overlayEl.style.opacity = "0";
    overlayEl.style.pointerEvents = "none";
  }
  const clone = currentClone;
  const originalCard = currentOriginalCard;
  clone.addEventListener("transitionend", function onEnd() {
    clone.remove();
    if (originalCard) originalCard.style.visibility = "";
    if (currentClone === clone) currentClone = null;
    if (currentOriginalCard === originalCard) currentOriginalCard = null;
    if (overlayEl) overlayEl.style.display = "none";
    clone.removeEventListener("transitionend", onEnd);
  });
}

// === Load PapaParse then CSV ===
const papaScript = document.createElement("script");
papaScript.src =
  "https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js";
papaScript.onload = async () => {
  await loadTimelineCSV();
};

document.head.appendChild(papaScript);

// Layout - timeline card positioning. Each content row gets its own
// dedicated [top, bottom) band from yearLayout (see computeYearLayout), so
// unlike the old per-year system there's no competing content to
// scatter/collide within a band -- just a modest random position for
// visual variety. Bare Map Event rows have no card to place.
function updateLayout() {
  const contentDiv = document.getElementById("content");

  yearLayout = computeYearLayout();
  const { contentHeight, placements } = yearLayout;

  contentDiv.style.height = contentHeight + "px";
  contentDiv.style.position = "relative";
  const contentWidth = contentDiv.clientWidth;

  const cardsByIndex = new Map();
  contentDiv.querySelectorAll(".image-card, .text-card").forEach((card) => {
    cardsByIndex.set(card.dataset.rowIndex, card);
  });

  const centerX = Math.round(contentWidth / 2);
  const spread = Math.round(contentWidth * 0.35);
  const minLeft = 16;

  placements.forEach((placement) => {
    const card = cardsByIndex.get(String(placement.row.index));
    if (!card || card.dataset.placed === "1") return;

    const cw = Math.max(40, card.offsetWidth || 80);
    const ch = Math.max(24, card.offsetHeight || 40);
    const maxLeft = Math.max(minLeft, contentWidth - cw - 16);

    const randOffset = Math.round((Math.random() * 2 - 1) * spread);
    const left = Math.max(
      minLeft,
      Math.min(maxLeft, centerX + randOffset - Math.round(cw / 2))
    );
    const maxTop = Math.max(placement.top, placement.bottom - ch);
    // A row gated on camera arrival (see updateCardVisibilityForCamera) can
    // stay hidden well into its own band while the flyTo/dwell upstream are
    // still playing out. If its card sat early in that band, the reader
    // could scroll straight through that hidden stretch -- carrying the
    // card's fixed position from the bottom of the viewport up past the top
    // -- before the gate ever clears, so it "pops" into view somewhere
    // near/above the top instead of easing in from the bottom like anything
    // else being scrolled to. Placing it at the very end of the band keeps
    // its on-screen position out of reach until well after arrival.
    const top = placement.row.hasLocation
      ? maxTop
      : Math.round(
          placement.top + Math.random() * Math.max(0, maxTop - placement.top)
        );

    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
    card.dataset.placed = "1";
  });

  positionYearLabels();
}

// Size the scroll marker itself to reflect the viewport/content ratio, like a
// native scrollbar thumb.
function updateScrollThumb() {
  if (!yearLayout || yearLayout.contentHeight <= 0) return;
  const timelinePanel = document.getElementById("timeline");
  const parentHeight = timelinePanel.clientHeight || window.innerHeight;
  const viewportHeight = window.innerHeight;
  const totalTrackHeight = getTitleHeight() + yearLayout.contentHeight;

  const ratio =
    totalTrackHeight > 0
      ? Math.max(0.03, Math.min(1, viewportHeight / totalTrackHeight))
      : 0.1;
  const markerHeight = Math.max(10, ratio * parentHeight);
  marker.style.height = `${markerHeight}px`;
}
