// === CONFIG ===
const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vS4vK_K5j7xcOA8Xj0emE_oXbSe1dYFDuXJi2ytNcvKprG_5qMja_U9uH6ZFd5n51gmfd6rqOibu-90/pub?gid=480743348&single=true&output=csv";

// List of possible extensions
const extensions = ["jpg", "jpeg", "png", "webp", "tif"];

// Function to get the existing file path
function getExistingImagePath(baseName) {
  for (const ext of extensions) {
    const path = `img/${baseName}.${ext}`;
    // Check if file exists (synchronously with fetch head)
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
const map = new maplibregl.Map({
  container: "map",
  style: `https://api.maptiler.com/maps/hybrid/style.json?key=q2l5v7peOG9LJxJlnEZ2`,
  center: [-40, 76],
  zoom: 2.5,
  pitch: 0,
  interactive: false,
  attributionControl: false,
});

map.on("load", () => {
  // --- Remove all text and label layers ---
  map.getStyle().layers.forEach((layer) => {
    if (layer.type === "symbol") {
      map.removeLayer(layer.id);
    }
  });

  // --- Add a dark overlay to dim the satellite imagery ---
  map.addLayer({
    id: "darken-overlay",
    type: "background",
    paint: {
      "background-color": "rgba(0, 0, 0, 0.35)", // adjust opacity here (0.0–1.0)
    },
    // Make sure it sits above the satellite but below any data you add
    before: map.getStyle().layers[0]?.id,
  });
});

// === Timeline Setup ===
const startYear = 1940;
const endYear = 2025;
const yearsDiv = document.getElementById("years");

for (let y = startYear; y <= endYear; y += 5) {
  const el = document.createElement("div");
  el.textContent = y;
  yearsDiv.appendChild(el);
}

const marker = document.getElementById("scroll-marker");
// Markers placed on the map for events with coordinates
const eventMarkers = [];

// scrolling container (we render scrollbar on #app)
const scrollContainer = document.getElementById("app") || window;

function updateScrollMarker() {
  // Compute scroll percent relative to the timeline content (the long #content)
  // Use a global scroll percent derived from the scrolling container so the
  // custom thumb reflects the user's position across all content.
  const viewportHeight = window.innerHeight;
  let scrollTop = 0;
  let totalScrollable = 0;
  if (scrollContainer === window) {
    scrollTop = window.scrollY;
    totalScrollable = document.documentElement.scrollHeight - viewportHeight;
  } else {
    scrollTop = scrollContainer.scrollTop;
    totalScrollable =
      scrollContainer.scrollHeight - scrollContainer.clientHeight;
  }

  const scrollPercent =
    totalScrollable > 0
      ? Math.max(0, Math.min(1, scrollTop / totalScrollable))
      : 0;

  // Position marker relative to the timeline element height
  const timelineEl = document.getElementById("timeline");
  const parentHeight = timelineEl.clientHeight || window.innerHeight;
  const markerHeight = marker.offsetHeight || 30;
  const markerTop = scrollPercent * (parentHeight - markerHeight);
  marker.style.top = `${markerTop}px`;

  // Update custom scroll thumb
  const thumb = timelineEl.querySelector(".scroll-thumb");
  if (thumb) {
    // Keep thumb centered like marker but with its own height
    const thumbHeight = thumb.offsetHeight || 30;
    const thumbTop = scrollPercent * (parentHeight - thumbHeight);
    thumb.style.top = `${thumbTop}px`;
  }

  // Compute current year and highlight map markers based on content scroll
  const currentYear = Math.round(
    startYear + scrollPercent * (endYear - startYear)
  );
  highlightMapEvents(currentYear);
}

if (scrollContainer === window) {
  window.addEventListener("scroll", updateScrollMarker);
} else {
  scrollContainer.addEventListener("scroll", updateScrollMarker);
}

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

// === Load CSV ===
async function loadCSV() {
  try {
    const res = await fetch(SHEET_CSV_URL);
    const csvText = await res.text();

    // Use PapaParse for CSV parsing
    const data = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
    }).data;
    createImageCards(data);
    // after cards are created, update layout and marker
    updateLayout();
    updateScrollMarker();
  } catch (err) {
    console.error("Error loading CSV:", err);
  }
}

// === Create Image Cards ===
function createImageCards(data) {
  const contentDiv = document.getElementById("content");
  // We'll position cards absolutely inside #content according to their year.
  // Prepare an array of valid items with numeric year.
  const validItems = [];
  data.forEach((item) => {
    const dateStr = item["Date"] || "";
    const yearMatch = dateStr.match(/\b(19|20)\d{2}\b/);
    if (!yearMatch) return; // skip items without a valid year
    const year = parseInt(yearMatch[0], 10);
    if (year < startYear || year > endYear) return; // skip out-of-range

    const link = item["Link"] || item["Source"] || "";
    const caption = item["Caption"] || "";
    const id = item["ID"] || item["File"] || "";

    validItems.push({ year, link, caption, id, raw: item });
  });

  // Store reference for layout calculations
  contentDiv._timelineItems = validItems;

  // Create DOM elements for each valid item
  validItems.forEach((it) => {
    const card = document.createElement("div");
    card.className = "image-card";
    card.dataset.year = it.year;
    card.style.position = "absolute"; // we'll set top later in updateLayout

    const fullPath = getExistingImagePath(it.id);
    // Default markup contains only the image; caption/source will be shown on expand
    if (fullPath) {
      card.innerHTML = `
      <img src="${fullPath}" alt="${it.caption}" />
    `;
    } else {
      console.warn(`No image found for ${it.id} / ${it.link}`);
      card.innerHTML = `
      <div class="missing">Image missing for ${it.id}</div>
    `;
    }

    // click to expand to full-screen view. We'll create an overlay to handle outside clicks.
    card.addEventListener("click", (e) => {
      e.stopPropagation();
      openCardFullScreen(card, it);
    });

    contentDiv.appendChild(card);

    // If the row contains coordinates, add a map marker
    const raw = it.raw || {};
    let lat = null,
      lng = null;
    if (raw.Latitude && raw.Longitude) {
      lat = parseFloat(raw.Latitude);
      lng = parseFloat(raw.Longitude);
    } else if (raw.Location) {
      // try to parse "lat, lng" inside Location field
      const m = raw.Location.match(/(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/);
      if (m) {
        lat = parseFloat(m[1]);
        lng = parseFloat(m[2]);
      }
    }
    if (!isNaN(lat) && !isNaN(lng)) {
      const el = document.createElement("div");
      el.className = "event-marker";
      el.style.width = "12px";
      el.style.height = "12px";
      el.style.borderRadius = "50%";
      el.style.background = "rgba(255,200,0,0.8)";
      el.style.transform = "translate(-50%, -50%)";
      el.style.transition = "transform 0.15s, opacity 0.15s";
      el.style.opacity = "0.25";

      const markerObj = new maplibregl.Marker(el)
        .setLngLat([lng, lat])
        .addTo(map);
      // attach metadata
      markerObj._year = it.year;
      markerObj._el = el;
      eventMarkers.push(markerObj);
    }
  });

  // Reveal cards only when they enter near the viewport for better UX
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
        } else {
          entry.target.classList.remove("visible");
        }
      });
    },
    { root: null, rootMargin: "400px 0px 400px 0px", threshold: 0.01 }
  );
  // observe all cards
  const cards = contentDiv.querySelectorAll(".image-card");
  cards.forEach((c) => observer.observe(c));
}

// Overlay element for closing expanded view
let overlayEl = null;
function ensureOverlay() {
  if (!overlayEl) {
    overlayEl = document.createElement("div");
    overlayEl.className = "overlay";
    overlayEl.style.display = "none";
    document.body.appendChild(overlayEl);
    overlayEl.addEventListener("click", () => {
      // close any expanded card
      const expanded = document.querySelector(".image-card.expanded");
      if (expanded) closeExpandedCard(expanded);
    });
  }
}

function openCardFullScreen(card, item) {
  ensureOverlay();
  // fill caption/source below image
  // remove any previous duplicated caption area
  let captionEl = card.querySelector(".card-caption");
  if (!captionEl) {
    captionEl = document.createElement("div");
    captionEl.className = "card-caption";
    captionEl.innerHTML =
      `<p><strong>${item.year}</strong> — ${item.caption || ""}</p>` +
      (item.link
        ? `<div><a href="${item.link}" target="_blank" rel="noopener">Source</a></div>`
        : "");
    card.appendChild(captionEl);
  }

  // explicitly center using viewport units to avoid any layout/containing-block issues
  // rely on CSS for sizing (max 80vh/80vw) and use position fixed via class
  card.style.position = "";
  card.style.top = "";
  card.style.left = "";
  card.style.transform = "";
  card.classList.add("expanded");
  overlayEl.style.display = "block";
}

function closeExpandedCard(card) {
  card.classList.remove("expanded");
  // remove caption if present
  const captionEl = card.querySelector(".card-caption");
  if (captionEl) captionEl.remove();
  if (overlayEl) overlayEl.style.display = "none";
  // remove inline fixed positioning so updateLayout can re-position
  card.style.position = "";
  card.style.top = "";
  card.style.left = "";
  card.style.transform = "";
  card.style.width = "";
  card.style.maxWidth = "";
  // restore layout positions after close
  setTimeout(() => updateLayout(), 40);
}

// clicking ESC should also close
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const expanded = document.querySelector(".image-card.expanded");
    if (expanded) closeExpandedCard(expanded);
  }
});

// === Load PapaParse then CSV ===
const papaScript = document.createElement("script");
papaScript.src =
  "https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js";
papaScript.onload = loadCSV;
document.head.appendChild(papaScript);

// Layout helpers
function updateLayout() {
  const contentDiv = document.getElementById("content");
  const items = contentDiv._timelineItems || [];

  // Choose pixels per year to space out the timeline; adjust as needed
  const pixelsPerYear = 300;
  const padding = 200; // matches CSS padding
  const totalYears = endYear - startYear;
  const contentHeight = totalYears * pixelsPerYear + padding * 2;
  contentDiv.style.height = contentHeight + "px";
  contentDiv.style.position = "relative";

  // Group cards by year so we can offset multiples from the left
  const cards = Array.from(contentDiv.querySelectorAll(".image-card"));
  const byYear = {};
  cards.forEach((card) => {
    const y = parseInt(card.dataset.year, 10);
    if (isNaN(y)) return;
    if (!byYear[y]) byYear[y] = [];
    byYear[y].push(card);
  });

  Object.keys(byYear).forEach((yStr) => {
    const y = parseInt(yStr, 10);
    const frac = (y - startYear) / (endYear - startYear);
    const top = padding + frac * (contentHeight - padding * 2);

    const group = byYear[y];
    // layout left-to-right offsets for each card in the group
    const gapX = 200; // px between cards
    let leftStart = 40; // pixels from left edge of content area
    if (group.length === 1) {
      const card = group[0];
      card.style.top = `${top}px`;
      // center single cards
      card.style.left = `50%`;
      card.style.transform = "translateX(-50%)";
    } else {
      group.forEach((card, idx) => {
        card.style.top = `${top + idx * 6}px`; // small vertical nudge to separate stacked
        // remove center transform so left px is honored
        card.style.transform = "none";
        // set left offset from content left; note: content area has margin-left:10% in CSS
        card.style.left = `${leftStart + idx * (card.offsetWidth + gapX)}px`;
      });
    }
  });
}

function highlightMapEvents(currentYear) {
  // simple rule: fully show events within +/- 3 years, fade others
  const radius = 3;
  eventMarkers.forEach((m) => {
    const year = m._year || 0;
    const el = m._el;
    if (!el) return;
    const d = Math.abs(year - currentYear);
    if (d <= radius) {
      el.style.opacity = "1";
      const scale = 1 + (radius - d) * 0.25;
      el.style.transform = `translate(-50%, -50%) scale(${scale})`;
    } else {
      el.style.opacity = "0.25";
      el.style.transform = "translate(-50%, -50%) scale(1)";
    }
  });
}

// Create or update a custom scroll thumb inside #timeline that represents viewport
function updateScrollThumb() {
  const timelineEl = document.getElementById("timeline");
  let thumb = timelineEl.querySelector(".scroll-thumb");
  const contentEl = document.getElementById("content");
  const viewport = window.innerHeight;
  const contentHeight = contentEl.offsetHeight;
  if (!thumb) {
    thumb = document.createElement("div");
    thumb.className = "scroll-thumb";
    timelineEl.appendChild(thumb);
  }

  // Thumb height reflects viewport/content ratio (min 20px)
  const ratio = Math.max(0.02, Math.min(1, viewport / contentHeight));
  const parentHeight = timelineEl.clientHeight || window.innerHeight;
  const thumbHeight = Math.max(20, ratio * parentHeight);
  thumb.style.height = `${thumbHeight}px`;
  // Position will be set in updateScrollMarker (which knows scrollPercent)
}
