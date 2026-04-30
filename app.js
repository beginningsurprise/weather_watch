/* ============================================================
   app.js — WeatherSoup orchestration, state, data fetching
   ============================================================
   CHANGE LOG (v.260427):
   - Introduced TimeDomain derived object (AppState.derived.timeDomain)
   - buildTimeDomain(): derives skycycles from daily sunrise/sunset;
     called on every clock tick and after each data fetch
   - AppState.derived.skybowlWindow aliased from timeDomain.cycles[0]
     when nowSkyView === 'current' (SKY panel unchanged)
   - FORECAST panel: x-axis now driven by timeDomain.window
     (skycycle-aligned, includes past hours in current cycle)
   - FORECAST toggle: "next 30h / next 7d" → "3 cycles / 7 cycles"
     (AppState.view.cycleCount replaces hourlyHours for forecast)
   - FORECAST: added precise "now" marker line (updates per second)
   - WEEKLY: gradient highlight keyed to timeDomain window overlap
     intensity = 1 − (dist_from_now / window_len), fades outward
   - Previous changelog (v.260426):
   - Replaced scattered state with unified AppState object
   - Removed all window._last* globals and duplicate compat vars
   - Added ECMWF IFS as a parallel data source (Promise.all)
   - Expanded BM hourly + daily fields; added expanded tooltips
   ============================================================ */


/* ============================================================
   LOCATIONS
   ============================================================ */
const LOCATIONS = [
  { label: 'Chicago, IL',       lat:  41.9,     lon:  -87.9,    tz: 'America/Chicago'    },
  { label: 'Miami, FL',         lat:  25.7617,  lon:  -80.1918, tz: 'America/New_York'   },
  { label: 'San Francisco, CA', lat:  37.7749,  lon: -122.4194, tz: 'America/Los_Angeles'},
  { label: 'New York, NY',      lat:  40.7128,  lon:  -74.006,  tz: 'America/New_York'   },
  { label: 'London, UK',        lat:  51.5074,  lon:   -0.1278, tz: 'Europe/London'      },
  { label: 'Paris, France',     lat:  48.8566,  lon:    2.3522, tz: 'Europe/Paris'       },
  { label: 'Tokyo, Japan',      lat:  35.6762,  lon:  139.6503, tz: 'Asia/Tokyo'         },
  { label: 'Sydney, Australia', lat: -33.8688,  lon:  151.2093, tz: 'Australia/Sydney'   },
  { label: 'Nairobi, Kenya',    lat:  -1.2921,  lon:   36.8219, tz: 'Africa/Nairobi'     },
];


/* ============================================================
   APPSTATE — single source of truth for the entire app.
   Both app.js and skybowl.js read from this object.
   No window._last* globals. No duplicate compat vars.
   ============================================================ */
const AppState = {
  config: {
    ...LOCATIONS[0],
    refreshMinutes: 15,
    pulseStyle: {
      periodMs:   2000,    // full pulse cycle duration
      decay:      4.5,     // sharpness of exponential decay (higher = sharper tick)
      minScale:   1.0,
      maxScale:   1.55,
      minAlpha:   0.55,
      maxAlpha:   1.0,
      colorMode:  'accent', // 'accent' | 'hot'
      glowStrength: 12,    // shadow blur radius in px
    },
  },

  view: {
    skin:        localStorage.getItem('wb-skin') || 'canonical',
    nowSkyView:  'current',   // 'current' | 'other' | 'other2'
    hourlyHours: 30,          // legacy; not used for forecast rendering
    cycleCount:  3,           // 3 or 6 skycycles in TimeDomain
    dailyDays:   7,
  },

  bm: {      // Best Match — open-meteo /v1/forecast (existing source)
    current: null,
    hourly:  null,
    daily:   null,
  },

  ecmwf: null,   // ECMWF IFS hourly, or null if fetch failed

  derived: {
    sunTimes:     null,    // [sunriseDt, sunsetDt]  Date objects
    cloudPct:     0,
    weatherEmoji: '☀️',
    comfortEmoji: '',
    skybowlWindow: null,   // { start: Date, end: Date, isNight: bool }
    timeDomain:   null,    // { now, cycles[], window: {start,end} }
    pulse: { phase: 0, t: 0 },  // global pulse state — updated by _pulseLoop
  },

  meta: {
    elev: null,
    pop:  null,
  },
};

/* ── Convenience alias (wide use in this file) ── */
let CONFIG = AppState.config;


/* ============================================================
   GLOBAL PULSE SYSTEM
   ============================================================
   A single rAF loop updates AppState.derived.pulse continuously.
   All panels call getPulseIntensity/Scale/Alpha — no independent
   animations, no CSS keyframes, no per-panel timing.
   ============================================================ */
(function _startPulseLoop() {
  let _pulseRaf = null;
  function _pulseLoop(ts) {
    const ps = AppState.config.pulseStyle;
    AppState.derived.pulse.phase = (ts % ps.periodMs) / ps.periodMs;
    AppState.derived.pulse.t     = ts;
    _pulseRaf = requestAnimationFrame(_pulseLoop);
  }
  _pulseRaf = requestAnimationFrame(_pulseLoop);
})();

/** Returns intensity in [0,1]: fast rise at phase≈0, smooth exponential decay. */
function getPulseIntensity() {
  const { phase, } = AppState.derived.pulse;
  const k = AppState.config.pulseStyle.decay;
  return Math.exp(-k * phase);
}

/** Returns scale for size pulsing. */
function getPulseScale() {
  const ps  = AppState.config.pulseStyle;
  const i   = getPulseIntensity();
  return ps.minScale + (ps.maxScale - ps.minScale) * i;
}

/** Returns opacity for alpha pulsing. */
function getPulseAlpha() {
  const ps = AppState.config.pulseStyle;
  const i  = getPulseIntensity();
  return ps.minAlpha + (ps.maxAlpha - ps.minAlpha) * i;
}

/** Returns the pulse CSS color string (reads from CSS variables). */
function getPulseColor() {
  const mode = AppState.config.pulseStyle.colorMode;
  const cs   = getComputedStyle(document.body);
  return (mode === 'hot')
    ? cs.getPropertyValue('--hot').trim()
    : cs.getPropertyValue('--accent').trim();
}

/** Writes --pulse-color and --pulse-glow CSS variables to :root.
    Called once on boot; panels read via var(--pulse-color). */
function _syncPulseCssVars() {
  const color = getPulseColor();
  const gs    = AppState.config.pulseStyle.glowStrength;
  document.documentElement.style.setProperty('--pulse-color', color);
  document.documentElement.style.setProperty('--pulse-glow',  `0 0 ${gs}px ${color}`);
}
_syncPulseCssVars();
// Re-sync when skin toggles (accent color changes)
document.getElementById('skin-toggle')?.addEventListener('click', _syncPulseCssVars);


/* ============================================================
   SKIN HELPERS
   ============================================================ */
const isSkinCanonical = () => document.body.classList.contains('skin-canonical');
const isSkinTerminal  = () => document.body.classList.contains('skin-terminal');
const isSkinLight     = () => isSkinCanonical();   // canonical is the light skin

// Migrate any stored legacy skin name to the two-skin scheme
{
  const stored = localStorage.getItem('wb-skin') || 'canonical';
  AppState.view.skin = (stored === 'terminal') ? 'terminal' : 'canonical';
}
document.body.className = `skin-${AppState.view.skin}`;

document.getElementById('skin-toggle').addEventListener('click', () => {
  AppState.view.skin = (AppState.view.skin === 'canonical') ? 'terminal' : 'canonical';
  document.body.className = `skin-${AppState.view.skin}`;
  // Re-apply night-mode class if needed
  _applyNightMode();
  localStorage.setItem('wb-skin', AppState.view.skin);
  if (AppState.derived.sunTimes) redrawNowSky();
});


/* ============================================================
   NIGHT-MODE BACKGROUND (canonical skin only)
   ============================================================ */
function _applyNightMode() {
  const td = AppState.derived.timeDomain;
  const isNight = td && td.cycles && td.cycles[0] ? td.cycles[0].isNight : false;
  document.body.classList.toggle('night-mode', isNight && isSkinCanonical());
}


/* ============================================================
   ANEMOMETER — canvas wind instrument (NOW panel)
   ============================================================ */
let _anemometerRaf = null;
let _anemometerAngle = 0;

function drawAnemometer() {
  const canvas = document.getElementById('anemometer-canvas');
  if (!canvas) return;

  const mph = (AppState.bm.current && AppState.bm.current.wind_mph != null)
    ? AppState.bm.current.wind_mph : 0;
  const deg = (AppState.bm.current && AppState.bm.current.wind_deg != null)
    ? AppState.bm.current.wind_deg : 0;

  const SIZE = 64;
  const dpr  = window.devicePixelRatio || 1;
  if (canvas.width !== SIZE * dpr) {
    canvas.width  = SIZE * dpr;
    canvas.height = SIZE * dpr;
    canvas.style.width  = SIZE + 'px';
    canvas.style.height = SIZE + 'px';
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, SIZE, SIZE);

  const cx = SIZE / 2, cy = SIZE / 2;
  const cs = getComputedStyle(document.body);
  const accentColor = cs.getPropertyValue('--accent').trim() || '#1a7fd4';
  const fg3Color    = cs.getPropertyValue('--fg3').trim()    || '#4a6a8a';
  const fgDimColor  = cs.getPropertyValue('--fg-dim').trim() || '#7a9ab8';

  // Outer ring
  ctx.beginPath();
  ctx.arc(cx, cy, cx - 2, 0, Math.PI * 2);
  ctx.strokeStyle = fg3Color;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.35;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Direction indicator arm (points INTO the wind = meteorological convention)
  const dirRad = (deg - 90) * Math.PI / 180;
  const armLen = cx + 10;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(dirRad) * armLen, cy + Math.sin(dirRad) * armLen);
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 5;
  ctx.globalAlpha = 0.7;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Three cups rotating at speed proportional to wind mph
  _anemometerAngle = (_anemometerAngle + Math.max(0.01, mph * 0.015)) % (Math.PI * 2);
  const cupR   = cx - 12;
  const cupSize = 5;
  for (let i = 0; i < 3; i++) {
    const a = _anemometerAngle + (i * Math.PI * 2) / 3;
    const bx = cx + Math.cos(a) * cupR;
    const by = cy + Math.sin(a) * cupR;
    // Arm to cup
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(bx, by);
    ctx.strokeStyle = fg3Color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1;
    // Cup circle
    ctx.beginPath();
    ctx.arc(bx, by, cupSize, 0, Math.PI * 2);
    ctx.fillStyle = (i === 0) ? accentColor : fgDimColor;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Center dot
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fillStyle = accentColor;
  ctx.fill();

  // Label
  const labelEl = document.getElementById('anemometer-label');
  if (labelEl) {
    const wd = windDir(deg);
    labelEl.textContent = `${wd.cardinal} ${mph}`;
  }
}

function _anemometerLoop() {
  drawAnemometer();
  _anemometerRaf = requestAnimationFrame(_anemometerLoop);
}

function startAnemometer() {
  if (_anemometerRaf) return;   // already running
  _anemometerLoop();
}


/* ============================================================
   UNIT HELPERS
   ============================================================ */
const toF    = c   => Math.round(c * 9/5 + 32);
const toMph  = kph => Math.round(kph / 1.60934);
const toIn   = mm  => (mm / 25.4).toFixed(2);
const toMi   = m   => m != null ? (m / 1609.34).toFixed(1) : null;
const round1 = n   => Math.round(n * 10) / 10;


/* ============================================================
   TIMEZONE HELPER
   ============================================================ */
function nowInTz(tz) {
  return new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
}


/* ============================================================
   WEATHER CODE → emoji + description
   ============================================================ */
const WMO = {
  0:  { e: '☀️',  d: 'Clear'                  },
  1:  { e: '🌤️', d: 'Mainly Clear'            },
  2:  { e: '⛅',  d: 'Partly Cloudy'           },
  3:  { e: '☁️',  d: 'Overcast'               },
  45: { e: '🌫️', d: 'Fog'                     },
  48: { e: '🌫️', d: 'Icy Fog'                 },
  51: { e: '🌦️', d: 'Light Drizzle'           },
  53: { e: '🌦️', d: 'Drizzle'                 },
  55: { e: '🌧️', d: 'Heavy Drizzle'           },
  61: { e: '🌧️', d: 'Light Rain'              },
  63: { e: '🌧️', d: 'Rain'                    },
  65: { e: '🌧️', d: 'Heavy Rain'              },
  71: { e: '🌨️', d: 'Light Snow'              },
  73: { e: '🌨️', d: 'Snow'                    },
  75: { e: '❄️',  d: 'Heavy Snow'              },
  77: { e: '🌨️', d: 'Snow Grains'             },
  80: { e: '🌦️', d: 'Showers'                 },
  81: { e: '🌧️', d: 'Showers'                 },
  82: { e: '⛈️', d: 'Heavy Showers'           },
  85: { e: '🌨️', d: 'Snow Showers'            },
  86: { e: '❄️',  d: 'Heavy Snow Showers'      },
  95: { e: '⛈️', d: 'Thunderstorm'            },
  96: { e: '⛈️', d: 'T-Storm + Hail'          },
  99: { e: '⛈️', d: 'T-Storm + Heavy Hail'    },
};
const wmo = code => WMO[code] || WMO[Math.floor(code / 10) * 10] || { e: '🌡️', d: 'Unknown' };

const dewComfortEmoji = dewF => {
  if (dewF < 35) return '🌵';
  if (dewF < 50) return '🙂';
  if (dewF < 60) return '😐';
  if (dewF < 70) return '💧';
  return '🌊';
};

const dewComfortLabel = dewF => {
  if (dewF < 35) return 'dry';
  if (dewF < 50) return 'comfortable';
  if (dewF < 60) return 'mild';
  if (dewF < 70) return 'humid';
  return 'oppressive';
};

const uvColor = uv => {
  const cs = getComputedStyle(document.body);
  if (uv <= 2) return cs.getPropertyValue('--uv-low').trim();
  if (uv <= 5) return cs.getPropertyValue('--uv-mid').trim();
  return cs.getPropertyValue('--uv-high').trim();
};

const windDir = deg => {
  const dirs   = ['N','NE','E','SE','S','SW','W','NW'];
  const arrows = ['↓','↙','←','↖','↑','↗','→','↘'];
  const i = Math.round(deg / 45) % 8;
  return { arrow: arrows[i], cardinal: dirs[i] };
};

const fmtHour = iso => String(new Date(iso).getHours()).padStart(2, '0');

const fmtTime12 = d => {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
};

const fmtDay = iso => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });

const fmtMD = iso => {
  const d = new Date(iso + 'T12:00:00');
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

const fmt24 = iso => new Date(iso).toLocaleTimeString('en-GB', {
  timeZone: CONFIG.tz, hour: '2-digit', minute: '2-digit', hour12: false,
});


/* ============================================================
   TIME DOMAIN — skycycle-based time model
   ============================================================

   buildTimeDomain() derives AppState.derived.timeDomain from the
   daily sunrise/sunset arrays fetched by open-meteo.  It produces
   an ordered list of skycycles (day or night windows) starting
   with the CURRENT cycle, plus (cycleCount-1) future cycles.

   skybowlWindow is kept as an alias of cycles[0] so the SKY panel
   continues to work without modification.
   ============================================================ */
function buildTimeDomain() {
  const daily = AppState.bm.daily;
  if (!daily || !daily.sunrise || !daily.sunset) return;

  const tz          = CONFIG.tz;
  const now         = nowInTz(tz);
  const cycleCount  = AppState.view.cycleCount || 3;

  /* ── Parse all available sunrise/sunset pairs into Date objects ── */
  const srAll = daily.sunrise.map(s => new Date(s));
  const ssAll = daily.sunset .map(s => new Date(s));
  const nDays = Math.min(srAll.length, ssAll.length);

  /* ── Helper: return nightMs for a given day index (inferred if needed) ── */
  function nightMs(i) {
    const sr = srAll[i], ss = ssAll[i];
    if (!sr || !ss) {
      /* Infer from adjacent day */
      const adj = srAll[i + 1] && ssAll[i + 1]
        ? ssAll[i + 1] - srAll[i + 1]
        : (srAll[i - 1] && ssAll[i - 1] ? ssAll[i - 1] - srAll[i - 1] : 12 * 3600000);
      return 24 * 3600000 - adj;
    }
    return 24 * 3600000 - (ss - sr);
  }

  /* ── Enumerate all cycle boundaries within a generous lookahead ── */
  /* Each entry: { start, end, isNight } */
  const allCycles = [];

  for (let i = 0; i < nDays; i++) {
    const sr = srAll[i], ss = ssAll[i];
    if (!sr || !ss) continue;

    /* Previous night: sunset[i-1] → sunrise[i] */
    if (i === 0) {
      /* Estimate previous sunset by inferring nightMs for day 0 */
      const prevSs = new Date(sr.getTime() - nightMs(0));
      allCycles.push({ start: prevSs, end: sr, isNight: true });
    }

    /* Daytime cycle */
    allCycles.push({ start: sr, end: ss, isNight: false });

    /* Night cycle: sunset[i] → sunrise[i+1] */
    const nextSr = srAll[i + 1];
    if (nextSr) {
      allCycles.push({ start: ss, end: nextSr, isNight: true });
    } else {
      /* Infer: add estimated night using nightMs */
      const ns = nightMs(i);
      allCycles.push({ start: ss, end: new Date(ss.getTime() + ns), isNight: true });
    }
  }

  /* ── Find the current cycle (the one that contains `now`) ── */
  let currentIdx = allCycles.findIndex(c => now >= c.start && now < c.end);
  if (currentIdx < 0) {
    /* Fallback: find the cycle whose start is closest in the past */
    currentIdx = 0;
    for (let i = 0; i < allCycles.length; i++) {
      if (allCycles[i].start <= now) currentIdx = i;
      else break;
    }
  }

  /* ── Select cycleCount cycles starting from current ── */
  const cycles = allCycles.slice(currentIdx, currentIdx + cycleCount);

  /* ── If we don't have enough cycles, pad with inferred ones ── */
  while (cycles.length < cycleCount && cycles.length > 0) {
    const last = cycles[cycles.length - 1];
    const dur  = last.end - last.start;
    cycles.push({ start: last.end, end: new Date(last.end.getTime() + dur), isNight: !last.isNight });
  }

  /* ── Build window: from current cycle start → last cycle end ── */
  const windowStart = cycles.length > 0 ? cycles[0].start : now;
  const windowEnd   = cycles.length > 0 ? cycles[cycles.length - 1].end : new Date(now.getTime() + 72 * 3600000);

  AppState.derived.timeDomain = {
    now,
    cycles,
    window: { start: windowStart, end: windowEnd },
  };

  /* ── Apply night-mode background class (canonical skin only) ── */
  _applyNightMode();

  /* ── Keep skybowlWindow in sync with cycles[0] (Step 2) ── */
  /* Only override if nowSkyView is 'current'; other views are
     managed by updateSkybowlWindowForView() in skybowl.js */
  if (AppState.view.nowSkyView === 'current' && cycles.length > 0) {
    AppState.derived.skybowlWindow = {
      start:   cycles[0].start,
      end:     cycles[0].end,
      isNight: cycles[0].isNight,
    };
  }
}


/* ============================================================
   CLOCK
   ============================================================ */
function getTzAbbr(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(new Date());
    const p = parts.find(p => p.type === 'timeZoneName');
    return p ? p.value : '';
  } catch (e) { return ''; }
}

function tickClock() {
  const tz  = CONFIG.tz || 'America/Chicago';
  const now = new Date();
  const hhmm = now.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  const ss   = String(now.getSeconds()).padStart(2, '0');

  const hhmmEl = document.getElementById('time-hhmm');
  const ssEl   = document.getElementById('time-ss');
  if (hhmmEl) hhmmEl.textContent = hhmm;
  if (ssEl) {
    ssEl.textContent = ':' + ss;
    /* Subtle pulse on seconds — brightness via text-shadow */
    const alpha = getPulseAlpha();
    const color = getPulseColor();
    ssEl.style.textShadow = `0 0 ${Math.round(8 * getPulseIntensity())}px ${color}`;
    ssEl.style.opacity    = (0.65 + 0.35 * alpha).toFixed(3);
  }

  const tzEl = document.getElementById('time-tz');
  if (tzEl) tzEl.textContent = getTzAbbr(tz);

  const dateEl = document.getElementById('banner-date');
  if (dateEl) {
    dateEl.textContent = now.toLocaleDateString('en-US', {
      timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
    });
  }

  const skyFeelsEl = document.getElementById('sky-feels');
  if (skyFeelsEl) {
    skyFeelsEl.textContent = now.toLocaleDateString('en-US', {
      timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
    });
  }

  /* Recompute timeDomain every tick so the now-marker stays accurate */
  if (AppState.bm.daily) {
    buildTimeDomain();
    _updateNowMarker();
  }
}
setInterval(tickClock, 1000);
tickClock();


/* ── Update the "now" marker position in the hourly SVG ── */
function _updateNowMarker() {
  const td = AppState.derived.timeDomain;
  if (!td || !AppState.bm.hourly) return;

  const svgEl = document.getElementById('hourly-svg');
  if (!svgEl) return;

  const marker = svgEl.querySelector('#td-now-marker');
  if (!marker) return;   // SVG not yet rendered with timeDomain

  const { start, end } = td.window;
  const nowMs = td.now.getTime();
  const frac  = (nowMs - start.getTime()) / (end.getTime() - start.getTime());
  if (frac < 0 || frac > 1) { marker.style.display = 'none'; return; }

  const svgW = parseFloat(svgEl.getAttribute('width') || 0);
  if (!svgW) return;
  const x = frac * svgW;
  marker.setAttribute('x1', x.toFixed(1));
  marker.setAttribute('x2', x.toFixed(1));
  marker.style.display = '';

  /* Pulse the now-marker stroke: opacity + slight width breathe */
  const pAlpha = getPulseAlpha();
  const pIntensity = getPulseIntensity();
  marker.setAttribute('opacity',      (0.55 + 0.45 * pAlpha).toFixed(3));
  marker.setAttribute('stroke-width', (1.0  + 1.0  * pIntensity).toFixed(2));
  const pColor = getPulseColor();
  marker.setAttribute('stroke', pColor);
  /* Update glow line (next sibling) if present */
  const glowLine = marker.nextElementSibling;
  if (glowLine && glowLine.tagName === 'line') {
    glowLine.setAttribute('opacity', (0.04 + 0.10 * pIntensity).toFixed(3));
    glowLine.setAttribute('stroke',  pColor);
  }
}


/* ============================================================
   TOPBAR HELPERS
   ============================================================ */
function updateTopbarLocation() {
  const el = document.getElementById('topbar-loc-name');
  if (!el) return;
  el.textContent = (CONFIG.label || '').split(',')[0].trim().toUpperCase() || '—';
}
updateTopbarLocation();


/* ============================================================
   GLOBE ANIMATION
   ============================================================ */
let _globeAnimRunning = false;

function animateGlobe() {
  /* rAF is scheduled FIRST so a drawGlobe crash never orphans the loop */
  requestAnimationFrame(animateGlobe);
  try {
    drawGlobe(CONFIG.lat, CONFIG.lon);
  } catch (e) {
    /* Swallow the frame error; next frame will retry with same or new CONFIG */
    console.warn('drawGlobe frame error:', e);
  }
}

function startGlobeWhenReady() {
  if (_globeAnimRunning) return;
  _globeAnimRunning = true;
  setTimeout(() => animateGlobe(), 50);
}

if (window.WORLD_POLYS_READY) {
  startGlobeWhenReady();
} else {
  window.addEventListener('worldpolysready', startGlobeWhenReady, { once: true });
}


/* ============================================================
   FETCH WITH RETRY
   ============================================================ */
async function fetchWithRetry(url, retries = 2) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (retries > 0) return fetchWithRetry(url, retries - 1);
    throw err;
  }
}


/* ============================================================
   FETCH OPEN-METEO — Best Match + ECMWF in parallel
   ============================================================ */
async function fetchWeather() {
  const base = 'https://api.open-meteo.com/v1/forecast';

  const currentFields = [
    'temperature_2m','relative_humidity_2m','dew_point_2m',
    'apparent_temperature','precipitation','weather_code',
    'cloud_cover','wind_speed_10m','wind_direction_10m','uv_index',
  ].join(',');

  // Full BM hourly — includes all new fields
  const bmHourlyFields = [
    'weather_code','temperature_2m','dew_point_2m','apparent_temperature',
    'relative_humidity_2m','precipitation','precipitation_probability',
    'wind_speed_10m','wind_direction_10m','wind_gusts_10m',
    'uv_index','cloud_cover','is_day','snowfall','visibility',
  ].join(',');

  const bmDailyFields = [
    'temperature_2m_max','temperature_2m_min','precipitation_sum',
    'precipitation_probability_max','weather_code','sunrise','sunset',
    'sunshine_duration',
  ].join(',');

  const commonParams =
    `?latitude=${CONFIG.lat}&longitude=${CONFIG.lon}` +
    `&timezone=${encodeURIComponent(CONFIG.tz)}` +
    `&forecast_days=16`;

  const bmUrl = `${base}${commonParams}` +
    `&current=${encodeURIComponent(currentFields)}` +
    `&hourly=${encodeURIComponent(bmHourlyFields)}` +
    `&daily=${encodeURIComponent(bmDailyFields)}`;

  // ECMWF IFS — only fields it actually provides (no uv_index, no apparent_temperature)
  const ecmwfHourlyFields = [
    'temperature_2m','dew_point_2m','precipitation',
    'wind_speed_10m','wind_direction_10m','cloud_cover','weather_code',
  ].join(',');

  const ecmwfUrl = `${base}${commonParams}` +
    `&hourly=${encodeURIComponent(ecmwfHourlyFields)}` +
    `&models=ecmwf_ifs025`;

  const [bmData, ecmwfData] = await Promise.all([
    fetchWithRetry(bmUrl),
    fetchWithRetry(ecmwfUrl).catch(err => {
      console.warn('ECMWF fetch failed, continuing without it:', err.message);
      return null;
    }),
  ]);

  if (!bmData.current) throw new Error('API response missing "current" block');

  // Populate AppState.bm
  AppState.bm.current = bmData.current;
  AppState.bm.hourly  = bmData.hourly;
  AppState.bm.daily   = bmData.daily;

  // Populate AppState.ecmwf (null on failure)
  AppState.ecmwf = ecmwfData?.hourly ? ecmwfData.hourly : null;

  return bmData;   // returned for legacy call-sites
}


/* ============================================================
   DOM ELEMENT MAP
   ============================================================ */
const NOW_EL = {
  tempF:        document.getElementById('now-temp-f'),
  tempC:        document.getElementById('now-temp-c'),
  condition:    document.getElementById('now-condition'),
  windLabel:    document.getElementById('now-wind-label'),
  humidity:     document.getElementById('now-humidity'),
  dew:          document.getElementById('now-dew'),
  precip:       document.getElementById('now-precip'),
  comfortEmoji: document.getElementById('now-comfort-emoji'),
  skyBtns:      document.getElementById('now-sky-btns'),
};


/* ============================================================
   RENDER NOW
   ============================================================ */
function renderSky(data) {
  const c  = data.current;
  const cw = data.current_weather || {};
  const d  = data.daily;

  const tempC   = c.temperature_2m          ?? cw.temperature    ?? 0;
  const windKph = c.wind_speed_10m           ?? cw.windspeed      ?? 0;
  const windDeg = c.wind_direction_10m       ?? cw.winddirection  ?? 0;
  const wCode   = c.weather_code             ?? cw.weathercode    ?? 0;
  const rh      = c.relative_humidity_2m     ?? 0;
  const dewC    = c.dew_point_2m             ?? 0;
  const precip  = c.precipitation            ?? 0;
  const cloud   = c.cloud_cover              ?? 0;

  const tempF = toF(tempC);
  const w     = wmo(wCode);
  const wd    = windDir(windDeg);

  const srDt0  = new Date(d.sunrise[0]);
  const ssDt0  = new Date(d.sunset[0]);
  const locNow = nowInTz(CONFIG.tz);
  const isNight = locNow < srDt0 || locNow > ssDt0;

  let condEmoji = w.e;
  if (isNight && wCode === 0) condEmoji = '🌙';

  const el = NOW_EL;
  if (el.tempF) el.tempF.textContent = `${tempF}°F`;
  if (el.tempC) el.tempC.textContent = `${Math.round(tempC)}°C`;
  if (el.condition) {
    el.condition.textContent = `${condEmoji} ${w.d}`;
    // Responsive font size based on description length (emoji + space + text)
    const len = w.d.length;
    el.condition.classList.remove('cond-md', 'cond-sm', 'cond-xs');
    if      (len > 16) el.condition.classList.add('cond-xs');
    else if (len > 11) el.condition.classList.add('cond-sm');
    else if (len >  7) el.condition.classList.add('cond-md');
    // ≤7 chars: no class → full 3.2rem (e.g. "Clear", "Fog", "Rain")
  }

  if (el.tempF) {
    const cs = getComputedStyle(document.body);
    if (tempF >= 85)      el.tempF.style.color = cs.getPropertyValue('--hot').trim();
    else if (tempF <= 32) el.tempF.style.color = cs.getPropertyValue('--cold').trim();
    else                  el.tempF.style.color = cs.getPropertyValue('--accent').trim();
  }

  // Update AppState with wind (read by skybowl via AppState directly)
  AppState.bm.current.wind_mph = toMph(windKph);
  AppState.bm.current.wind_deg = windDeg;

  startWindAnim();   // idempotent
  startAnemometer(); // idempotent

  if (el.windLabel) el.windLabel.textContent = `${toMph(windKph)} MPH`;
  if (el.humidity)  el.humidity.textContent  = `${Math.round(rh)}%`;
  if (el.dew)       el.dew.textContent       = `${toF(dewC)}°`;
  if (el.precip)    el.precip.textContent    = precip > 0 ? `${toIn(precip)}"` : '—';

  // Calculate comfort
  const comfort = dewComfortEmoji(toF(dewC));
  AppState.derived.comfortEmoji = comfort;
  AppState.derived.comfortLabel = dewComfortLabel(toF(dewC));
  if (el.comfortEmoji) el.comfortEmoji.textContent = comfort;
  const comfortEl = document.getElementById('now-comfort');
  if (comfortEl) {
    const emoji = AppState.derived.comfortEmoji || '';
    const label = AppState.derived.comfortLabel || '';
    comfortEl.textContent = `${label} ${emoji}`;
  }

  // Feels-like — displayed in NOW panel under temperature
  const feelsC = c.apparent_temperature ?? tempC;
  const feelsF = toF(feelsC);
  const topbarDateEl2 = document.getElementById('topbar-date');
  if (topbarDateEl2) topbarDateEl2.textContent = `${feelsF}°F feels like`;

  const srDt = new Date(d.sunrise[0]);
  const ssDt = new Date(d.sunset[0]);
  AppState.derived.sunTimes     = [srDt, ssDt];
  AppState.derived.cloudPct     = cloud;
  AppState.derived.weatherEmoji = (isNight && wCode === 0) ? '🌙' : w.e;

  /* Build TimeDomain now that daily data is available */
  buildTimeDomain();

  const windyTopEl = document.getElementById('topbar-windy-link');
  if (windyTopEl) windyTopEl.href = `https://www.windy.com/?${CONFIG.lat},${CONFIG.lon},9`;

  const isCurrentlyDay = locNow >= srDt && locNow <= ssDt;
  AppState.view.nowSkyView = 'current';
  if (el.skyBtns) {
    el.skyBtns.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
    const curr = el.skyBtns.querySelector('[data-view="current"]');
    if (curr) curr.classList.add('active');
  }
  if (typeof updateNowSkyButtons === 'function') updateNowSkyButtons(isCurrentlyDay);

  updateSkybowlWindowForView();

  // Skycycle precip total (top-right of skybowl)
  const h = data.hourly;
  const win = AppState.derived.skybowlWindow;
  if (h && win) {
    let totalMm = 0;
    for (let i = 0; i < h.time.length; i++) {
      const t = new Date(h.time[i]);
      if (t >= win.start && t <= win.end) {
        totalMm += h.precipitation[i] || 0;
      }
    }
    const precipEl = document.getElementById('sky-precip');
    if (precipEl) precipEl.innerHTML = `<span class="sky-val">${toIn(totalMm)}"</span><span class="sky-sub">cycle precip</span>`;
  }
  
  // location
  updateSkyLocation();

  requestAnimationFrame(() =>
    drawSkybowl(srDt, ssDt, cloud, AppState.derived.weatherEmoji, data.hourly)
  );
}


/* ============================================================
   CANVAS DPI SETUP HELPER
   ============================================================ */
function setupCanvas(canvas, size = 120) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width  = size + 'px';
  canvas.style.height = size + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

window.addEventListener('resize', () => {
  if (AppState.derived.sunTimes) {
    requestAnimationFrame(() => {
      const [sr, ss] = AppState.derived.sunTimes;
      drawSkybowl(sr, ss,
        AppState.derived.cloudPct,
        AppState.derived.weatherEmoji,
        AppState.bm.hourly);
    });
  }
});


/* ============================================================
   RENDER HOURLY — TimeDomain-driven, fixed-width SVG, no scroll
   ============================================================ */
function renderHourly(data) {
  const h = data.hourly;

  /* ── Use TimeDomain window (Step 3) ── */
  const td = AppState.derived.timeDomain;
  const locNow = nowInTz(CONFIG.tz);

  let windowStart, windowEnd;
  if (td && td.window) {
    windowStart = td.window.start;
    windowEnd   = td.window.end;
  } else {
    /* Fallback: old rolling-window behavior while timeDomain isn't ready */
    const nowH = new Date(locNow);
    nowH.setMinutes(0, 0, 0);
    windowStart = nowH;
    windowEnd   = new Date(nowH.getTime() + 30 * 3600000);
  }

  const times = h.time.map(s => new Date(s));

  /* Select all hourly timestamps within [windowStart, windowEnd].
     Include timestamps in the past (within current cycle). */
  const is7cycle = AppState.view.cycleCount >= 7;
  const indices = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (t < windowStart || t > windowEnd) continue;
    /* In 7-cycle mode, thin to every 3h to keep columns readable */
    if (is7cycle && times[i].getHours() % 3 !== 0) continue;
    indices.push(i);
  }
  const count = indices.length;
  if (count === 0) return;

  const allVals = [];
  for (const i of indices) {
    allVals.push(toF(h.temperature_2m[i]));
    allVals.push(toF(h.dew_point_2m[i]));
  }
  const tMin   = Math.min(...allVals);
  const tMax   = Math.max(...allVals);
  
	const padFrac = 0.08; // 8% padding
    const pad = (tMax - tMin) * padFrac;

    const tMinPadded = tMin - pad;
    const tMaxPadded = tMax + pad;
  const tRange = tMaxPadded - tMinPadded || 1;

  const svgWrap    = document.getElementById('hourly-chart-wrap');
  const containerW = svgWrap ? (svgWrap.clientWidth - 12) : 440;
  const colW  = Math.max(8, Math.floor(containerW / count));
  const svgW  = colW * count;
  const svgH  = 240;
  const plotTop = 22;  // increased from 16 to leave room for top-axis day labels
  const plotBot = svgH - 16;
  const plotH   = plotBot - plotTop;

  const ty = tempF => plotBot - ((tempF - tMin) / tRange) * plotH;
  const tx = k     => k * colW + colW / 2;

  let maxK = 0, minK = 0;
  for (let k = 0; k < indices.length; k++) {
    if (toF(h.temperature_2m[indices[k]]) > toF(h.temperature_2m[indices[maxK]])) maxK = k;
    if (toF(h.temperature_2m[indices[k]]) < toF(h.temperature_2m[indices[minK]])) minK = k;
  }
  let currentK = -1;
  {
    const nowMs = locNow.getTime();
    let bestDist = Infinity;
    for (let k = 0; k < indices.length; k++) {
      const dist = Math.abs(times[indices[k]].getTime() - nowMs);
      if (dist < bestDist) { bestDist = dist; currentK = k; }
    }
  }

  const cs = getComputedStyle(document.body);
  const hotColor    = cs.getPropertyValue('--hot').trim();
  const coldColor   = cs.getPropertyValue('--cold').trim();
  const fg2Color    = cs.getPropertyValue('--fg2').trim();
  const fg3Color    = cs.getPropertyValue('--fg3').trim();
  const fgDimColor  = cs.getPropertyValue('--fg-dim').trim();
  const accentColor = cs.getPropertyValue('--accent').trim();
  const dayBg       = cs.getPropertyValue('--day-bg').trim();
  const nightBg     = cs.getPropertyValue('--night-bg').trim();
  const borderColor = cs.getPropertyValue('--border').trim();

  let svg = '';

  // ── Skybowl sync highlight ──────────────────────────────────
  let sbKStart = -1, sbKEnd = -1, sbHlColor = '#d4900a', sbIsNight = false;
  const sbWin = AppState.derived.skybowlWindow;
  if (sbWin && sbWin.start && sbWin.end) {
    const sbS = new Date(sbWin.start);
    const sbE = new Date(sbWin.end);
    sbS.setMinutes(0, 0, 0);
    sbE.setMinutes(0, 0, 0);
    sbE.setTime(sbE.getTime() + 3600000);
    sbIsNight = sbWin.isNight === true;
    sbHlColor = sbIsNight ? '#4477ee' : '#d4900a';

    for (let k = 0; k < indices.length; k++) {
      const t2 = times[indices[k]];
      if (sbKStart === -1 && t2 >= sbS) sbKStart = k;
      if (t2 < sbE) sbKEnd = k;
    }

    if (sbKStart >= 0 && sbKEnd >= sbKStart) {
      const bx = sbKStart * colW;
      const bw = (sbKEnd - sbKStart + 1) * colW;
      const gid = `sbg_${Date.now()}_${Math.round(Math.random() * 9999)}`;
      svg += `<defs>
        <linearGradient id="${gid}" gradientUnits="objectBoundingBox" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"   stop-color="${sbHlColor}" stop-opacity="0.02"/>
          <stop offset="25%"  stop-color="${sbHlColor}" stop-opacity="0.16"/>
          <stop offset="50%"  stop-color="${sbHlColor}" stop-opacity="0.22"/>
          <stop offset="75%"  stop-color="${sbHlColor}" stop-opacity="0.16"/>
          <stop offset="100%" stop-color="${sbHlColor}" stop-opacity="0.02"/>
        </linearGradient>
      </defs>`;
      svg += `<rect x="${bx}" y="${plotTop}" width="${bw}" height="${plotH}" fill="url(#${gid})" rx="2"/>`;
      const bOpts = `stroke="${sbHlColor}" stroke-linecap="round"`;
      svg += `<line x1="${bx}"      y1="${plotTop}" x2="${bx}"      y2="${plotBot}" ${bOpts} stroke-width="1.5" opacity="0.6"/>`;
      svg += `<line x1="${bx + bw}" y1="${plotTop}" x2="${bx + bw}" y2="${plotBot}" ${bOpts} stroke-width="1.5" opacity="0.6"/>`;
      svg += `<line x1="${bx}" y1="${plotTop}" x2="${bx + bw}" y2="${plotTop}" ${bOpts} stroke-width="1" opacity="0.4" stroke-dasharray="3,2"/>`;
    }
  }

  // Day/night column shading
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    const isDay = h.is_day[i] === 1;
    const x = k * colW;
    svg += `<rect x="${x}" y="${plotTop}" width="${colW}" height="${plotH}" fill="${isDay ? dayBg : nightBg}" opacity="0.35"/>`;
  }

  // Day boundary rules
  let lastDateStr = '';
  for (let k = 0; k < indices.length; k++) {
    const t = times[indices[k]];
    const dateStr = t.toDateString();
    if (dateStr !== lastDateStr && lastDateStr !== '') {
      const x = k * colW;
      svg += `<line x1="${x}" y1="${plotTop}" x2="${x}" y2="${plotBot}" stroke="${borderColor}" stroke-width="1.5" opacity="0.6"/>`;
    }
    lastDateStr = dateStr;
  }

  // 6-hour grid lines
  for (let k = 0; k < indices.length; k++) {
    const hr = times[indices[k]].getHours();
    if (hr % 6 === 0) {
      const x = k * colW;
      svg += `<line x1="${x}" y1="${plotTop}" x2="${x}" y2="${plotBot}" stroke="${borderColor}" stroke-width="0.5" opacity="0.3"/>`;
    }
  }

  // Current time guide
  if (currentK >= 0) {
    const cx2 = currentK * colW;
    svg += `<rect x="${cx2}" y="${plotTop}" width="${colW}" height="${plotH}" fill="${accentColor}" opacity="0.07"/>`;
    svg += `<line x1="${tx(currentK).toFixed(1)}" y1="${plotTop}" x2="${tx(currentK).toFixed(1)}" y2="${plotBot}" stroke="${accentColor}" stroke-width="1" opacity="0.4" stroke-dasharray="3,3"/>`;
  }

  // Dew point polyline
  const dewPts = indices.map((i, k) => `${tx(k).toFixed(1)},${ty(toF(h.dew_point_2m[i])).toFixed(1)}`);
  svg += `<polyline points="${dewPts.join(' ')}" fill="none" stroke="${fgDimColor}" stroke-width="1" opacity="0.5" stroke-linejoin="round" stroke-linecap="round"/>`;

  // Temperature polyline
  const tempPts = indices.map((i, k) => `${tx(k).toFixed(1)},${ty(toF(h.temperature_2m[i])).toFixed(1)}`);
  svg += `<polyline points="${tempPts.join(' ')}" fill="none" stroke="${fg2Color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;

  // Skybowl highlighted segment on temp line
  if (sbKStart >= 0 && sbKEnd >= sbKStart) {
    const kFrom = Math.max(0, sbKStart);
    const kTo   = Math.min(indices.length - 1, sbKEnd);
    const hlPts = [];
    for (let k = kFrom; k <= kTo; k++) {
      hlPts.push(`${tx(k).toFixed(1)},${ty(toF(h.temperature_2m[indices[k]])).toFixed(1)}`);
    }
    if (hlPts.length >= 2) {
      const fid = `sbf_${Date.now()}_${Math.round(Math.random() * 9999)}`;
      svg += `<defs>
        <filter id="${fid}" x="-40%" y="-100%" width="180%" height="300%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="glow"/>
          <feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>`;
      svg += `<polyline points="${hlPts.join(' ')}" fill="none" stroke="${sbHlColor}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round" opacity="0.5" filter="url(#${fid})"/>`;
      svg += `<polyline points="${hlPts.join(' ')}" fill="none" stroke="${sbHlColor}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" opacity="0.95"/>`;
    }
  }

  // Temperature dots
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    const tempF    = toF(h.temperature_2m[i]);
    const x = tx(k), y = ty(tempF);
    const isMax    = (k === maxK);
    const isMin    = (k === minK);
    const isCurrent = (k === currentK);
    const r    = (isMax || isMin) ? 3.5 : (isCurrent ? 3 : 1.5);
    const fill = isMax ? hotColor : (isMin ? coldColor : (isCurrent ? accentColor : fg3Color));

    if (isCurrent) {
      svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${fill}">
        <animate attributeName="opacity" values="1;0.4;1" dur="1.8s" repeatCount="indefinite"/>
      </circle>`;
      if (!isMax && !isMin) {
        svg += `<text x="${x.toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle" font-size="${colW > 14 ? 10 : 7}" fill="${accentColor}" font-weight="bold" font-family="monospace">${tempF}°</text>`;
      }
    } else {
      svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${fill}"/>`;
    }
    /* Global max/min text labels are now rendered by the per-cycle extrema block below */
  }

  // ── Per-skycycle temperature extreme labels ──
  // Group hourly points by TimeDomain cycle, not by calendar day.
  // In 3-cycle view: bold the overall highest max and lowest min across cycles.
  // In 7-cycle view: all labels uniform (no bolding differences).
  {
    const tdCycles = (AppState.derived.timeDomain && AppState.derived.timeDomain.cycles) || [];
    const is3cycle = !is7cycle; // is7cycle already defined above
    const cycleExtrFontSz = colW > 14 ? 12 : 10;
    const baseFontSz      = colW > 14 ? 14 : 12;

    // Collect per-cycle extrema: {maxEntry, minEntry} per cycle
    const cycleExtrema = [];
    for (const cycle of tdCycles) {
      const entries = [];
      for (let k = 0; k < indices.length; k++) {
        const t = times[indices[k]];
        if (t >= cycle.start && t < cycle.end) {
          entries.push({ k, tempF: toF(h.temperature_2m[indices[k]]) });
        }
      }
      if (entries.length < 2) continue; // skip cycles with insufficient data
      let maxEntry = entries[0], minEntry = entries[0];
      for (const e of entries) {
        if (e.tempF > maxEntry.tempF) maxEntry = e;
        if (e.tempF < minEntry.tempF) minEntry = e;
      }
      cycleExtrema.push({ maxEntry, minEntry });
    }

    // In 3-cycle view, find global high and low across cycles for bolding
    let globalCycleMaxTemp = -Infinity, globalCycleMinTemp = Infinity;
    if (is3cycle) {
      for (const { maxEntry, minEntry } of cycleExtrema) {
        if (maxEntry.tempF > globalCycleMaxTemp) globalCycleMaxTemp = maxEntry.tempF;
        if (minEntry.tempF < globalCycleMinTemp) globalCycleMinTemp = minEntry.tempF;
      }
    }

    for (const { maxEntry, minEntry } of cycleExtrema) {
      // Max label
      {
        const x = tx(maxEntry.k);
        const y = ty(maxEntry.tempF);
        const isBold   = is3cycle && maxEntry.tempF === globalCycleMaxTemp;
        const fontSize = isBold ? baseFontSz : cycleExtrFontSz;
        const opacity  = isBold ? '1' : '0.75';
        const fw       = isBold ? 'bold' : 'normal';
        svg += `<text x="${x.toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle" font-size="${fontSize}" fill="${hotColor}" font-weight="${fw}" font-family="monospace" opacity="${opacity}">${maxEntry.tempF}°</text>`;
      }
      // Min label
      {
        const x = tx(minEntry.k);
        const y = ty(minEntry.tempF);
        const isBold   = is3cycle && minEntry.tempF === globalCycleMinTemp;
        const fontSize = isBold ? baseFontSz : cycleExtrFontSz;
        const opacity  = isBold ? '1' : '0.75';
        const fw       = isBold ? 'bold' : 'normal';
        svg += `<text x="${x.toFixed(1)}" y="${(y + 13).toFixed(1)}" text-anchor="middle" font-size="${fontSize}" fill="${coldColor}" font-weight="${fw}" font-family="monospace" opacity="${opacity}">${minEntry.tempF}°</text>`;
      }
    }
  }

  // Time axis labels (24h) — bottom axis: only midnight (00) and noon (12)
  for (let k = 0; k < indices.length; k++) {
    const hr = times[indices[k]].getHours();
    if (hr !== 0 && hr !== 12) continue;
    const x = tx(k);
    const label = hr === 0 ? '00' : '12';
    svg += `<text x="${x.toFixed(1)}" y="${(svgH - 2).toFixed(1)}" text-anchor="middle" font-size="${colW > 14 ? 7 : 6}" fill="${fgDimColor}" font-family="monospace" opacity="0.55">${label}</text>`;
  }

  svg += `
  <text x="6" y="${plotTop + 10}"
        font-size="10"
        fill="${fgDimColor}">
    °F
  </text>
`;

  // ── Day labels — top axis, one per calendar day, centered on each day segment ──
  {
    // Group columns by calendar date
    const dayGroups = new Map(); // dateStr → array of k indices
    for (let k = 0; k < indices.length; k++) {
      const t = times[indices[k]];
      const dateStr = t.toLocaleDateString('en-CA', { timeZone: CONFIG.tz });
      if (!dayGroups.has(dateStr)) dayGroups.set(dateStr, []);
      dayGroups.get(dateStr).push(k);
    }
    const dayLabelY = plotTop - 3;  // just above plot area
    for (const [dateStr, ks] of dayGroups) {
      const midK  = (ks[0] + ks[ks.length - 1]) / 2;
      const midX  = tx(midK);
      // Short weekday name, optionally with M/D if there's room
      const d = new Date(dateStr + 'T12:00:00');
      const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
      const md = `${d.getMonth() + 1}/${d.getDate()}`;
      const spanPx = (ks.length) * colW;
      const label  = spanPx >= 48 ? `${weekday} ${md}` : weekday;
      svg += `<text x="${midX.toFixed(1)}" y="${dayLabelY.toFixed(1)}" text-anchor="middle" font-size="${colW > 10 ? 11 : 9}" fill="${fg3Color}" font-family="monospace" letter-spacing="0.5">${label}</text>`;
    }
  }

  /* ── TimeDomain "now" marker — crosshair (vertical + horizontal) ── */
  if (td && td.window) {
    const nowFrac = (td.now.getTime() - td.window.start.getTime())
                  / (td.window.end.getTime() - td.window.start.getTime());
    if (nowFrac >= 0 && nowFrac <= 1) {
      const nx = (nowFrac * svgW).toFixed(1);
      /* Vertical line */
      svg += `<line id="td-now-marker" x1="${nx}" y1="${plotTop}" x2="${nx}" y2="${plotBot}" stroke="${accentColor}" stroke-width="1.5" opacity="0.85" stroke-dasharray="none"/>`;
      svg += `<line x1="${nx}" y1="${plotTop}" x2="${nx}" y2="${plotBot}" stroke="${accentColor}" stroke-width="5" opacity="0.08"/>`;
      svg += `<text x="${parseFloat(nx) + 3}" y="${plotTop + 9}" font-size="7" fill="${accentColor}" font-family="monospace" opacity="0.75">NOW</text>`;
      /* Horizontal line at current temp — completes the crosshair */
      if (currentK >= 0) {
        const nowTempY = ty(toF(h.temperature_2m[indices[currentK]])).toFixed(1);
        svg += `<line x1="0" y1="${nowTempY}" x2="${svgW}" y2="${nowTempY}" stroke="${accentColor}" stroke-width="1" opacity="0.45" stroke-dasharray="4,3"/>`;
      }
    } else {
      svg += `<line id="td-now-marker" x1="0" y1="${plotTop}" x2="0" y2="${plotBot}" stroke="${accentColor}" stroke-width="1.5" opacity="0.85" style="display:none"/>`;
    }
  }

  const svgEl = document.getElementById('hourly-svg');
  if (!svgEl) return;
  svgEl.setAttribute('width', svgW);
  svgEl.setAttribute('height', svgH);
  svgEl.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);
  svgEl.innerHTML = svg;

  // Wind row — magnitude as typography: stepped font size + glyph by speed band
  const windRow = document.getElementById('hourly-wind-row');
  if (windRow) {
    windRow.innerHTML = '';
    for (let k = 0; k < indices.length; k++) {
      const i    = indices[k];
      const wind = toMph(h.wind_speed_10m[i]);
      const wd   = windDir(h.wind_direction_10m[i]);
      const isCurrent = (k === currentK);
      const cell = document.createElement('div');
      cell.className = 'hw-cell' + (isCurrent ? ' hw-current' : '');

      // Stepped wind bands
      let arrowGlyph, arrowSize, numSize, cellOpacity;
      if (wind <= 3) {
        arrowGlyph = wd.arrow; arrowSize = '0.50rem'; numSize = '0.38rem'; cellOpacity = '0.4';
      } else if (wind <= 9) {
        arrowGlyph = wd.arrow; arrowSize = '0.70rem'; numSize = '0.45rem'; cellOpacity = '0.65';
      } else if (wind <= 19) {
        arrowGlyph = wd.arrow; arrowSize = '0.90rem'; numSize = '0.55rem'; cellOpacity = '0.85';
      } else {
        arrowGlyph = '⇒'; arrowSize = '1.05rem'; numSize = '0.62rem'; cellOpacity = '1.0';
      }

      cell.style.opacity = cellOpacity;
      cell.innerHTML = `<span style="font-size:${arrowSize};line-height:1">${arrowGlyph}</span><span style="font-size:${numSize};color:${fg3Color}">${wind}</span>`;
      windRow.appendChild(cell);
    }
  }

  setupHourlyTooltip(svgEl, indices, times, h, svgW, svgH, plotTop, plotBot, colW, data);
}


/* ── Hourly tooltip — expanded with all new fields + ECMWF rows ── */
function setupHourlyTooltip(svgEl, indices, times, h, svgW, svgH, plotTop, plotBot, colW, data) {
  const tooltip = document.getElementById('hourly-tooltip');
  if (!tooltip) return;
  const wrap = document.getElementById('hourly-chart-wrap');
  if (!wrap) return;

  const newSvg = svgEl.cloneNode(true);
  svgEl.parentNode.replaceChild(newSvg, svgEl);
  const svgEl2 = document.getElementById('hourly-svg');
  if (!svgEl2) return;

  // Build ECMWF timestamp→index map (match by timestamp string, not array index)
  const ecmwfMap = new Map();
  if (AppState.ecmwf && AppState.ecmwf.time) {
    AppState.ecmwf.time.forEach((t, i) => ecmwfMap.set(t, i));
  }

  function getClosestK(clientX) {
    const rect = svgEl2.getBoundingClientRect();
    if (rect.width === 0) return 0;
    const relX = (clientX - rect.left) * (svgW / rect.width);
    const k = Math.floor(relX / colW);
    return Math.max(0, Math.min(indices.length - 1, k));
  }

  function fmt24h(dt) {
    return dt.toLocaleTimeString('en-GB', {
      timeZone: CONFIG.tz, hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }

  function positionTooltip(clientX) {
    const wrapRect = wrap.getBoundingClientRect();
    const ttW = tooltip.offsetWidth || 160;
    let left = clientX - wrapRect.left - ttW / 2;
    left = Math.max(4, Math.min(wrapRect.width - ttW - 4, left));
    tooltip.style.left      = left + 'px';
    tooltip.style.transform = 'none';
    tooltip.style.top       = '0px';
  }

  function showTooltip(k, clientX) {
    const i       = indices[k];
    const t       = times[i];
    const tempF   = toF(h.temperature_2m[i]);
    const dewF    = toF(h.dew_point_2m[i]);
    const wInfo   = wmo(h.weather_code[i]);
    const feelF   = toF(h.apparent_temperature?.[i] ?? h.temperature_2m[i]);
    const rh      = Math.round(h.relative_humidity_2m?.[i] ?? 0);
    const wind    = toMph(h.wind_speed_10m[i]);
    const gusts   = h.wind_gusts_10m?.[i] != null ? toMph(h.wind_gusts_10m[i]) : null;
    const wd      = windDir(h.wind_direction_10m[i]);
    const precip  = h.precipitation?.[i] ?? 0;
    const precipP = h.precipitation_probability?.[i] ?? null;
    const uv      = Math.round(h.uv_index?.[i] ?? 0);
    const cloud   = Math.round(h.cloud_cover?.[i] ?? 0);
    const snow    = h.snowfall?.[i] ?? 0;
    const visMi   = h.visibility?.[i] != null ? toMi(h.visibility[i]) : null;

    const sunTimes = AppState.derived.sunTimes;
    const isNight  = sunTimes && (t < sunTimes[0] || t > sunTimes[1]);
    const emoji    = (isNight && h.weather_code[i] === 0) ? '🌙' : wInfo.e;

    // ECMWF comparison — match by timestamp string
    let ecmwfRow = '';
    if (AppState.ecmwf) {
      const bmTimeStr = h.time[i];   // e.g. "2026-04-26T14:00"
      const ecIdx = ecmwfMap.get(bmTimeStr);
      if (ecIdx !== undefined && AppState.ecmwf.temperature_2m?.[ecIdx] != null) {
        const ecTempF = toF(AppState.ecmwf.temperature_2m[ecIdx]);
        const delta   = ecTempF - tempF;
        const sign    = delta >= 0 ? '+' : '';
        const dColor  = delta > 0 ? 'var(--hot)' : (delta < 0 ? 'var(--cold)' : 'var(--fg2)');
        ecmwfRow = `
          <div style="margin-top:3px;border-top:1px solid var(--border);padding-top:3px;">
          <div class="tt-row"><span class="tt-label">ECMWF temp</span><span class="tt-val">${ecTempF}°F</span></div>
          <div class="tt-row"><span class="tt-label">ECMWF Δ</span><span class="tt-val" style="color:${dColor}">${sign}${delta}°F</span></div>
          </div>`;
      }
    }

    const gustStr    = gusts != null ? ` (gusts ${gusts} mph)` : '';
    const precipStr  = precip > 0
      ? `${toIn(precip)}"${precipP != null ? ` (${precipP}% chance)` : ''}`
      : (precipP != null ? `— (${precipP}% chance)` : '—');

    tooltip.innerHTML = `
      <span class="tt-time">${fmt24h(t)}</span>
      <div class="tt-cond">${emoji} ${wInfo.d}</div>
      <hr style="border:none;border-top:1px solid var(--border);margin:3px 0;">
      <div class="tt-row"><span class="tt-label">temp</span><span class="tt-val">${tempF}°F / feels ${feelF}°F</span></div>
      <div class="tt-row"><span class="tt-label">dew / RH</span><span class="tt-val">${dewF}°F / ${rh}%</span></div>
      <div class="tt-row"><span class="tt-label">wind</span><span class="tt-val">${wd.arrow} ${wind} mph${gustStr}</span></div>
      <div class="tt-row"><span class="tt-label">precip</span><span class="tt-val">${precipStr}</span></div>
      ${(!isNight && uv > 0) ? `<div class="tt-row"><span class="tt-label">UV</span><span class="tt-val">${uv}</span></div>` : ''}
      <div class="tt-row"><span class="tt-label">cloud</span><span class="tt-val">${cloud}%</span></div>
      ${visMi != null ? `<div class="tt-row"><span class="tt-label">visibility</span><span class="tt-val">${visMi} mi</span></div>` : ''}
      ${snow > 0 ? `<div class="tt-row"><span class="tt-label">snow</span><span class="tt-val">${toIn(snow * 10)}"</span></div>` : ''}
      ${ecmwfRow}
    `;
    tooltip.style.display = 'block';
    requestAnimationFrame(() => positionTooltip(clientX));
  }

  function hideTooltip() {
    tooltip.style.display = 'none';
    tooltip.style.transform = 'translateX(-50%)';
  }

  svgEl2.addEventListener('mousemove',  e => showTooltip(getClosestK(e.clientX), e.clientX));
  svgEl2.addEventListener('mouseleave', hideTooltip);

  const touchTargets = [svgEl2];
  const windRowEl = document.getElementById('hourly-wind-row');
  if (windRowEl) touchTargets.push(windRowEl);

  touchTargets.forEach(el => {
    el.addEventListener('touchstart', e => {
      e.preventDefault();
      showTooltip(getClosestK(e.touches[0].clientX), e.touches[0].clientX);
    }, { passive: false });
    el.addEventListener('touchmove', e => {
      e.preventDefault();
      showTooltip(getClosestK(e.touches[0].clientX), e.touches[0].clientX);
    }, { passive: false });
    el.addEventListener('touchend',   () => setTimeout(hideTooltip, 800));
    el.addEventListener('touchcancel', hideTooltip);
  });
}


/* ============================================================
   RENDER DAILY
   ============================================================ */
function renderDaily(data) {
  const d = data.daily;
  const n = Math.min(AppState.view.dailyDays, d.time.length);
  const locNowDaily = nowInTz(CONFIG.tz);
  const todayStr = locNowDaily.toLocaleDateString('en-CA', { timeZone: CONFIG.tz });

  const iconsRow  = document.getElementById('daily-icons-row');
  iconsRow.innerHTML = '';
  const precipRow = document.getElementById('daily-precip-row');
  precipRow.innerHTML = '';

  // Remove any prior tooltip overlay
  const existingOverlay = document.getElementById('daily-overlay-wrap');
  if (existingOverlay) existingOverlay.remove();

  const allTemps = [
    ...d.temperature_2m_max.slice(0, n),
    ...d.temperature_2m_min.slice(0, n),
  ];
  const tMin = Math.min(...allTemps);
  const tMax = Math.max(...allTemps);

  const nowTempC = data.current?.temperature_2m ?? 0;
  const nowTempF = toF(nowTempC);

  const svgEl = document.getElementById('daily-svg');
  const W = svgEl.parentElement.clientWidth - 20 || 340;
  const H = 200;
  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svgEl.setAttribute('width', W);
  svgEl.setAttribute('height', H);

  const colW = W / n;
  const pad  = 16;
  const t2y  = t => H - pad - ((toF(t) - toF(tMin)) / (toF(tMax) - toF(tMin))) * (H - 2 * pad);
  const nowY = t2y(nowTempC);

  const cs = getComputedStyle(document.body);
  const hotColor    = cs.getPropertyValue('--hot').trim();
  const coldColor   = cs.getPropertyValue('--cold').trim();
  const accentColor = cs.getPropertyValue('--accent').trim();

  let maxPts = [], minPts = [];
  for (let i = 0; i < n; i++) {
    const cx = colW * i + colW / 2;
    maxPts.push({ x: cx, y: t2y(d.temperature_2m_max[i]) });
    minPts.push({ x: cx, y: t2y(d.temperature_2m_min[i]) });
  }

  let svg = '<defs>';
  const mkClip = (id, y0, y1) =>
    `<clipPath id="${id}"><rect x="0" y="${y0}" width="${W}" height="${y1 - y0}"/></clipPath>`;
  svg += mkClip('clip-hot',  0,    nowY);
  svg += mkClip('clip-cold', nowY, H);
  svg += '</defs>';

  // ── TimeDomain gradient highlight on WEEKLY (Step 4) ─────────
  const td = AppState.derived.timeDomain;
  if (td && td.window) {
    const winStartMs = td.window.start.getTime();
    const winEndMs   = td.window.end.getTime();
    const winLenMs   = winEndMs - winStartMs;
    const nowMs      = td.now.getTime();

    for (let i = 0; i < n; i++) {
      const dayStr    = d.time[i];
      const dayStartMs = new Date(dayStr + 'T00:00:00').getTime();
      const dayEndMs   = dayStartMs + 86400000;

      const overlapStart = Math.max(dayStartMs, winStartMs);
      const overlapEnd   = Math.min(dayEndMs, winEndMs);
      if (overlapEnd <= overlapStart) continue;

      const midMs    = (overlapStart + overlapEnd) / 2;
      const dist     = Math.abs(midMs - nowMs);
      const intensity = Math.max(0, Math.min(1, 1 - dist / winLenMs));
      if (intensity <= 0) continue;

      const x = colW * i;
      svg += `<rect x="${x}" y="0" width="${colW}" height="${H}" fill="${hotColor}" fill-opacity="${(intensity * 0.22).toFixed(3)}" rx="1"/>`;
    }
  } else {
    /* Fallback: plain today highlight (original behavior) */
    for (let i = 0; i < n; i++) {
      if (d.time[i] === todayStr) {
        svg += `<rect x="${colW * i}" y="0" width="${colW}" height="${H}" fill="${accentColor}" fill-opacity="0.07"/>`;
      }
    }
  }

  const polyPts = (tops, bots) =>
    [...tops, ...[...bots].reverse()]
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ' Z';
  const poly = polyPts(maxPts, minPts);
  svg += `<path d="${poly}" fill="${hotColor}"  fill-opacity="0.28" clip-path="url(#clip-hot)"/>`;
  svg += `<path d="${poly}" fill="${coldColor}" fill-opacity="0.28" clip-path="url(#clip-cold)"/>`;
  svg += `<polyline points="${maxPts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="${hotColor}"  stroke-width="2" stroke-linejoin="round"/>`;
  svg += `<polyline points="${minPts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="${coldColor}" stroke-width="2" stroke-linejoin="round"/>`;
  svg += `<line x1="0" y1="${nowY.toFixed(1)}" x2="${W}" y2="${nowY.toFixed(1)}" stroke="${accentColor}" stroke-width="1" stroke-dasharray="4,3" opacity="0.7"/>`;

  for (let i = 0; i < n; i++) {
    const cx    = colW * i + colW / 2;
    const mx    = maxPts[i];
    const mn    = minPts[i];
    const maxF  = toF(d.temperature_2m_max[i]);
    const minF  = toF(d.temperature_2m_min[i]);
    svg += `<text x="${cx}" y="${Math.max(12, mx.y - 4)}" text-anchor="middle" font-size="9" fill="${hotColor}"  font-family="monospace">${maxF}°</text>`;
    svg += `<text x="${cx}" y="${Math.min(H - 2, mn.y + 11)}" text-anchor="middle" font-size="9" fill="${coldColor}" font-family="monospace">${minF}°</text>`;

    const avgF = (maxF + minF) / 2;
    const diff = avgF - nowTempF;
    if (Math.abs(diff) >= 5) {
      const emoji = diff > 0 ? '🔥' : '🥶';
      const ey    = diff > 0 ? Math.max(22, mx.y - 16) : Math.min(H - 12, mn.y + 20);
      svg += `<text x="${cx}" y="${ey}" text-anchor="middle" font-size="11">${emoji}</text>`;
    }
  }

  const todayIdx = d.time.slice(0, n).indexOf(todayStr);
  if (todayIdx >= 0) {
    const cx = colW * todayIdx + colW / 2;
    const pScale = getPulseScale();
    const pAlpha = getPulseAlpha();
    const pIntensity = getPulseIntensity();
    const pColor = getPulseColor();
    const dotR = 4 * pScale;
    const glowR = dotR + 6 * pIntensity;
    /* Glow halo ring */
    svg += `<circle id="weekly-pulse-halo" cx="${cx}" cy="${nowY.toFixed(1)}" r="${glowR.toFixed(2)}" fill="${pColor}" opacity="${(0.08 + 0.18 * pIntensity).toFixed(3)}"/>`;
    /* Outer ring */
    svg += `<circle id="weekly-pulse-ring" cx="${cx}" cy="${nowY.toFixed(1)}" r="${(dotR + 2).toFixed(2)}" fill="none" stroke="${pColor}" stroke-width="1.2" opacity="${(0.3 + 0.5 * pIntensity).toFixed(3)}"/>`;
    /* Core dot */
    svg += `<circle id="weekly-pulse-core" cx="${cx}" cy="${nowY.toFixed(1)}" r="${dotR.toFixed(2)}" fill="${pColor}" opacity="${pAlpha.toFixed(3)}"/>`;
  }
  svgEl.innerHTML = svg;

  /* Start lightweight rAF loop to animate just the weekly pulse dot */
  _startWeeklyPulseLoop();

  const nowLabelEl = document.getElementById('daily-now-label');
  if (nowLabelEl) nowLabelEl.style.top = `${(nowY / H) * 100}%`;

  for (let i = 0; i < n; i++) {
    const isToday = d.time[i] === todayStr;
    const isWknd  = [0, 6].includes(new Date(d.time[i] + 'T12:00:00').getDay());
    const wInfo   = wmo(d.weather_code[i]);

    const ic = document.createElement('div');
    ic.style.cssText = 'flex:1;text-align:center;font-size:0.7rem;';
    ic.innerHTML = `
      <div style="font-family:var(--font-display);font-size:0.75rem;color:${isToday ? 'var(--accent)' : (isWknd ? 'var(--hot)' : 'var(--fg3)')};${isWknd ? 'font-weight:bold' : ''}">
        ${fmtDay(d.time[i])}<br><span style="font-size:0.6rem;color:var(--fg-dim)">${fmtMD(d.time[i])}</span>
      </div>
      <div style="font-size:1.1rem">${wInfo.e}</div>
    `;
    iconsRow.appendChild(ic);

    const pc = document.createElement('div');
    pc.style.cssText = `flex:1;text-align:center;font-size:0.65rem;color:${d.precipitation_sum[i] > 0 ? 'var(--precip)' : 'var(--fg-dim)'};`;
    pc.textContent = d.precipitation_sum[i] > 0 ? `${toIn(d.precipitation_sum[i])}"` : '·';
    precipRow.appendChild(pc);
  }

  // ── Daily tooltip overlay ────────────────────────────────────
  setupDailyTooltip(n, d, colW, todayStr, data);
}


/* ── Weekly pulse loop — updates now-dot without full SVG rebuild ── */
let _weeklyPulseRaf = null;
function _weeklyPulseFrame() {
  const halo = document.getElementById('weekly-pulse-halo');
  const ring = document.getElementById('weekly-pulse-ring');
  const core = document.getElementById('weekly-pulse-core');
  if (!halo || !ring || !core) { _weeklyPulseRaf = null; return; }

  const pI = getPulseIntensity();
  const pS = getPulseScale();
  const pA = getPulseAlpha();
  const pC = getPulseColor();
  const baseR = 4;
  const dotR  = baseR * pS;
  const glowR = dotR + 6 * pI;

  halo.setAttribute('r',       glowR.toFixed(2));
  halo.setAttribute('fill',    pC);
  halo.setAttribute('opacity', (0.08 + 0.18 * pI).toFixed(3));

  ring.setAttribute('r',       (dotR + 2).toFixed(2));
  ring.setAttribute('stroke',  pC);
  ring.setAttribute('opacity', (0.3 + 0.5 * pI).toFixed(3));

  core.setAttribute('r',       dotR.toFixed(2));
  core.setAttribute('fill',    pC);
  core.setAttribute('opacity', pA.toFixed(3));

  _weeklyPulseRaf = requestAnimationFrame(_weeklyPulseFrame);
}
function _startWeeklyPulseLoop() {
  if (_weeklyPulseRaf) cancelAnimationFrame(_weeklyPulseRaf);
  _weeklyPulseRaf = requestAnimationFrame(_weeklyPulseFrame);
}


/* ── Daily (WEEKLY) tooltip — transparent overlay columns ── */
function setupDailyTooltip(n, d, colW, todayStr, data) {
  const panelContent = document.getElementById('daily-panel-content');
  if (!panelContent) return;

  // Tooltip element (reuse hourly-tooltip style)
  let tooltip = document.getElementById('daily-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'daily-tooltip';
    // Share same class as hourly-tooltip for styling
    tooltip.setAttribute('style', [
      'position:absolute',
      'display:none',
      'background:var(--panel)',
      'border:1px solid var(--border-hl)',
      'border-radius:var(--radius)',
      'padding:6px 10px',
      'font-family:var(--font-mono)',
      'font-size:0.68rem',
      'color:var(--fg2)',
      'z-index:200',
      'pointer-events:none',
      'box-shadow:0 4px 16px rgba(0,0,0,0.35)',
      'min-width:140px',
      'line-height:1.65',
      'white-space:nowrap',
    ].join(';'));
    panelContent.style.position = 'relative';
    panelContent.appendChild(tooltip);
  }

  // Build overlay container
  const overlay = document.createElement('div');
  overlay.id = 'daily-overlay-wrap';
  overlay.style.cssText = [
    'position:absolute',
    'top:0','left:0','right:0','bottom:0',
    'display:flex',
    'pointer-events:none',
  ].join(';');
  panelContent.appendChild(overlay);

  function fmtSunshine(sec) {
    if (!sec || sec <= 0) return null;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h === 0 && m === 0) return null;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function showDailyTooltip(i, el) {
    const maxF   = toF(d.temperature_2m_max[i]);
    const minF   = toF(d.temperature_2m_min[i]);
    const precip = d.precipitation_sum?.[i] ?? 0;
    const precipP = d.precipitation_probability_max?.[i] ?? null;
    const wInfo  = wmo(d.weather_code[i]);
    const dayName = fmtDay(d.time[i]);
    const dateStr = fmtMD(d.time[i]);
    const snowMm  = 0;  // daily snowfall_sum not fetched; omit
    const sunshine = fmtSunshine(d.sunshine_duration?.[i]);

    const precipStr = precip > 0
      ? `${toIn(precip)}"${precipP != null ? ` (${precipP}% chance)` : ''}`
      : (precipP != null ? `— (${precipP}% chance)` : '—');

    tooltip.innerHTML = `
      <span style="font-family:var(--font-display);font-size:1.0rem;color:var(--accent);display:block;margin-bottom:3px;letter-spacing:0.05em">${dayName} ${dateStr}</span>
      <div style="margin-bottom:2px">${wInfo.e} ${wInfo.d}</div>
      <hr style="border:none;border-top:1px solid var(--border);margin:3px 0;">
      <div class="tt-row"><span class="tt-label">high / low</span><span class="tt-val">${maxF}°F / ${minF}°F</span></div>
      <div class="tt-row"><span class="tt-label">precip</span><span class="tt-val">${precipStr}</span></div>
      ${sunshine ? `<div class="tt-row"><span class="tt-label">sunshine</span><span class="tt-val">${sunshine}</span></div>` : ''}
    `;
    tooltip.style.display = 'block';

    // Position: left-aligned to column, clamped to panel
    const panelRect = panelContent.getBoundingClientRect();
    const elRect    = el.getBoundingClientRect();
    const ttW       = tooltip.offsetWidth || 160;
    let left = elRect.left - panelRect.left;
    left = Math.max(4, Math.min(panelRect.width - ttW - 4, left));
    tooltip.style.left = left + 'px';
    tooltip.style.top  = '0px';
  }

  function hideDailyTooltip() {
    tooltip.style.display = 'none';
  }

  // Create one hit-target div per day column
  for (let i = 0; i < n; i++) {
    const col = document.createElement('div');
    col.style.cssText = [
      `flex:1`,
      'cursor:pointer',
      'pointer-events:auto',
      'position:relative',
    ].join(';');

    col.addEventListener('mouseenter', () => showDailyTooltip(i, col));
    col.addEventListener('mouseleave', hideDailyTooltip);
    col.addEventListener('touchstart', e => {
      e.preventDefault();
      showDailyTooltip(i, col);
    }, { passive: false });
    col.addEventListener('touchend', () => setTimeout(hideDailyTooltip, 1200));

    overlay.appendChild(col);
  }
}


/* ============================================================
   METADATA
   ============================================================ */
function updateMeta(fetchTime) {
  // Kept for compatibility
}


/* ============================================================
   MAIN LOAD + REFRESH
   ============================================================ */
let lastFetch = null;

async function load() {
  try {
    const data = await fetchWeather();
    lastFetch = new Date();

    document.getElementById('loading').style.display = 'none';
    document.getElementById('error-msg').style.display = 'none';
    ['sky-section', 'forecast-section', 'weekly-section'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('is-hidden');
    });

    renderSky(data);
    renderHourly(data);
    renderDaily(data);
    updateMeta(lastFetch);

    const fetchedTime = lastFetch.toLocaleTimeString('en-GB', {
      timeZone: CONFIG.tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const fetchedEl = document.getElementById('footer-fetched-time');
    if (fetchedEl) fetchedEl.textContent = fetchedTime;
  } catch (err) {
    document.getElementById('loading').style.display = 'none';
    const em = document.getElementById('error-msg');
    em.style.display = '';
    em.textContent = `⚠ ${err.message}`;
    console.error(err);
  }
}

function scheduleRefresh() {
  const now = new Date();
  const m = now.getMinutes(), s = now.getSeconds();
  const offsets = [1, 16, 31, 46];
  let nextMin = offsets.find(x => x > m) ?? (offsets[0] + 60);
  const waitMs = ((nextMin - m) * 60 - s) * 1000;

  const nextRefreshEl = document.getElementById('next-refresh-time');
  if (nextRefreshEl) {
    const nextTime = new Date(now.getTime() + waitMs);
    nextRefreshEl.textContent = nextTime.toLocaleTimeString('en-GB', {
      timeZone: CONFIG.tz, hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }
  setTimeout(() => { load(); scheduleRefresh(); }, waitMs);
}

setInterval(() => { if (lastFetch) updateMeta(lastFetch); }, 30000);


/* ============================================================
   LOCATION HELPERS
   ============================================================ */
let _locationElev = null;
let _locationPop  = null;

function fmtPop(n) {
  if (!n || n <= 0) return null;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function updateSkyLocation() {
  const el = document.getElementById('sky-location');
  if (!el) return;

  const name = (CONFIG.label || '').split(',')[0].toUpperCase();

  /*el.innerHTML = `
    <div style="font-size:24px; letter-spacing:1px;">${name}</div>
    <div style="font-size:8px; opacity:0.6;">
      <a href="https://www.windy.com/?${CONFIG.lat},${CONFIG.lon},9" target="_blank">[ ↗ windy.com] ]</a>
    </div>
  `;*/
  el.innerHTML = `
    <div style="font-size:18px; letter-spacing:1px;">${name}</div>
    </div>
  `;
}

function updateLocationCoords() {
  const lat = CONFIG.lat, lon = CONFIG.lon;
  const latStr = Math.abs(lat).toFixed(4) + '°' + (lat >= 0 ? 'N' : 'S');
  const lonStr = Math.abs(lon).toFixed(4) + '°' + (lon >= 0 ? 'E' : 'W');
  const el = document.getElementById('location-coords');
  if (el) el.textContent = latStr + '  ' + lonStr;
}

function updateLocationElevPop() {
  const el = document.getElementById('location-elev-pop');
  if (!el) return;
  const parts = [];
  if (_locationElev != null) parts.push(Math.round(_locationElev * 3.28084).toLocaleString() + ' ft');
  if (_locationPop  != null) { const p = fmtPop(_locationPop); if (p) parts.push('pop. ' + p); }
  el.textContent = parts.length ? parts.join(' · ') : '—';
}

function updateKoppen() {
  const el = document.getElementById('location-koppen');
  if (!el) return;
  if (!window.KOPPEN_READY) { el.textContent = '—'; return; }
  const result = window.koppenLookup(CONFIG.lat, CONFIG.lon);
  el.textContent = result ? result.symbol + ' · ' + result.label : '—';
}

function updateWindyLink() {
  const el = document.getElementById('location-windy');
  if (el) el.href = `https://www.windy.com/?${CONFIG.lat},${CONFIG.lon},9`;
  const tb = document.getElementById('topbar-windy-link');
  if (tb) tb.href = `https://www.windy.com/?${CONFIG.lat},${CONFIG.lon},9`;
}

function updateHerePanel() {
  updateLocationCoords();
  updateLocationElevPop();
  updateKoppen();
  updateWindyLink();
}

window.addEventListener('koppenready', () => {
  updateKoppen();
  updateLocationElevPop();
}, { once: true });

(function fetchInitialElevPop() {
  const name = CONFIG.label ? CONFIG.label.replace(/,.*/, '').trim() : '';
  if (!name) return;
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5&language=en&format=json`;
  fetch(url).then(r => r.ok ? r.json() : null).then(data => {
    if (!data) return;
    const results = data.results || [];
    let best = null, bestDist = Infinity;
    for (const r of results) {
      const dlat = r.latitude  - CONFIG.lat;
      const dlon = r.longitude - CONFIG.lon;
      const dist = dlat * dlat + dlon * dlon;
      if (dist < bestDist) { bestDist = dist; best = r; }
    }
    if (best) {
      _locationElev = best.elevation  ?? null;
      _locationPop  = best.population ?? null;
      updateLocationElevPop();
    }
  }).catch(() => {});
})();


/* ============================================================
   GEOCODING SEARCH
   ============================================================ */
(function () {
  const searchEl  = document.getElementById('location-search');
  const suggestEl = document.getElementById('location-suggest');
  const selectEl  = document.getElementById('location-select');

  let _debounceTimer  = null;
  let _currentResults = [];
  let _activeIdx      = -1;

  function closeSuggest() {
    suggestEl.classList.remove('open');
    suggestEl.innerHTML = '';
    _currentResults = [];
    _activeIdx = -1;
  }

  function applyResult(r) {
    CONFIG.lat   = r.latitude;
    CONFIG.lon   = r.longitude;
    CONFIG.tz    = r.timezone || 'UTC';
    CONFIG.label = r.name;
    AppState.config = CONFIG;

    _locationElev = r.elevation  ?? null;
    _locationPop  = r.population ?? null;

    const val    = `${r.latitude},${r.longitude},${r.timezone || 'UTC'}`;
    const admin  = r.admin1       ? `, ${r.admin1}` : '';
    const country = r.country_code ? ` · ${r.country_code.toUpperCase()}` : '';
    const label  = r.name + admin + country;

    let existing = selectEl.querySelector(`option[value="${val}"]`);
    if (!existing) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      opt.setAttribute('data-searched', '1');
      const firstSearched = selectEl.querySelector('option[data-searched]');
      if (firstSearched) selectEl.insertBefore(opt, firstSearched);
      else selectEl.appendChild(opt);
      existing = opt;
    }
    selectEl.value = val;
    searchEl.value = '';
    closeSuggest();
    updateHerePanel();
    updateTopbarLocation();
    load();
  }

  function renderSuggestions(results) {
    suggestEl.innerHTML = '';
    _currentResults = results;
    _activeIdx = -1;
    if (!results.length) { closeSuggest(); return; }
    results.forEach((r) => {
      const div     = document.createElement('div');
      div.className = 'suggest-item';
      const country = r.country_code ? ` · ${r.country_code.toUpperCase()}` : '';
      const admin   = r.admin1 ? `, ${r.admin1}` : '';
      div.textContent = r.name + admin + country;
      div.addEventListener('mousedown', e => { e.preventDefault(); applyResult(r); });
      suggestEl.appendChild(div);
    });
    suggestEl.classList.add('open');
  }

  function setActive(idx) {
    const items = suggestEl.querySelectorAll('.suggest-item');
    items.forEach(el => el.classList.remove('active'));
    _activeIdx = idx;
    if (idx >= 0 && idx < items.length) items[idx].classList.add('active');
  }

  async function doSearch(query) {
    if (!query || query.length < 2) { closeSuggest(); return; }
    try {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=en&format=json`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      renderSuggestions(data.results || []);
    } catch (_) { closeSuggest(); }
  }

  searchEl.addEventListener('input', () => {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => doSearch(searchEl.value.trim()), 350);
  });

  searchEl.addEventListener('keydown', e => {
    if (!suggestEl.classList.contains('open')) return;
    const count = _currentResults.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((_activeIdx + 1) % count); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((_activeIdx - 1 + count) % count); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (_activeIdx >= 0 && _activeIdx < count) applyResult(_currentResults[_activeIdx]);
      else if (count > 0) applyResult(_currentResults[0]);
    } else if (e.key === 'Escape') { closeSuggest(); }
  });

  searchEl.addEventListener('blur', () => setTimeout(closeSuggest, 150));

  document.addEventListener('click', e => {
    if (!searchEl.contains(e.target) && !suggestEl.contains(e.target)) closeSuggest();
  });
})();


/* ============================================================
   DROPDOWN HANDLER
   ============================================================ */
document.getElementById('location-select').addEventListener('change', async function () {
  const parts = this.value.split(',');
  const lat   = parseFloat(parts[0]);
  const lon   = parseFloat(parts[1]);
  const tz    = parts.slice(2).join(',');
  const loc   = LOCATIONS.find(l => String(l.lat) === parts[0]);

  if (loc) {
    Object.assign(CONFIG, loc, { refreshMinutes: 15 });
  } else {
    CONFIG.lat = lat; CONFIG.lon = lon; CONFIG.tz = tz;
  }

  _locationElev = null;
  _locationPop  = null;
  updateHerePanel();
  updateTopbarLocation();
  load();

  try {
    const name = loc ? loc.label.replace(/,.*/, '').trim() : '';
    if (name) {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5&language=en&format=json`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const results = data.results || [];
        let best = null, bestDist = Infinity;
        for (const r of results) {
          const dlat = r.latitude  - CONFIG.lat;
          const dlon = r.longitude - CONFIG.lon;
          const dist = dlat * dlat + dlon * dlon;
          if (dist < bestDist) { bestDist = dist; best = r; }
        }
        if (best) {
          _locationElev = best.elevation  ?? null;
          _locationPop  = best.population ?? null;
          updateLocationElevPop();
        }
      }
    }
  } catch (_) {}
});


/* ============================================================
   RANGE BUTTON HANDLERS
   ============================================================ */
document.getElementById('hourly-range-btns').addEventListener('click', function (e) {
  const btn = e.target.closest('.range-btn');
  if (!btn) return;
  this.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  AppState.view.cycleCount = parseInt(btn.dataset.val);
  if (AppState.bm.daily) buildTimeDomain();
  if (AppState.bm.hourly) renderHourly({ hourly: AppState.bm.hourly, daily: AppState.bm.daily, current: AppState.bm.current });
  if (AppState.bm.daily) renderDaily({ hourly: AppState.bm.hourly, daily: AppState.bm.daily, current: AppState.bm.current });
});

document.getElementById('daily-range-btns').addEventListener('click', function (e) {
  const btn = e.target.closest('.range-btn');
  if (!btn) return;
  this.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  AppState.view.dailyDays = parseInt(btn.dataset.val);
  if (AppState.bm.daily) renderDaily({ hourly: AppState.bm.hourly, daily: AppState.bm.daily, current: AppState.bm.current });
});

document.getElementById('now-sky-btns').addEventListener('click', function (e) {
  const btn = e.target.closest('.range-btn');
  if (!btn) return;
  this.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  AppState.view.nowSkyView = btn.dataset.view;
  updateSkybowlWindowForView();
  redrawNowSky();
  if (AppState.bm.hourly) renderHourly({ hourly: AppState.bm.hourly, daily: AppState.bm.daily, current: AppState.bm.current });
});


/* ============================================================
   SOUP SPEC TOGGLE
   ============================================================ */
function toggleSoup(btn) {
  const body  = btn.closest('.soup-spec-bar').nextElementSibling;
  const isOpen = body.classList.toggle('open');
  btn.classList.toggle('open', isOpen);
  btn.textContent = isOpen ? '[ CLOSE ]' : '[ SOUP SPEC ]';
}


/* ============================================================
   GLOBE DRAW  — Horizon-Clamped Path rendering
   ============================================================
   Strategy: abandon Sutherland-Hodgman analytical clipping.
   Instead, densify polygon edges so they follow sphere curvature,
   then project every point. Points on the back-hemisphere are NOT
   discarded — they are clamped radially to the horizon circle.
   Because the canvas is clipped to the globe disc, the fill()
   is always "trapped" inside; no chord artifacts across oceans.
   ============================================================ */
function drawGlobe(lat, lon) {
  const canvas = document.getElementById('globe-canvas');
  if (!canvas) return;

  const ctx  = canvas.getContext('2d');
  const dpr  = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const size = Math.max(rect.height || 150, 140);
  canvas.width  = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width  = size + 'px';
  canvas.style.height = size + 'px';
  ctx.scale(dpr, dpr);

  const r  = size / 2 - 16;
  const cx = size / 2;
  const cy = size / 2;

  const GLOBE_LAT = lat * Math.PI / 180;
  const GLOBE_LON = lon * Math.PI / 180;

  /* ── Pre-compute rotation constants ── */
  const sinLat = Math.sin(GLOBE_LAT), cosLat = Math.cos(GLOBE_LAT);
  const sinLon = Math.sin(GLOBE_LON), cosLon = Math.cos(GLOBE_LON);

  /* ── Cartesian unit-vector for a lon/lat pair ── */
  function toXYZ(lonDeg, latDeg) {
    const phi = latDeg * Math.PI / 180;
    const lam = lonDeg * Math.PI / 180;
    return [
      Math.cos(phi) * Math.cos(lam),
      Math.cos(phi) * Math.sin(lam),
      Math.sin(phi),
    ];
  }

  /* ── Dot product with the view direction vector ──
     Positive  → front hemisphere (visible)
     Negative  → back  hemisphere (behind globe) */
  const VX = Math.cos(GLOBE_LAT) * Math.cos(GLOBE_LON);
  const VY = Math.cos(GLOBE_LAT) * Math.sin(GLOBE_LON);
  const VZ = Math.sin(GLOBE_LAT);
  function vis(p) { return p[0]*VX + p[1]*VY + p[2]*VZ; }

  /* ── Orthographic screen projection of a 3-D unit vector ──
     Returns [canvasX, canvasY].  Works for both hemispheres;
     back-hemisphere points land outside the horizon circle. */
  function projectXYZ(p) {
    const sx =  p[0] * (-sinLon) + p[1] * cosLon;
    const sy =  p[0] * (-sinLat * cosLon)
              + p[1] * (-sinLat * sinLon)
              + p[2] *   cosLat;
    return [cx + r * sx, cy - r * sy];
  }

  /* ── Horizon-clamped projection ──
     Front points project normally.
     Back points are projected the same way, then their (sx, sy)
     is normalised to sit exactly on the horizon circle.
     This makes back-hemisphere vertices "crawl" along the rim
     instead of jumping across the disc. */
  function projectClamped(p) {
    const sx =  p[0] * (-sinLon) + p[1] * cosLon;
    const sy =  p[0] * (-sinLat * cosLon)
              + p[1] * (-sinLat * sinLon)
              + p[2] *   cosLat;

    if (vis(p) >= 0) {
      /* Front hemisphere — normal orthographic projection */
      return [cx + r * sx, cy - r * sy];
    }
    /* Back hemisphere — radially clamp onto the horizon ring.
       Guard: if the projected point is at/near the origin (antipodal
       to the view centre), the direction is undefined.  Place it at
       an arbitrary but finite horizon point so NaN never enters the
       canvas path. */
    let mag = Math.sqrt(sx * sx + sy * sy);
    if (mag < 0.0001) mag = 0.0001;
    return [cx + r * (sx / mag), cy - r * (sy / mag)];
  }

  /* ── Grid-line projection: returns null for back hemisphere ── */
  function projectVisible(latDeg, lonDeg) {
    const p = toXYZ(lonDeg, latDeg);
    if (vis(p) < 0) return null;
    return projectXYZ(p);
  }

  /* ── Densify a single edge by interpolating on the sphere ──
     Any edge longer than THRESH degrees is subdivided.
     Interpolation is slerp-like: normalise the midpoint XYZ.
     MAX_STEPS prevents infinite loops on pathological input. */
  const THRESH_DEG = 4;           // subdivide edges longer than this
  const THRESH_SQ  = THRESH_DEG * THRESH_DEG;

  function densifyEdge(a, b, out) {
    /* a and b are [lonDeg, latDeg] pairs */
    const dLon = b[0] - a[0];
    const dLat = b[1] - a[1];
    if (dLon * dLon + dLat * dLat <= THRESH_SQ) { out.push(b); return; }

    /* Recursive bisection on sphere via XYZ midpoint.
       If pa and pb are antipodal, their sum is ~0 and ml collapses to
       zero — clamp ml so we always get a finite midpoint.
       Also clamp mid3[2] into [-1,1] before asin to prevent NaN on
       floating-point rounding beyond ±1 (seen with polar polygons). */
    const pa = toXYZ(a[0], a[1]);
    const pb = toXYZ(b[0], b[1]);
    const mx = pa[0] + pb[0], my = pa[1] + pb[1], mz = pa[2] + pb[2];
    let ml = Math.sqrt(mx*mx + my*my + mz*mz);
    if (ml < 1e-10) { out.push(b); return; }   // antipodal pair — skip bisection
    const mid3 = [mx/ml, my/ml, mz/ml];
    /* Convert midpoint back to lon/lat for recursive call */
    const midLat = Math.asin(Math.max(-1, Math.min(1, mid3[2]))) * 180 / Math.PI;
    const midLon = Math.atan2(mid3[1], mid3[0]) * 180 / Math.PI;
    const mid2   = [midLon, midLat];

    densifyEdge(a, mid2, out);
    densifyEdge(mid2, b, out);
  }

  /* ── Densify an entire ring of [lon, lat] pairs ── */
  function densifyRing(coords) {
    if (coords.length < 2) return coords;
    const out = [coords[0]];
    for (let i = 1; i < coords.length; i++) {
      densifyEdge(coords[i - 1], coords[i], out);
    }
    return out;
  }

  /* ── Draw one land polygon using horizon clamping ──
     No analytical clipping.  Every vertex is always projected;
     back-hemisphere points clamp to the rim.
     The canvas clip-path (globe circle) traps the fill. */
  function drawPoly(coords, fill, stroke) {
    if (coords.length < 3) return;

    /* Skip polygons entirely on the back hemisphere (quick reject) */
    let anyFront = false;
    for (const [lo, la] of coords) {
      if (vis(toXYZ(lo, la)) >= 0) { anyFront = true; break; }
    }
    if (!anyFront) return;

    /* Densify edges to follow sphere curvature */
    const dense = densifyRing(coords);

    ctx.beginPath();
    let first = true;
    for (const [lo, la] of dense) {
      const p = toXYZ(lo, la);
      const [px, py] = projectClamped(p);
      /* Skip any vertex that produced NaN (should not happen after the
         guards above, but a corrupted polygon in WORLD_POLYS can still
         supply degenerate coordinates). */
      if (!isFinite(px) || !isFinite(py)) continue;
      if (first) { ctx.moveTo(px, py); first = false; }
      else        { ctx.lineTo(px, py); }
    }
    ctx.closePath();

    if (fill)   { ctx.fillStyle = fill;   ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 0.4; ctx.stroke(); }
  }


  /* ══════════════════════════════════════════════════════════
     RENDER
     ══════════════════════════════════════════════════════════ */

  /* Ocean background */
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#1a3a5c'; ctx.fill();
  ctx.strokeStyle = '#0d2236'; ctx.lineWidth = 1; ctx.stroke();

  /* Clip all subsequent drawing to the globe disc */
  const LAND = '#2d5a27', LAND_STROKE = '#1e3d1b';
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r - 0.5, 0, Math.PI * 2);
  ctx.clip();

  /* Land polygons */
  for (const poly of (window.WORLD_POLYS || [])) drawPoly(poly, LAND, LAND_STROKE);

  /* Graticule — these still use the null-return projection so grid
     lines are only drawn on the visible hemisphere */
  ctx.setLineDash([1, 3]);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 0.5;
  for (let la = -60; la <= 80; la += 20) {
    const pts = [];
    for (let lo = -180; lo <= 180; lo += 5) {
      const p = projectVisible(la, lo);
      if (p) pts.push(p);
    }
    if (pts.length > 1) {
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    }
  }
  for (let lo = -180; lo <= 180; lo += 30) {
    const pts = [];
    for (let la = -80; la <= 80; la += 5) {
      const p = projectVisible(la, lo);
      if (p) pts.push(p);
    }
    if (pts.length > 1) {
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  ctx.restore();

  /* Pulsing location dot — driven by global pulse */
  const gpIntensity = getPulseIntensity();
  const gpScale     = getPulseScale();
  const gpAlpha     = getPulseAlpha();
  /* Expanding ring */
  ctx.beginPath();
  ctx.arc(cx, cy, 2 + gpScale * 4, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(255,0,0,${(0.9 - gpIntensity * 0.75).toFixed(3)})`;
  ctx.lineWidth = 1; ctx.stroke();
  /* Core dot */
  ctx.beginPath();
  ctx.arc(cx, cy, 2, 0, Math.PI * 2);
  ctx.fillStyle = 'red'; ctx.fill();
}


/* ============================================================
   BOOT
   ============================================================ */
updateHerePanel();
load();
scheduleRefresh();
