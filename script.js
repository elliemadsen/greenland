// === CONFIG ===
const IMAGE_SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vS4vK_K5j7xcOA8Xj0emE_oXbSe1dYFDuXJi2ytNcvKprG_5qMja_U9uH6ZFd5n51gmfd6rqOibu-90/pub?gid=480743348&single=true&output=csv";

const TEXT_SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vS4vK_K5j7xcOA8Xj0emE_oXbSe1dYFDuXJi2ytNcvKprG_5qMja_U9uH6ZFd5n51gmfd6rqOibu-90/pub?gid=418918070&single=true&output=csv";

// List of possible extensions
const extensions = ["jpg", "jpeg", "png", "webp"];

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
  // Remove all text and label layers
  map.getStyle().layers.forEach((layer) => {
    if (layer.type === "symbol") {
      map.removeLayer(layer.id);
    }
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
  // ensure any events that should be visible at initial position get added
  updateScrollMarker();
});

// Create a small DOM element for event marker (dot + label)
function createEventMarkerElement(ev) {
  const el = document.createElement("div");
  el.className = "event-marker";
  // small black dot
  const dot = document.createElement("span");
  dot.className = "dot";
  // label
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = ev.name;

  el.appendChild(dot);
  el.appendChild(label);
  return el;
}

function addEventMarker(ev) {
  if (!mapReady) return;
  if (activeEventMarkers[ev.name]) return;
  const el = createEventMarkerElement(ev);
  // use options form to be explicit about the element passed in
  const marker = new maplibregl.Marker({ element: el, anchor: "center" })
    .setLngLat([ev.lon, ev.lat])
    .addTo(map);

  // measure and compute horizontal offset so the DOT (not the whole element)
  // is centered exactly at the map coordinate. Do this after layout has a
  // chance to flush (next animation frame) so label sizes are accurate.
  requestAnimationFrame(() => {
    try {
      const dot = el.querySelector(".dot");
      if (dot) {
        const elRect = el.getBoundingClientRect();
        const dotRect = dot.getBoundingClientRect();
        // dot center relative to the element's left
        const dotCenter = dotRect.left - elRect.left + dotRect.width / 2;
        const elCenter = elRect.width / 2;
        // offset needed to move the element center so the dot aligns with the coordinate
        // derived: offsetX = elCenter - dotCenter
        const offsetX = Math.round(elCenter - dotCenter);
        // setOffset expects [x, y] in pixels; positive x moves the element right
        marker.setOffset([offsetX, 0]);
      }
    } catch (err) {
      console.warn("Could not compute event marker offset:", err);
    }
  });

  activeEventMarkers[ev.name] = marker;
}

function removeEventMarker(ev) {
  const marker = activeEventMarkers[ev.name];
  if (marker) {
    marker.remove();
    delete activeEventMarkers[ev.name];
  }
}

// Show markers for events whose year <= currentYear, hide those with year > currentYear
function updateMapForYear(currentYear) {
  // safety
  if (!timelineEvents || !Array.isArray(timelineEvents)) return;
  timelineEvents.forEach((ev) => {
    if (ev.year <= currentYear) {
      if (!activeEventMarkers[ev.name]) addEventMarker(ev);
    } else {
      if (activeEventMarkers[ev.name]) removeEventMarker(ev);
    }
  });
}
// === Timeline / Scroll marker setup ===
// timeline maps page scroll to years
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
const timelineEvents = [
  {
    name: "Pituffik Space Base",
    year: 1951,
    lat: 76.5312,
    lon: -68.7032,
  },
  { name: "Camp TUTO", year: 1954, lat: 76.15, lon: -67.8 },
  { name: "Camp Century", year: 1960, lat: 77.1667, lon: -61.1333 },
  { name: "Camp Fistclench", year: 1957, lat: 77.0, lon: -49.6 },
  { name: "Project Iceworm", year: 1958, lat: 77.8, lon: -61.4 },
  {
    name: "Narsarsuaq Air Base",
    year: 1941,
    lat: 61.16,
    lon: -45.43,
  },
  { name: "Inge Lehmann Station", year: 1950, lat: 69.14, lon: -49.95 },
  { name: "Station Nord", year: 1952, lat: 81.6, lon: -16.6667 },
  { name: "DYE-2 (DEW Line)", year: 1957, lat: 66.481, lon: -46.3 },
];

// Track active markers currently shown on the map (keyed by event name)
const activeEventMarkers = {};
let mapReady = false;

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
  // Determine current year from scroll percent. Use floor so the event shows
  // when the user has reached that year or passed it.
  const currentYear = Math.floor(
    startYear + scrollPercent * (endYear - startYear)
  );
  updateMapForYear(currentYear);
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

function createTextCards(textItems) {
  const contentDiv = document.getElementById("content");
  if (!Array.isArray(textItems)) return;

  textItems.forEach((item) => {
    const div = document.createElement("div");
    div.className = "text-card";
    div.dataset.year = item.year;
    div.dataset.yOffset = item.yOffset || 0;
    div.dataset.xOffset = item.xOffset || 0;
    div.style.position = "absolute";

    div.innerHTML = `
      <div class="text-card-inner">
        <strong>${item.year}</strong> ${item.content}
      </div>
    `;

    contentDiv.appendChild(div);
  });

  // store for layout positioning
  contentDiv._textItems = textItems;

  // immediately position them
  updateLayout();
  updateScrollMarker();
}

// === Load CSV ===
async function loadImageCSV() {
  try {
    const res = await fetch(IMAGE_SHEET_CSV_URL);
    const csvText = await res.text();

    // Use PapaParse for CSV parsing
    const data = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
    }).data;
    createImageCards(data);
    updateLayout();
    updateScrollMarker();
  } catch (err) {
    console.error("Error loading CSV:", err);
  }
}

async function loadTextCSV() {
  try {
    const res = await fetch(TEXT_SHEET_CSV_URL);
    const csvText = await res.text();

    // Use PapaParse for CSV parsing
    const data = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
    }).data;

    const textItems = [];

    data.forEach((row) => {
      const year = parseInt(row["Year"]);
      if (!year || isNaN(year)) return;

      const content = row["Text"] || "";
      if (!content.trim()) return;

      const location = row["Location"] || "";
      const yOffset = row["Y Offset"] ? parseFloat(row["Y Offset"]) : 0;
      const xOffset = row["X Offset"] ? parseFloat(row["X Offset"]) : 0;

      textItems.push({
        year,
        content,
        location,
        xOffset,
        yOffset,
        raw: row,
      });
    });

    createTextCards(textItems);
  } catch (err) {
    console.error("Error loading CSV:", err);
  }
}

// === Create Image Cards ===
function createImageCards(data) {
  const contentDiv = document.getElementById("content");
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
    const xOffset = item["X Offset"] ? parseFloat(item["X Offset"]) : 0;
    const yOffset = item["Y Offset"] ? parseFloat(item["Y Offset"]) : 0;

    validItems.push({ year, link, caption, id, xOffset, yOffset, raw: item });
  });

  // Store reference for layout calculations
  contentDiv._timelineItems = validItems;

  // Create DOM elements for each valid item
  validItems.forEach((it) => {
    const card = document.createElement("div");
    card.className = "image-card";
    card.dataset.year = it.year;
    card.style.position = "absolute";

    const fullPath = getExistingImagePath(it.id);

    card.dataset.xOffset = it.xOffset;
    card.dataset.yOffset = it.yOffset;

    if (fullPath) {
      card.innerHTML = `
      <img src="${fullPath}" alt="${it.caption}" />

      <div class="card-caption">
        <p class="caption-text">${it.caption}</p>
      </div>
    `;
    } else {
      console.warn(`No image found for ${it.id} / ${it.link}`);
      card.innerHTML = `
      <div class="missing">Image missing for ${it.id}</div>
      <div class="card-caption">
        <p class="caption-text"><strong>${it.year}</strong> — ${
        it.caption || ""
      }</p>
      </div>
    `;
    }

    // click to expand to full-screen view. We'll create an overlay to handle outside clicks.
    card.addEventListener("click", (e) => {
      e.stopPropagation();
      openCardFullScreen(card, it);
    });

    contentDiv.appendChild(card);

    // If the image is not yet loaded, re-run layout when it finishes loading so
    // we measure the real width/height before placement. This prevents overlap
    // caused by unknown dimensions.
    const imgEl = card.querySelector("img");
    if (imgEl && !imgEl.complete) {
      imgEl.addEventListener("load", () => {
        // clear any previous placed flag so layout can place it using correct dims
        delete card.dataset.placed;
        updateLayout();
        updateScrollMarker();
      });
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

// Overlay element for closing expanded view (used by FLIP clone)
let overlayEl = null;
function ensureOverlay() {
  if (!overlayEl) {
    overlayEl = document.createElement("div");
    overlayEl.className = "overlay-closeup";
    document.body.appendChild(overlayEl);
  }
}

// FLIP-style open/close using a clone so original layout doesn't jump
let currentClone = null;
let currentOriginal = null;
let currentCaption = null;
let captionOriginal = null;

function openCardFullScreen(card, item) {
  ensureOverlay();
  const img = card.querySelector("img");
  const caption = card.querySelector("div");
  if (!img) return;

  // close existing
  if (currentClone) closeImgFullScreen();

  const rect = img.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // combined max height for image + caption --
  const maxCombinedH = vh * 0.9;
  const captionH = 60; // estimate
  const maxImageH = maxCombinedH - captionH;

  const maxW = vw * 0.8;

  // natural aspect ratio
  const aspect =
    (img.naturalWidth || rect.width) / (img.naturalHeight || rect.height);

  // compute target size
  let targetW = Math.min(maxW, aspect * maxImageH);
  let targetH = targetW / aspect;

  if (targetH > maxImageH) {
    targetH = maxImageH;
    targetW = targetH * aspect;
  }

  // create clone
  const clone = img.cloneNode(true);
  clone.style.position = "fixed";
  clone.style.left = `${rect.left}px`;
  clone.style.top = `${rect.top}px`;
  clone.style.width = `${rect.width}px`;
  clone.style.height = `${rect.height}px`;
  clone.style.transition = "all 320ms ease";
  // clone sits above overlay but below caption
  clone.style.zIndex = 100001;
  clone.style.boxSizing = "border-box";

  document.body.appendChild(clone);

  // hide original
  card.opacity = 0;
  img.style.visibility = "hidden";
  caption.style.visibility = "hidden";
  currentOriginal = img;
  currentClone = clone;
  captionOriginal = caption;

  // show overlay (fade in)
  overlayEl.style.display = "block";
  overlayEl.style.pointerEvents = "auto";
  // ensure a frame so transition runs
  requestAnimationFrame(() => {
    overlayEl.style.opacity = "1";
  });

  // compute center translation
  const cx = vw / 2;
  const cy = vh / 2 - captionH / 2; // shift up so caption fits below
  const tx = cx - (rect.left + rect.width / 2);
  const ty = cy - (rect.top + rect.height / 2);
  const scale = targetW / rect.width;

  requestAnimationFrame(() => {
    clone.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  });

  // caption (positioned under the final image)
  const captionDiv = document.createElement("div");
  captionDiv.className = "fullscreen-caption";
  captionDiv.style.position = "fixed";
  captionDiv.style.left = `${cx - targetW / 2}px`;
  captionDiv.style.top = `${cy + targetH / 2 + 10}px`;
  captionDiv.style.width = `${targetW}px`;
  captionDiv.style.background = "rgba(0, 0, 0, 0.5)";
  captionDiv.style.color = "white";
  captionDiv.style.padding = "10px";
  // caption must be topmost so it's visible above overlay and clone
  captionDiv.style.zIndex = 100002;
  captionDiv.style.opacity = "0";
  captionDiv.innerHTML =
    `<p style="margin:0"><strong>${item.year}</strong> — ${
      item.caption || ""
    }</p>` +
    (item.link
      ? `<div><a href="${item.link}" target="_blank" rel="noopener">Source</a></div>`
      : "");

  // append caption to body so it's always above overlay/clone
  document.body.appendChild(captionDiv);
  currentCaption = captionDiv;

  overlayEl.style.display = "block";
  clone.addEventListener("transitionend", function onEnd() {
    captionDiv.style.transition = "opacity 200ms ease";
    captionDiv.style.opacity = "1";
    clone.removeEventListener("transitionend", onEnd);
  });

  overlayEl.onclick = closeImgFullScreen;
}

function closeImgFullScreen() {
  if (!currentClone) return;
  // hide caption
  if (currentCaption) currentCaption.style.opacity = "0";
  // reverse animate to original
  currentClone.style.transform = "none";
  currentClone.style.left = `${currentOriginal.getBoundingClientRect().left}px`;
  currentClone.style.top = `${currentOriginal.getBoundingClientRect().top}px`;
  currentClone.style.width = `${
    currentOriginal.getBoundingClientRect().width
  }px`;
  currentClone.style.height = `${
    currentOriginal.getBoundingClientRect().height
  }px`;
  // fade out overlay
  if (overlayEl) {
    overlayEl.style.opacity = "0";
    overlayEl.style.pointerEvents = "none";
  }
  currentClone.addEventListener("transitionend", function onEnd() {
    currentClone.remove();
    currentCaption && currentCaption.remove();
    currentOriginal && (currentOriginal.style.visibility = "");
    captionOriginal && (captionOriginal.style.visibility = "");

    currentClone = null;
    currentCaption = null;
    currentOriginal = null;
    // hide overlay after transition completes
    if (overlayEl) overlayEl.style.display = "none";
    setTimeout(() => updateLayout(), 40);
    currentClone && currentClone.removeEventListener("transitionend", onEnd);
  });
}

// === Load PapaParse then CSV ===
const papaScript = document.createElement("script");
papaScript.src =
  "https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js";
papaScript.onload = async () => {
  await loadImageCSV();
  await loadTextCSV();
};

document.head.appendChild(papaScript);

// Layout - timeline card positioning
function updateLayout() {
  const contentDiv = document.getElementById("content");
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let leftStart = 40;
  const padding = 200;
  const basePixelsPerYear = 120; // default spacing per year
  const stretchFactor = 20; // how much denser years can expand (1 = no stretch)

  // Count items per year (images + text) to compute density
  const counts = {};
  const imageItems = contentDiv._timelineItems || [];
  const textItems = contentDiv._textItems || [];
  imageItems.forEach((it) => (counts[it.year] = (counts[it.year] || 0) + 1));
  textItems.forEach((it) => (counts[it.year] = (counts[it.year] || 0) + 1));

  // Find max count to normalize
  let maxCount = 0;
  for (let y = startYear; y <= endYear; y++) {
    if ((counts[y] || 0) > maxCount) maxCount = counts[y];
  }

  // Build per-year spacing array
  const yearSpacing = [];
  let totalSpacing = 0;
  for (let y = startYear; y <= endYear; y++) {
    const c = counts[y] || 0;
    const extraRatio = maxCount > 0 ? c / maxCount : 0;
    // spacing scales between basePixelsPerYear and basePixelsPerYear * stretchFactor
    const spacing = basePixelsPerYear * (1 + extraRatio * (stretchFactor - 1));
    yearSpacing.push(spacing);
    totalSpacing += spacing;
  }

  const totalYears = endYear - startYear + 1;
  const contentHeight = Math.round(totalSpacing + padding * 2);
  contentDiv.style.height = contentHeight + "px";
  contentDiv.style.position = "relative";
  const contentWidth = contentDiv.clientWidth;

  // helper to compute top position for a given year (center of its band)
  const yearTop = (year) => {
    const index = year - startYear;
    let cum = 0;
    for (let i = 0; i < index; i++) cum += yearSpacing[i];
    // center of the year's band
    return padding + cum + yearSpacing[index] / 2;
  };

  // --- IMAGES ---
  // Collect all cards and group UNPLACED cards by year for banded placement.
  // Cards that already have a stored placement (data-placed) will be left alone.
  const allCards = Array.from(
    contentDiv.querySelectorAll(".image-card, .text-card")
  );
  const cardsByYear = {};
  allCards.forEach((card) => {
    const y = parseInt(card.dataset.year, 10);
    if (!y || isNaN(y)) return;

    // If this card already has a fixed placement (from an earlier run), keep it.
    if (card.dataset.placed === "1") {
      if (card.dataset.left) card.style.left = card.dataset.left;
      if (card.dataset.top) card.style.top = card.dataset.top;
      return; // skip repositioning
    }

    if (!cardsByYear[y]) cardsByYear[y] = [];
    cardsByYear[y].push(card);
  });

  // For each year, attempt to place cards randomly inside that year's vertical band
  // Maintain a global list of placed rects so placements from one year don't
  // overlap items placed for other years.
  const globalPlaced = [];

  // initialize globalPlaced with any previously placed cards so we avoid
  // overlapping earlier placements
  allCards.forEach((card) => {
    if (card.dataset.placed === "1") {
      const leftPx =
        parseInt(card.dataset.left || card.style.left || "0px", 10) || 0;
      const topPx =
        parseInt(card.dataset.top || card.style.top || "0px", 10) || 0;
      const cw = card.offsetWidth || 80;
      const ch = card.offsetHeight || 40;
      globalPlaced.push({
        left: leftPx,
        top: topPx,
        right: leftPx + cw,
        bottom: topPx + ch,
      });
    }
  });

  for (let y = startYear; y <= endYear; y++) {
    const items = cardsByYear[y] || [];
    if (items.length === 0) continue;

    const index = y - startYear;
    const bandCenter = yearTop(y);
    const bandHalf = yearSpacing[index] / 2;
    const bandTop = Math.max(0, bandCenter - bandHalf + 8);
    const bandBottom = Math.min(contentHeight, bandCenter + bandHalf - 8);

    // Keep track of placed rects to avoid overlap (share with globalPlaced)
    const placed = globalPlaced;

    // Shuffle order to avoid predictable stacking
    const shuffled = items.slice().sort(() => Math.random() - 0.5);

    shuffled.forEach((card, idx) => {
      const cw = Math.max(40, card.offsetWidth || 80);
      const ch = Math.max(24, card.offsetHeight || 40);

      const centerX = Math.round(contentWidth / 2);
      // horizontal spread range (±20% of content width)
      const spread = Math.round(contentWidth * 0.5);
      const minLeft = 16;
      const maxLeft = Math.max(minLeft, contentWidth - cw - 16);

      let placedOk = false;
      let attempt = 0;
      const maxAttempts = 200;

      while (!placedOk && attempt < maxAttempts) {
        attempt++;
        // random Y inside band (clamp so card fits)
        const yRangeTop = bandTop;
        const yRangeBottom = Math.max(bandTop + 2, bandBottom - ch);
        const randTop = Math.round(
          yRangeTop + Math.random() * Math.max(0, yRangeBottom - yRangeTop)
        );

        // random X around center
        const randOffset = Math.round((Math.random() * 2 - 1) * spread);
        let left = centerX + randOffset - Math.round(cw / 2);
        left = Math.max(minLeft, Math.min(maxLeft, left));

        const rect = {
          left,
          top: randTop,
          right: left + cw,
          bottom: randTop + ch,
        };

        // check overlap with small padding
        const pad = 12;
        let conflict = false;
        for (const r of placed) {
          if (
            !(
              rect.right + pad < r.left ||
              rect.left - pad > r.right ||
              rect.bottom + pad < r.top ||
              rect.top - pad > r.bottom
            )
          ) {
            conflict = true;
            break;
          }
        }

        if (!conflict) {
          // accept place and persist placement so future layout runs won't reshuffle
          card.style.left = `${left}px`;
          card.style.top = `${randTop}px`;
          card.dataset.placed = "1";
          card.dataset.left = card.style.left;
          card.dataset.top = card.style.top;
          placed.push(rect);
          // also add to globalPlaced so subsequent years respect this rect
          if (placed !== globalPlaced) globalPlaced.push(rect);
          placedOk = true;
        }
      }

      if (!placedOk) {
        // fallback: stack them vertically from the top of the band
        const left = Math.max(
          16,
          Math.min(contentWidth / 2 - Math.round(cw / 2), maxLeft)
        );
        const topFallback = bandTop + idx * (ch + 6);
        const finalTop = Math.min(topFallback, bandBottom - ch);
        card.style.left = `${left}px`;
        card.style.top = `${finalTop}px`;
        card.dataset.placed = "1";
        card.dataset.left = card.style.left;
        card.dataset.top = card.style.top;
        if (placed !== globalPlaced)
          globalPlaced.push({
            left: parseInt(card.style.left, 10) || 0,
            top: parseInt(card.style.top, 10) || 0,
            right: (parseInt(card.style.left, 10) || 0) + cw,
            bottom: (parseInt(card.style.top, 10) || 0) + ch,
          });
      }
    });
  }
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
