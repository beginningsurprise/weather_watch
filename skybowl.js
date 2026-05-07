/* ============================================================
   skybowl.js — Skybowl canvas renderer
   ============================================================
   CHANGE LOG (v.260426):
   - Replaced all window._last* reads with AppState reads
   - Replaced window._skybowlStart/End/IsNight writes with
     AppState.derived.skybowlWindow writes
   - Replaced _windMph / _windDeg module-scope reads with
     AppState.bm.current.wind_mph / wind_deg
   - drawSkybowl() still accepts (srDt, ssDt, cloudPct,
     weatherEmoji, hourlyData) — signature unchanged
   - All geometry, drawWedge(), sbPoint(), sbAngle(), hourSlots
     builder loop, wedge construction, ctx.arc() calls, and all
     angle arithmetic are IDENTICAL to the prior version.

   PUBLIC API (called by app.js):
     drawSkybowl(srDt, ssDt, cloudPct, weatherEmoji, hourlyData)
     redrawNowSky()
     updateSkybowlWindowForView()
     updateNowSkyButtons(isCurrentlyDay)
     startWindAnim()

   DEPENDENCIES (read-only, injected via shared scope with app.js):
     AppState, CONFIG, nowInTz(), isSkinCanonical(), isSkinTerminal(),
     isSkinLight(), toMph(), toIn(), wmo(), fmtTime12(),
     dewComfortEmoji()
   ============================================================ */

/* ============================================================
   COORDINATE SYSTEM — READ THIS BEFORE EDITING
   ============================================================

   The Skybowl uses a POLAR coordinate system where:
     θ = 0      → East  (right horizon)
     θ = π/2    → North (apex, top)
     θ = π      → West  (left horizon)
   Angles increase COUNTER-CLOCKWISE (standard math convention).

   TIME MAPPING: t=0 (arcStart) → θ=π (West), t=1 (arcEnd) → θ=0 (East).
   So the sun/night arc "travels" left-to-right as time advances.

   ── WHY θ IS NEGATED IN ctx.arc() ──────────────────────────
   HTML Canvas has an INVERTED Y-axis: positive Y points DOWN.
   This means Canvas "clockwise" is visually counter-clockwise to
   standard math, and vice-versa. If you pass θ=π/2 directly to
   ctx.arc(), Canvas treats it as "90° clockwise from East" which
   is the BOTTOM of the screen — not the top.

   FIX: negate all angles passed to ctx.arc() and ctx.rotate().
     -θ tells Canvas: "go into negative-Y space (upward)."
   sbPoint() handles this manually by subtracting sine from cy.
   ctx.arc() calls use explicit -θ notation throughout.

   ── WHY tA > tB MATTERS (THE WEDGE INVARIANT) ───────────────
   When drawing annular ribbon wedges, tA (start angle, western
   side) > tB (end angle, eastern side) because angles run from
   π down to 0 as time advances left-to-right.

   ctx.arc(cx, cy, r, -tA, -tB, false) with tA > tB means:
     -tA < -tB  (more negative start, less negative end)
   Canvas with anticlockwise=false sweeps in the INCREASING
   direction, so it sweeps from -tA to -tB — the SHORT path
   through the top of the arc. ✓

   If tA <= tB, -tA >= -tB, and the sweep goes the LONG way
   around (~full circle). This is Bug #1. Always verify tA > tB.

   ── SUMMARY CHEAT SHEET ─────────────────────────────────────
   - sbPoint(θ, R, cx, cy, base) → correct {x,y} for any angle
   - ctx.arc uses -θ to flip into upper hemisphere
   - anticlockwise=false + tA>tB = short upper arc ✓
   - anticlockwise=true  OR  tA<=tB = long arc (bug) ✗
   ============================================================ */


/* ============================================================
   WIND ANIMATION STATE (module-scope, not global)
   ============================================================ */
let _terminalDashOffset = 0;
let _windAnimRunning    = false;
let _windAnimReq        = null;

/* ============================================================
   TOOLTIP STATE — written by drawSkybowl(), read by event handlers
   ============================================================ */
let _sbLastWedges   = [];   // copy of wedges array from last draw
let _sbLastHourly   = null; // reference to hourlyData from last draw
let _sbLastCx       = 0;
let _sbLastCy       = 0;
let _sbLastBase     = 0;
let _sbLastIsNight  = false;
let _sbActiveWedge  = null; // tap-to-lock: wedge pinned by touch tap (null = no lock)

/* ============================================================
   MAIN ANIMATION LOOP
   ============================================================ */
let _lastRedrawTs = 0;

function _animLoop(ts) {
  // Read wind speed from AppState (no window._* globals)
  const mph = (AppState && AppState.bm && AppState.bm.current)
    ? (AppState.bm.current.wind_mph ?? 0)
    : 0;
  const dashSpeed = Math.max(0.05, mph * 0.04);
  _terminalDashOffset = (_terminalDashOffset + dashSpeed) % 14;

  if (ts - _lastRedrawTs > 1000) {
    if (AppState && AppState.derived && AppState.derived.sunTimes) redrawNowSky();
    _lastRedrawTs = ts;
  }

  _windAnimReq = requestAnimationFrame(_animLoop);
}

function startWindAnim() {
  if (_windAnimRunning) return;
  _windAnimRunning = true;
  _windAnimReq = requestAnimationFrame(_animLoop);
}


/* ============================================================
   COORDINATE HELPERS
   ============================================================ */

/**
 * sbAngle — map a wall-clock timestamp to a Skybowl polar angle.
 * t=0 (arcStart) → π (West), t=1 (arcEnd) → 0 (East).
 */
function sbAngle(ts, startMs, endMs) {
  const t = Math.max(0, Math.min(1, (ts - startMs) / (endMs - startMs)));
  return Math.PI * (1 - t);
}

/**
 * sbPoint — convert (theta, R) → canvas {x, y}.
 * Note: y uses -sin(θ) to correct for Canvas Y-axis inversion.
 */
function sbPoint(theta, R, cx, cy, base) {
  return {
    x: cx + R * base * Math.cos(theta),
    y: cy - R * base * Math.sin(theta),   // ← negated sine = upward in Canvas
  };
}


/* ============================================================
   COLOR HELPERS
   ============================================================ */

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpRGB(a, b, t) {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
  ];
}

function rgbStr(rgb) {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

function blendRGB(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function applyPrecipMood(baseRGB, precipProb, precipMm, isNight) {
  const pProb = Math.max(0, Math.min(100, precipProb || 0)) / 100;

  // Normalize precipitation amount
  // ~4 mm/hr should already feel very stormy
  const pAmt = Math.max(0, Math.min(1, (precipMm || 0) / 4));

  // Weighted blend:
  // probability = atmospheric threat
  // amount      = severity
  let wetness =
    0.55 * pProb +
    0.45 * pAmt;

  // Nonlinear curve:
  // keeps low precip subtle,
  // ramps stronger near storms
  wetness = Math.pow(wetness, 1.6);

  // Atmospheric storm targets
  const stormRGB = isNight
    ? [70, 75, 90]
    : [95, 105, 120];

  return blendRGB(baseRGB, stormRGB, wetness);
}

const CLOUD_PALETTES = {
  nautical_day: [
    [0.00, [64, 128, 255]],
    [0.50, [170, 205, 255]],
    [0.75, [242, 245, 250]],
    [1.00, [252, 252, 255]],
  ],

  nautical_night: [
    [0.00, [60, 30, 160]],
    [0.50, [120, 110, 190]],
    [0.75, [210, 215, 235]],
    [1.00, [245, 245, 250]],
  ],

  terminal_day: [
    [0.00, [0, 255, 65]],
    [0.50, [120, 255, 170]],
    [0.75, [235, 255, 240]],
    [1.00, [255, 255, 255]],
  ],

  terminal_night: [
    [0.00, [80, 0, 140]],
    [0.50, [160, 120, 220]],
    [0.75, [235, 225, 255]],
    [1.00, [255, 255, 255]],
  ],
};

function cloudSliceColor(cldPct, isNight, precipProb = 0, precipMm = 0) {
  const f = Math.max(0, Math.min(100, cldPct)) / 100;

  const key =
    isSkinTerminal()
      ? (isNight ? 'terminal_night' : 'terminal_day')
      : (isNight ? 'nautical_night' : 'nautical_day');

  const stops = CLOUD_PALETTES[key];

  let baseRGB = stops[stops.length - 1][1];

  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, c0] = stops[i];
    const [p1, c1] = stops[i + 1];

    if (f >= p0 && f <= p1) {
      const t = (f - p0) / (p1 - p0);
      baseRGB = lerpRGB(c0, c1, t);
      break;
    }
  }

  const finalRGB = applyPrecipMood(baseRGB, precipProb, precipMm, isNight);
  return rgbStr(finalRGB);
}

function lerpColor(a, b, t) {
  return a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',');
}


/* ============================================================
   PRIMITIVE DRAW HELPERS
   ============================================================ */

/**
 * drawWedge — draw one annular-sector "Trivial Pursuit" slice.
 *
 * INVARIANT: thetaA > thetaB  (angles run π→0, West→East).
 *
 * Why -thetaA and -thetaB:
 *   Negating flips from math-space (North=up) into Canvas-space
 *   (North=down) so ctx.arc() draws in the upper hemisphere.
 *
 * Why anticlockwise=false:
 *   With negated angles, -thetaA < -thetaB (more negative start).
 *   Canvas sweeps in the INCREASING direction (clockwise visually),
 *   which goes from -thetaA to -thetaB — the SHORT path through
 *   the top. anticlockwise=true would take the long path. ✗
 *
 * Compound path: outer arc CW (false) + inner arc CCW (true)
 * → nonzero winding rule punches a clean hole at rInner.
 */
function drawWedge(ctx, cx, cy, base, rInner, rOuter, thetaA, thetaB, fillStyle) {
  if (Math.abs(thetaA - thetaB) < 1e-6) return;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, rOuter * base, -thetaA, -thetaB, false);
  ctx.arc(cx, cy, rInner * base, -thetaB, -thetaA, true);
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
  ctx.restore();
}

function sbText(ctx, text, theta, R, cx, cy, base, style = {}) {
  const pt = sbPoint(theta, R, cx, cy, base);
  ctx.save();
  Object.assign(ctx, style);
  ctx.translate(pt.x, pt.y);
  ctx.fillText(text, 0, 0);
  ctx.restore();
}


/* ============================================================
   MAIN SKYBOWL DRAW FUNCTION
   Pure renderer: reads from parameters + AppState, writes
   only to the canvas. No DOM mutations other than canvas pixels.
   ============================================================ */
function drawSkybowl(srDt, ssDt, cloudPct = 0, weatherEmoji = '☀️', hourlyData = null) {
  const canvas = document.getElementById('sun-arc-canvas');
  if (!canvas) return;

  const rect  = canvas.getBoundingClientRect();
  const dpr   = window.devicePixelRatio || 1;
  canvas.width  = Math.round(rect.width  * dpr) || 880;
  canvas.height = Math.round(rect.height * dpr) || 440;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = rect.width  || 440;
  const H = rect.height || 220;

  const isLight   = isSkinLight();
  const cs        = getComputedStyle(document.body);
  const monoFont  = 'Share Tech Mono, monospace';
  const fg3    = cs.getPropertyValue('--fg3').trim()    || '#aaa';
  const fgDim  = cs.getPropertyValue('--fg-dim').trim() || '#888';
  const accent = cs.getPropertyValue('--accent').trim() || '#00ff41';
  const c = cloudPct / 100;

  const LABEL_H = 16;
  const cx   = W / 2;
  const cy   = H - LABEL_H;
  const base = Math.min(W / 2 - 4, cy * 0.78);	// if top is chopped

  // ── Position overlay instruments using bowl geometry ──────
  {
    const anemEl     = document.getElementById('anemometer-wrap');
    const humidityEl = document.getElementById('humidity-indicator');
	const locEl = document.getElementById('sky-location');
    const centerTempEl = document.getElementById('sky-center-temp');
	
    const comfortEmoji = (AppState && AppState.derived && AppState.derived.comfortEmoji)
      ? AppState.derived.comfortEmoji : '🙂';

    const _nowSkyView = AppState && AppState.view ? AppState.view.nowSkyView : 'current';

    if (anemEl) {
      anemEl.style.left = `${cx - base * 1.1}px`;
      anemEl.style.top  = `${cy - base * 0.95}px`;
      // Task 2: show anemometer only for 'current' view
      const anemVis = (_nowSkyView === 'current') ? '' : 'none';
      anemEl.style.display = anemVis;
      const anemLabelEl = document.getElementById('anemometer-label');
      if (anemLabelEl) anemLabelEl.style.display = anemVis;
    }

    if (locEl) {
		locEl.style.position = 'absolute';
		locEl.style.left = `${cx}px`;
		locEl.style.top  = `${cy - base * 0.1}px`;
		locEl.style.transform = 'translate(-50%, -50%)';
	}

    // Task 1: center temperature display
    if (centerTempEl) {
      centerTempEl.style.left = `${cx}px`;
      centerTempEl.style.top  = `${cy - base * 0.35}px`;

      if (_nowSkyView === 'current') {
        // Show current temperature, styled like NOW panel
        const tempF = (AppState && AppState.bm && AppState.bm.current && AppState.bm.current.temperature_2m != null)
          ? Math.round(AppState.bm.current.temperature_2m * 9 / 5 + 32)
          : null;
        if (tempF !== null) {
          centerTempEl.innerHTML =
            `<span style="font-family:var(--font-display,\'Bebas Neue\',sans-serif);font-size:2.6rem;line-height:1;color:var(--accent);">${tempF}°F</span>`;
        } else {
          centerTempEl.innerHTML = '';
        }
      } else {
        // Show high/low from skybowlWindow
        const win = AppState && AppState.derived && AppState.derived.skybowlWindow;
        const hourly = AppState && AppState.bm && AppState.bm.hourly;
        if (win && hourly && hourly.time && hourly.temperature_2m) {
          const winStart = win.start ? win.start.getTime() : 0;
          const winEnd   = win.end   ? win.end.getTime()   : 0;
          let hi = -Infinity, lo = Infinity;
          for (let k = 0; k < hourly.time.length; k++) {
            const tMs = new Date(hourly.time[k]).getTime();
            if (tMs < winStart || tMs > winEnd) continue;
            const tF = hourly.temperature_2m[k] * 9 / 5 + 32;
            if (tF > hi) hi = tF;
            if (tF < lo) lo = tF;
          }
          if (hi !== -Infinity && lo !== Infinity) {
            centerTempEl.innerHTML =
              `<span style="font-family:var(--font-display,'Bebas Neue',sans-serif);font-size:1.7rem;line-height:1.05;">
                 <span style="color:var(--cold);">${Math.round(lo)}°F</span>
                 &thinsp;–&thinsp;
                 <span style="color:var(--hot);">${Math.round(hi)}°F</span>
               </span>`;          } else {
            centerTempEl.innerHTML = '';
          }
        } else {
          centerTempEl.innerHTML = '';
        }
      }
    }
  }

  // _overrideNow is set temporarily by redrawNowSky() for non-current views.
  const now = window._overrideNow || nowInTz(CONFIG.tz);

  let arcStart, arcEnd, isNightArc;
  {
    const isDayTime = now >= srDt && now <= ssDt;
    if (isDayTime) {
      arcStart   = srDt;
      arcEnd     = ssDt;
      isNightArc = false;
    } else {
      const dayMs   = ssDt - srDt;
      const nightMs = 24 * 3600000 - dayMs;
      if (now > ssDt) {
        arcStart = ssDt;
        arcEnd   = new Date(ssDt.getTime() + nightMs);
      } else {
        arcStart = new Date(srDt.getTime() - nightMs);
        arcEnd   = srDt;
      }
      isNightArc = true;
    }
  }
  const totalArcMs = arcEnd - arcStart;
  const nowT     = Math.max(0, Math.min(1, (now - arcStart) / totalArcMs));
  const nowTheta = Math.PI * (1 - nowT);

  if (totalArcMs <= 0) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle    = fg3;
    ctx.font         = `14px ${monoFont}`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(isNightArc ? 'Polar Night' : 'Midnight Sun', cx, cy / 2);
    return;
  }

  // Write skybowl window to AppState (replaces window._skybowlStart/End/IsNight)
  if (AppState && AppState.derived) {
    AppState.derived.skybowlWindow = { start: arcStart, end: arcEnd, isNight: isNightArc };
  }

  // ── Build hourly slot index ────────────────────────────────
  const hourSlots = [];
  if (hourlyData && hourlyData.time && hourlyData.cloud_cover) {
    const hdIndex = new Map();
    for (let k = 0; k < hourlyData.time.length; k++) {
      hdIndex.set(hourlyData.time[k], k);
    }
    const fmt = new Intl.DateTimeFormat('sv-SE', {
      timeZone: CONFIG.tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const toKey    = ms => fmt.format(new Date(ms)).replace(' ', 'T');
    const arcStartMs  = arcStart.getTime();
    const arcEndMs    = arcEnd.getTime();
    const firstStepMs = Math.ceil(arcStartMs / 3600000) * 3600000;

    // ── DEBUG INSTRUMENTATION (temporary) ────────────────────
    const debugRows = [];
    // ─────────────────────────────────────────────────────────

    for (let tMs = firstStepMs; tMs <= arcEndMs; tMs += 3600000) {
      const tTarget = tMs;
      let bestIdx = -1;
      let bestDiff = Infinity;
      for (let i = 0; i < hourlyData.time.length; i++) {
        const tData = new Date(hourlyData.time[i]).getTime();
        const diff = Math.abs(tData - tTarget);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = i;
        }
      }
      const MAX_DIFF = 30 * 60 * 1000;
      const hdIdx = (bestDiff <= MAX_DIFF) ? bestIdx : -1;
      // ── DEBUG INSTRUMENTATION (temporary) ────────────────────
      if (hdIdx >= 0) {
        const slotUTC = new Date(tMs).toISOString();

        const slotLocal = new Date(tMs).toLocaleString('en-US', {
          timeZone: CONFIG.tz,
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          month: 'short',
          day: 'numeric'
        });

        const hdUTC = new Date(hourlyData.time[hdIdx]).toISOString();

        const hdLocal = new Date(hourlyData.time[hdIdx]).toLocaleString('en-US', {
          timeZone: CONFIG.tz,
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          month: 'short',
          day: 'numeric'
        });

        debugRows.push({
          hdIdx,

          slotUTC,
          slotLocal,

          hdUTC,
          hdLocal,

          diffMinutes: Math.round(
            (
              new Date(hourlyData.time[hdIdx]).getTime() - tMs
            ) / 60000
          ),

          browserHour: new Date(tMs).getHours(),

          tzHour: parseInt(
            new Intl.DateTimeFormat('en-US', {
              hour: 'numeric',
              hour12: false,
              timeZone: CONFIG.tz
            }).format(new Date(tMs))
          )
        });
      }
      // ─────────────────────────────────────────────────────────
      if (hdIdx === -1) continue;
      const tNorm = (tMs - arcStartMs) / totalArcMs;
      hourSlots.push({
        tMs,
        tNorm,
        theta: Math.PI * (1 - tNorm),
        hdIdx,
        isDay: hourlyData.is_day[hdIdx] === 1,
      });
    }
    // ── DEBUG INSTRUMENTATION (temporary) ────────────────────
    console.group('SKYBOWL SLOT DEBUG');
    console.table(debugRows);
    console.groupEnd();
    // ─────────────────────────────────────────────────────────
  }

  ctx.clearRect(0, 0, W, H);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();

  // ── LAYER 1: INNER BOWL BACKGROUND ─────────────────────────
  {
    const panelColor = getComputedStyle(document.body).getPropertyValue('--panel').trim() || '#fff';
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, base * 0.75, Math.PI, 0, false);
    ctx.closePath();
    ctx.fillStyle = panelColor;
    ctx.fill();
    ctx.restore();
  }

  // ── LAYER 2: CLOUD RIBBON ──────────────────────────────────
  const wedges = [];
  {
    if (hourSlots.length === 0) {
      drawWedge(ctx, cx, cy, base, 0.75, 1.0, Math.PI, 0,
        cloudSliceColor(cloudPct, isNightArc));
    } else {
      // ── LEADING WEDGE: fill gap between arcStart (θ=π) and first hourly slot ──
      const firstSlot = hourSlots[0];
      if (firstSlot.tMs > arcStart.getTime()) {
        const tA = Math.PI;           // arcStart is always θ=π
        const tB = firstSlot.theta;   // first slot's angle (< π, so tA > tB ✓)
        const cld   = hourlyData.cloud_cover[firstSlot.hdIdx];
        const color = cloudSliceColor(
          cld,
          !firstSlot.isDay,
          hourlyData.precipitation_probability?.[firstSlot.hdIdx] ?? 0,
          hourlyData.precipitation?.[firstSlot.hdIdx] ?? 0
        );
        wedges.push({ tA, tB, midTheta: (tA + tB) / 2, cld, hdIdx: firstSlot.hdIdx, tNorm: 0, isDay: firstSlot.isDay });
        drawWedge(ctx, cx, cy, base, 0.75, 1.0, tA, tB, color);
      }

      // ── EXISTING LOOP — untouched ────────────────────────────────────────────
      for (let si = 0; si < hourSlots.length; si++) {
        const slot = hourSlots[si];
        const tA = slot.theta;
        const tB = (si + 1 < hourSlots.length)
          ? hourSlots[si + 1].theta
          : Math.PI * (1 - Math.min(1.0, slot.tNorm + 3600000 / totalArcMs));

        const cld   = hourlyData.cloud_cover[slot.hdIdx];
        const color = cloudSliceColor(
          cld,
          !slot.isDay,
          hourlyData.precipitation_probability?.[slot.hdIdx] ?? 0,
          hourlyData.precipitation?.[slot.hdIdx] ?? 0
        );

        wedges.push({ tA, tB, midTheta: (tA + tB) / 2, cld, hdIdx: slot.hdIdx, tNorm: slot.tNorm, isDay: slot.isDay });
        drawWedge(ctx, cx, cy, base, 0.75, 1.0, tA, tB, color);
		// --- CURRENT TIME WEDGE PULSE ---
			const slotStart = slot.tMs;
			const slotEnd = (si + 1 < hourSlots.length)
			  ? hourSlots[si + 1].tMs
			  : arcEnd.getTime();

			const nowMs = now.getTime();
			const isCurrent = nowMs >= slotStart && nowMs < slotEnd;

			if (isCurrent) {
			  const pIntensity = (typeof getPulseIntensity === 'function')
				? getPulseIntensity()
				: 0.5;

			  const pulseColor = document.body.classList.contains('skin-nautical')
				? '#F7931A'
				: '#00ff41';

			  ctx.save();

			  ctx.beginPath();

			  // Outer arc
			  ctx.arc(cx, cy, base * 1.0, -tA, -tB, false);

			  // Inner arc (reverse direction)
			  ctx.arc(cx, cy, base * 0.75, -tB, -tA, true);

			  ctx.closePath();

			  ctx.strokeStyle = pulseColor;
			  ctx.lineWidth = 3.0 + 2.5 * pIntensity;
			  ctx.globalAlpha = 0.35 + 0.6 * pIntensity;

			  ctx.stroke();

			  ctx.restore();
			}
      }

      // ── TRAILING WEDGE: fill gap between last hourly slot and arcEnd (θ=0) ──
      const lastSlot = hourSlots[hourSlots.length - 1];
      if (lastSlot.tMs + 3600000 < arcEnd.getTime()) {
        const tA = lastSlot.theta;  // last slot's angle (> 0, so tA > tB ✓)
        const tB = 0;               // arcEnd is always θ=0
        const cld   = hourlyData.cloud_cover[lastSlot.hdIdx];
        const color = cloudSliceColor(
          cld,
          !lastSlot.isDay,
          hourlyData.precipitation_probability?.[lastSlot.hdIdx] ?? 0,
          hourlyData.precipitation?.[lastSlot.hdIdx] ?? 0
        );
        wedges.push({ tA, tB, midTheta: (tA + tB) / 2, cld, hdIdx: lastSlot.hdIdx, tNorm: 1, isDay: lastSlot.isDay });
        drawWedge(ctx, cx, cy, base, 0.75, 1.0, tA, tB, color);
      }
    }
  }

  // ── LAYER 3: THE RIM ───────────────────────────────────────
  {
    const rimColor = isNightArc
      ? (!document.body.classList.contains('skin-terminal') ? '#8899bb' : '#9999cc')
      : (!document.body.classList.contains('skin-terminal') ? '#d4900a' : '#c8a820');
    ctx.save();
    ctx.globalAlpha  = 0.75 + (1 - c) * 0.25;
    ctx.lineWidth    = 2.5;
    ctx.lineCap      = 'butt';
    ctx.strokeStyle  = rimColor;
    if (!isLight) { ctx.shadowBlur = 6; ctx.shadowColor = rimColor; }
    ctx.beginPath();
    ctx.arc(cx, cy, base, Math.PI, 0, false);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  // ── LAYER 4: WIND ARROWS ──────────────────────────────────
  if (hourlyData && wedges.length > 0) {
    wedges.forEach(({ midTheta, hdIdx }) => {
      if (hdIdx === null) return;
      const windKph = hourlyData.wind_speed_10m[hdIdx]    ?? 0;
      const windDeg = hourlyData.wind_direction_10m[hdIdx] ?? 0;
      const mph     = toMph(windKph);
      const pt      = sbPoint(midTheta, 0.70, cx, cy, base);
		// ── Stepped wind bands (match TEMP FORECAST logic) ──
		let aL, alpha, lineW;

		if (mph < 3) {
		  aL = 5;
		  alpha = 0.3;
		  lineW = 1.0;
		} else if (mph < 9) {
		  aL = 7;
		  alpha = 0.55;
		  lineW = 1.2;
		} else if (mph < 19) {
		  aL = 9;
		  alpha = 0.75;
		  lineW = 1.4;
		} else {
		  aL = 11;
		  alpha = 1.0;
		  lineW = 1.6;
		}

      const arrowColor = isNightArc
        ? 'rgba(160,185,245,0.80)'
        : (!document.body.classList.contains('skin-terminal') ? 'rgba(40,100,200,0.80)' : 'rgba(0,220,80,0.80)');

      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate((windDeg - 180) * Math.PI / 180);
      ctx.strokeStyle = arrowColor;
      ctx.lineWidth   = lineW;
      ctx.globalAlpha = alpha;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.beginPath(); ctx.moveTo(0, aL * 0.35); ctx.lineTo(0, -aL); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-aL * 0.38, -aL * 0.4); ctx.lineTo(0, -aL); ctx.lineTo(aL * 0.38, -aL * 0.4);
      ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = alpha;
      ctx.save();
      ctx.font         = `8px ${monoFont}`;
      ctx.fillStyle    = arrowColor;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(String(Math.round(mph)), pt.x, pt.y + aL + 2);
      ctx.restore();
    });
  }

  // ── LAYER 5: PRECIPITATION ────────────────────────────────
  if (hourlyData && wedges.length > 0) {
    wedges.forEach(({ midTheta, hdIdx }) => {
      if (hdIdx === null) return;
      const precip = hourlyData.precipitation[hdIdx] ?? 0;
      const pt     = sbPoint(midTheta, 0.875, cx, cy, base);

      ctx.save();
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      if (precip > 0) {
        const rainIn = precip / 25.4;
        const sz = Math.max(10, Math.min(10, 5 + rainIn * 30));
        ctx.font      = `bold ${sz}px ${monoFont}`;
        //ctx.fillStyle = isSkinDefault() ? 'rgba(30,90,210,0.95)' : (isKitschy ? 'rgba(60,120,255,0.92)' : 'rgba(68,136,255,0.92)');
        ctx.fillStyle = isSkinTerminal()
          ? 'rgba(120,220,255,0.95)'
          : 'rgba(40,110,220,0.95)';
        ctx.fillText(toIn(precip) + '"', pt.x, pt.y);
      } else {
        ctx.font      = `8px ${monoFont}`;
        ctx.fillStyle = isNightArc ? 'rgba(180,190,220,0.30)' : 'rgba(80,130,180,0.28)';
        ctx.fillText('.', pt.x, pt.y);
      }
      ctx.restore();
    });
  }

  // ── LAYER 6: UV INDEX ─────────────────────────────────────
  if (hourlyData && !isNightArc && wedges.length > 0) {
    wedges.forEach(({ midTheta, hdIdx }) => {
      if (hdIdx === null) return;
      const uv = Math.round(hourlyData.uv_index?.[hdIdx] ?? 0);
      if (uv <= 0) return;
      const pt = sbPoint(midTheta, 1.22, cx, cy, base);
      if (pt.x < 2 || pt.x > W - 2 || pt.y < 2) return;

      ctx.save();
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      if (uv <= 3) {
        ctx.font      = `2px ${monoFont}`;
        ctx.fillStyle = isLight ? 'rgba(60,130,50,0.85)' : 'rgba(60,200,60,0.75)';
        ctx.fillText(uv, pt.x, pt.y);
      } else if (uv <= 6) {
        ctx.fillStyle = 'rgba(255,210,0,0.92)';
        ctx.fillRect(pt.x - 5.5, pt.y - 5, 11, 10);
        ctx.font      = `6px ${monoFont}`;
        ctx.fillStyle = '#333';
        ctx.fillText(uv, pt.x, pt.y);
      } else {
        ctx.fillStyle = 'rgba(220,40,40,0.94)';
        ctx.fillRect(pt.x - 6.5, pt.y - 5.5, 13, 11);
        ctx.font      = `bold 8px ${monoFont}`;
        ctx.fillStyle = '#fff';
        ctx.fillText(uv, pt.x, pt.y);
      }
      ctx.restore();
    });
  }

  // ── LAYER 7: TIME TICKS + LABELS ──────────────────────────
  if (hourSlots.length > 0) {
    const usingOverride = !!window._overrideNow;
    hourSlots.forEach((slot) => {
      const isPast   = !usingOverride && (slot.tNorm <= nowT);
      const hr = parseInt(
      new Intl.DateTimeFormat('en-US', {
          hour: 'numeric',
          hour12: false,
          timeZone: CONFIG.tz
        }).format(new Date(slot.tMs))
      );
      const isPrimaryAxis   = (hr === 0 || hr === 12);
      const isSecondaryAxis = (hr === 6 || hr === 18);
      const isEvery3 = (hr % 3 === 0);

      const outerR = (isPrimaryAxis || isSecondaryAxis) ? 1.135 : (isEvery3 ? 1.115 : 1.065);
      const alpha  = isPast ? 0.80 : 0.50;
      const tI     = sbPoint(slot.theta, 1.0,    cx, cy, base);
      const tO     = sbPoint(slot.theta, outerR, cx, cy, base);

      let baseLineWidth;
      if (isPrimaryAxis)        { baseLineWidth = 5; }
      else if (isSecondaryAxis) { baseLineWidth = 1.6; }
      else if (isEvery3)        { baseLineWidth = 1.6; }
      else                      { baseLineWidth = 0.6; }

      ctx.save();
      ctx.strokeStyle = fg3;
		if (isPrimaryAxis || isSecondaryAxis) {
		  // ── 1. full axis line ──
		  const pOuter = sbPoint(slot.theta, 1.0, cx, cy, base);

		  ctx.lineWidth   = baseLineWidth;
          ctx.globalAlpha =
            isPrimaryAxis   ? alpha * 0.3 :
            isSecondaryAxis ? alpha * 0.3  :
                              alpha;

		  ctx.beginPath();
		  ctx.moveTo(pOuter.x, pOuter.y);
		  ctx.lineTo(cx, cy);
		  ctx.stroke();

		  // ── 2. outer tick ──
		  const tickOuter = sbPoint(slot.theta, 1.08, cx, cy, base);

		  ctx.lineWidth = isPrimaryAxis ? 2.2 : 1.6;

		  ctx.beginPath();
		  ctx.moveTo(pOuter.x, pOuter.y);
		  ctx.lineTo(tickOuter.x, tickOuter.y);
		  ctx.stroke();

		} else {
		  ctx.lineWidth = baseLineWidth;

		  ctx.beginPath();
		  ctx.moveTo(tI.x, tI.y);
		  ctx.lineTo(tO.x, tO.y);
		  ctx.stroke();
		}

      if (isEvery3) {
        const label = String(hr).padStart(2, '0');
        const lPt   = sbPoint(slot.theta, 1.215, cx, cy, base);
        if (lPt.x >= 3 && lPt.x <= W - 3 && lPt.y >= -4 && lPt.y <= cy - 2) {
          ctx.save();
          // Labels should remain prominent even when axis guides are subtle
          ctx.globalAlpha = 1;
          ctx.font = `bold 13px ${monoFont}`;
          ctx.fillStyle = fg3;
          ctx.textAlign    = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, lPt.x, lPt.y);
          ctx.restore();
        }
      }
    });
  }

  // ── LAYER 8: WEATHER EMOJIS ───────────────────────────────
  if (hourlyData && wedges.length > 0) {
    const nowSlotIdx = (() => {
      for (let si = 0; si < wedges.length; si++) {
        const nextNorm = wedges[si + 1]?.tNorm ?? 1;
        if (wedges[si].tNorm <= nowT && nowT < nextNorm) return si;
      }
      return wedges.length - 1;
    })();

    let prevCode = null;
    wedges.forEach(({ midTheta, hdIdx, tNorm }, si) => {
      if (hdIdx === null) { prevCode = null; return; }
      const code       = hourlyData.weather_code[hdIdx];
      const isNowSlot  = (si === nowSlotIdx);
      const codeChanged = (prevCode === null || code !== prevCode);

      if (!isNowSlot && !codeChanged) { prevCode = code; return; }
      if (tNorm < 0.015 || tNorm > 0.985) { prevCode = code; return; }

      const info     = wmo(code);
      const eSize    = isNowSlot ? 28 : 16;
      let emojiStr = info.e;
      if (isNightArc) {
        if (code === 0) {
          emojiStr = '🌙'; // clear night
        } else if (code === 1 || code === 2) {
          emojiStr = '🌙'; // partly cloudy → still moon
        } else if (code === 3) {
          emojiStr = '☁️'; // overcast
        } else {
          // rain, storm, etc → keep neutral (no sun)
          emojiStr = info.e.replace('☀️', ''); // safety strip if needed
        }
      }
      const eOffset  = isNowSlot ? 14 : 8;

      const basePt  = sbPoint(midTheta, 1.0, cx, cy, base);
      const ex = basePt.x + Math.cos(midTheta) * eOffset;
      const ey = basePt.y - Math.sin(midTheta) * eOffset;

      ctx.save();
      ctx.font         = `${eSize}px serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha  = isNowSlot ? 1.0 : 0.85;

      if (isNowSlot) {
        const glowR  = isNightArc ? 12 : 18;
        const gFill  = isNightArc
          ? `rgba(200,210,255,${0.28 * (1 - c * 0.6)})`
          : `rgba(255,220,80,${0.45 * (1 - c * 0.7)})`;
        const gGrad  = ctx.createRadialGradient(ex, ey, 2, ex, ey, glowR);
        gGrad.addColorStop(0, gFill);
        gGrad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.globalAlpha = 1;
        ctx.fillStyle   = gGrad;
        ctx.beginPath();
        ctx.arc(ex, ey, glowR, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1.0;
      }

      ctx.fillText(emojiStr, ex, ey);
      ctx.restore();
      prevCode = code;
    });
  }

  // ── "NOW" PULSE DOT on the rim — driven by global pulse ─────
  {
    const dotPt      = sbPoint(nowTheta, 1.0, cx, cy, base);
    const pIntensity = (typeof getPulseIntensity === 'function') ? getPulseIntensity() : 0.5;
    const pScale     = (typeof getPulseScale     === 'function') ? getPulseScale()     : 1.2;
    const rimColor   = document.body.classList.contains('skin-terminal')
      ? '#00ff41'
      : (isNightArc ? '#8899cc' : '#F7931A');

    ctx.save();
    /* Outer glow halo — breathes with pulse */
    const haloR = 9 + pScale * 5;
    const grad = ctx.createRadialGradient(dotPt.x, dotPt.y, 1, dotPt.x, dotPt.y, haloR);
    grad.addColorStop(0, rimColor + 'cc');
    grad.addColorStop(1, rimColor + '00');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(dotPt.x, dotPt.y, haloR, 0, Math.PI * 2);
    ctx.fill();

    /* Core dot — fixed radius, brightness pulsed via globalAlpha */
    ctx.globalAlpha = 0.70 + 0.30 * pIntensity;
    ctx.beginPath();
    ctx.arc(dotPt.x, dotPt.y, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = rimColor;
    if (!isLight) { ctx.shadowBlur = 6 * pIntensity; ctx.shadowColor = rimColor; }
    ctx.fill();
    ctx.shadowBlur  = 0;
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // ── End global clip ────────────────────────────────────────
  ctx.restore();

  // ── FOOTER: start | duration | end ────────────────────────
  {
    const labelY    = cy + 5;
    const durY      = cy + 4;
    const labelColor = (typeof getPulseColor === 'function') ? getPulseColor() : '#F7931A';
    const startLbl  = isNightArc ? '🌇' : '🌅';
    const endLbl    = isNightArc ? '🌅' : '🌇';

    ctx.font = `bold 14px ${monoFont}`;

    ctx.fillStyle    = fg3;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${fmtTime12(arcStart)}${startLbl}`, 2, labelY);

    ctx.textAlign = 'right';
    ctx.fillText(`${endLbl}${fmtTime12(arcEnd)}`, W - 2, labelY);

    const durMin = Math.round(totalArcMs / 60000);
    ctx.font = `12px ${monoFont}`;
    ctx.fillStyle = fgDim;
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.floor(durMin/60)}h ${durMin%60}m`, cx, durY);
  }

  // ── Store last-draw geometry for tooltip hit-testing ─────
  _sbLastWedges  = wedges.slice();
  _sbLastHourly  = hourlyData;
  _sbLastCx      = cx;
  _sbLastCy      = cy;
  _sbLastBase    = base;
  _sbLastIsNight = isNightArc;
}


/* ============================================================
   SKYBOWL TOOLTIP — hit-test + event handlers
   ============================================================ */

function _sbHitTest(canvasX, canvasY) {
  // Convert canvas CSS pixels to polar coords using last-draw geometry
  const dx = canvasX - _sbLastCx;
  const dy = _sbLastCy - canvasY;   // flip Y — bowl opens upward
  const r  = Math.sqrt(dx * dx + dy * dy);

  // Must be inside the ribbon annulus (R 0.75..1.0)
  if (r < _sbLastBase * 0.73 || r > _sbLastBase * 1.04) return null;

  // Angle in standard math convention (0=East, increases CCW)
  let theta = Math.atan2(dy, dx);
  if (theta < 0) theta += Math.PI * 2;

  // Must be in upper hemisphere (0 < theta < PI)
  if (theta <= 0 || theta >= Math.PI) return null;

  // Find wedge containing this theta (wedges go from tA > tB, West→East)
  for (const w of _sbLastWedges) {
    if (theta <= w.tA && theta >= w.tB) return w;
  }
  return null;
}

function _sbBuildTooltipHTML(wedge) {
  const h = _sbLastHourly;
  if (!h || wedge.hdIdx === null) return null;
  const i = wedge.hdIdx;

  const tempF  = toF(h.temperature_2m[i]);
  const feelF  = h.apparent_temperature ? toF(h.apparent_temperature[i]) : tempF;
  const dewF   = toF(h.dew_point_2m[i]);
  const rh     = Math.round(h.relative_humidity_2m?.[i] ?? 0);
  const wind   = toMph(h.wind_speed_10m[i] ?? 0);
  const gust   = h.wind_gusts_10m ? toMph(h.wind_gusts_10m[i]) : null;
  const wd     = windDir(h.wind_direction_10m[i] ?? 0);
  const precip = h.precipitation[i] ?? 0;
  const prob   = h.precipitation_probability?.[i] ?? null;
  const cloud  = Math.round(h.cloud_cover[i] ?? 0);
  const uv     = h.uv_index?.[i] ?? 0;
  const code   = h.weather_code?.[i] ?? 0;
  const wInfo  = wmo(code);
  const isDay  = wedge.isDay;

  const timeLabel = (() => {
    const t = new Date(h.time[i]);
    return t.toLocaleTimeString('en-US', {
      timeZone: CONFIG.tz, hour: 'numeric', minute: '2-digit', hour12: true
    });
  })();

  const precipStr = precip > 0
    ? `${toIn(precip)}"${prob != null ? ' / ' + prob + '%' : ''}`
    : (prob != null && prob > 0 ? `— / ${prob}%` : '—');
  const gustStr = gust && gust > wind + 3 ? ` (gust ${gust})` : '';
  const comfortLbl = dewComfortEmoji(dewF);

  return `
    <span class="tt-time">${timeLabel} · ${getWeatherEmoji(code, !isDay)} ${wInfo.d}</span>
    <div class="tt-row"><span class="tt-label">temp</span><span class="tt-val">${tempF}°F / feels ${feelF}°F</span></div>
    <div class="tt-row"><span class="tt-label">dew / RH</span><span class="tt-val">${dewF}°F / ${rh}% ${comfortLbl}</span></div>
    <div class="tt-row"><span class="tt-label">wind</span><span class="tt-val">${wd.arrow} ${wind} mph${gustStr}</span></div>
    <div class="tt-row"><span class="tt-label">precip</span><span class="tt-val">${precipStr}</span></div>
    <div class="tt-row"><span class="tt-label">cloud</span><span class="tt-val">${cloud}%</span></div>
    ${(isDay && uv > 0) ? `<div class="tt-row"><span class="tt-label">UV</span><span class="tt-val">${uv}</span></div>` : ''}
  `;
}

function setupSkybowlTooltip() {
  const canvas  = document.getElementById('sun-arc-canvas');
  const tooltip = document.getElementById('skybowl-tooltip');
  const wrap    = document.getElementById('sun-arc-full');
  if (!canvas || !tooltip || !wrap) return;

  function getCanvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    const src  = e.touches ? e.touches[0] : e;
    return { x: src.clientX - rect.left, y: src.clientY - rect.top };
  }

  function showAt(canvasX, canvasY, wedge) {
    const html = _sbBuildTooltipHTML(wedge);
    if (!html) { tooltip.style.display = 'none'; return; }
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';

    // Position relative to #sun-arc-full
    const wrapRect   = wrap.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const absX = canvasRect.left - wrapRect.left + canvasX;
    const absY = canvasRect.top  - wrapRect.top  + canvasY;

    const ttW = tooltip.offsetWidth || 160;
    let left  = absX - ttW / 2;
    left = Math.max(4, Math.min(wrapRect.width - ttW - 4, left));
    tooltip.style.left = left + 'px';
    tooltip.style.top  = Math.max(0, absY - tooltip.offsetHeight - 8) + 'px';
  }

  canvas.addEventListener('mousemove', e => {
    // Don't let hover override a touch-locked tooltip
    if (_sbActiveWedge !== null) return;
    const { x, y } = getCanvasPos(e);
    const wedge = _sbHitTest(x, y);
    if (wedge) {
      showAt(x, y, wedge);
      canvas.style.cursor = 'crosshair';
    } else {
      tooltip.style.display = 'none';
      canvas.style.cursor = '';
    }
  });

  canvas.addEventListener('mouseleave', () => {
    // Don't hide a touch-locked tooltip on mouseleave
    if (_sbActiveWedge !== null) return;
    tooltip.style.display = 'none';
    canvas.style.cursor = '';
  });

  canvas.addEventListener('touchstart', e => {
    const { x, y } = getCanvasPos(e);
    const wedge = _sbHitTest(x, y);
    if (wedge) {
      e.preventDefault();
      _sbActiveWedge = wedge;
      showAt(x, y, wedge);
    }
  }, { passive: false });

  // touchend: do nothing — tooltip stays visible via _sbActiveWedge lock

  // Tap outside sun-arc-full → dismiss locked tooltip
document.addEventListener('touchstart', e => {
  if (_sbActiveWedge === null) return;

  const canvas = document.getElementById('sun-arc-canvas');
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const t = e.touches ? e.touches[0] : e;

  const x = t.clientX - rect.left;
  const y = t.clientY - rect.top;

  const wedge = _sbHitTest(x, y);

  // If NOT tapping a wedge → dismiss
  if (!wedge) {
    _sbActiveWedge = null;
    tooltip.style.display = 'none';
  }
}, { passive: true });

  document.addEventListener('click', e => {
    if (_sbActiveWedge === null) return;
    const arcFull = document.getElementById('sun-arc-full');
    if (arcFull && !arcFull.contains(e.target) && e.target !== tooltip && !tooltip.contains(e.target)) {
      _sbActiveWedge = null;
      tooltip.style.display = 'none';
    }
  });
}


/* ============================================================
   VIEW TOGGLE HELPERS
   ============================================================ */

/**
 * updateSkybowlWindowForView — synchronously compute arcStart/arcEnd
 * for the active nowSkyView and write to AppState.derived.skybowlWindow.
 */
function updateSkybowlWindowForView() {
  if (!AppState || !AppState.derived || !AppState.derived.sunTimes) return;
  const [srDt, ssDt] = AppState.derived.sunTimes;
  const data   = AppState.bm;
  const locNow = nowInTz(CONFIG.tz);
  const isCurrentlyDay = locNow >= srDt && locNow <= ssDt;
  const dayMs   = ssDt - srDt;
  const nightMs = 24 * 3600000 - dayMs;

  function dayWindow(i) {
    if (!data || !data.daily) return null;
    const sr = data.daily.sunrise?.[i] ? new Date(data.daily.sunrise[i]) : null;
    const ss = data.daily.sunset?.[i]  ? new Date(data.daily.sunset[i])  : null;
    return (sr && ss) ? { sr, ss } : null;
  }

  let arcStart, arcEnd, isNightW;
  const _nowSkyView = AppState.view.nowSkyView;

  if (_nowSkyView === 'current') {
    const isDayNow = locNow >= srDt && locNow <= ssDt;
    if (isDayNow) {
      arcStart = srDt; arcEnd = ssDt; isNightW = false;
    } else {
      if (locNow > ssDt) {
        arcStart = ssDt; arcEnd = new Date(ssDt.getTime() + nightMs);
      } else {
        arcStart = new Date(srDt.getTime() - nightMs); arcEnd = srDt;
      }
      isNightW = true;
    }
  } else if (_nowSkyView === 'other') {
    if (isCurrentlyDay) {
      arcStart = ssDt; arcEnd = new Date(ssDt.getTime() + nightMs); isNightW = true;
    } else {
      const w1 = dayWindow(1);
      if (w1) { arcStart = w1.sr; arcEnd = w1.ss; isNightW = false; }
      else    { arcStart = srDt;  arcEnd = ssDt;  isNightW = false; }
    }
  } else { // 'other2'
    if (isCurrentlyDay) {
      const w1 = dayWindow(1);
      if (w1) { arcStart = w1.sr; arcEnd = w1.ss; isNightW = false; }
      else    { arcStart = srDt;  arcEnd = ssDt;  isNightW = false; }
    } else {
      const w1 = dayWindow(1);
      if (w1) {
        const dm1 = w1.ss - w1.sr;
        const nm1 = 24 * 3600000 - dm1;
        arcStart = w1.ss; arcEnd = new Date(w1.ss.getTime() + nm1); isNightW = true;
      } else {
        arcStart = ssDt; arcEnd = new Date(ssDt.getTime() + nightMs); isNightW = true;
      }
    }
  }

  // Write to AppState.derived.skybowlWindow (replaces window._skybowlStart/End/IsNight)
  AppState.derived.skybowlWindow = { start: arcStart, end: arcEnd, isNight: isNightW };
}

function updateNowSkyButtons(isCurrentlyDay) {
  const btns = document.querySelectorAll('#now-sky-btns .range-btn');
  if (btns.length < 3) return;
  if (isCurrentlyDay) {
    btns[0].textContent = 'DAYLIGHT';
    btns[1].textContent = 'TONIGHT';
    btns[2].textContent = 'NEXT DAY';
  } else {
    btns[0].textContent = 'TONIGHT';
    btns[1].textContent = 'DAYBREAK';
    btns[2].textContent = 'NEXT NIGHT';
  }
}

/**
 * redrawNowSky — redraw the Skybowl for the currently active view.
 * Sets window._overrideNow temporarily for non-current views.
 */
function redrawNowSky() {
  if (!AppState || !AppState.derived || !AppState.derived.sunTimes) return;
  const [srDt, ssDt] = AppState.derived.sunTimes;
  const cloud  = AppState.derived.cloudPct     ?? 0;
  const emoji  = AppState.derived.weatherEmoji ?? '☀️';
  const hourly = AppState.bm.hourly            ?? null;
  const data   = AppState.bm;

  const locNow         = nowInTz(CONFIG.tz);
  const isCurrentlyDay = locNow >= srDt && locNow <= ssDt;
  const dayMs          = ssDt - srDt;
  const nightMs        = 24 * 3600000 - dayMs;

  function dayWindow(i) {
    if (!data || !data.daily) return null;
    const sr = data.daily.sunrise?.[i] ? new Date(data.daily.sunrise[i]) : null;
    const ss = data.daily.sunset?.[i]  ? new Date(data.daily.sunset[i])  : null;
    if (!sr || !ss) return null;
    const e = data.daily.weather_code?.[i] != null ? wmo(data.daily.weather_code[i]).e : emoji;
    return { sr, ss, emoji: e };
  }

  const _nowSkyView = AppState.view.nowSkyView;

  if (_nowSkyView === 'current') {
    drawSkybowl(srDt, ssDt, cloud, emoji, hourly);

  } else if (_nowSkyView === 'other') {
    if (isCurrentlyDay) {
      window._overrideNow = new Date(ssDt.getTime() + 1000);
      drawSkybowl(srDt, ssDt, cloud, '🌙', hourly);
      window._overrideNow = null;
    } else {
      const w1 = dayWindow(1);
      if (w1) {
        window._overrideNow = new Date(w1.sr.getTime() + (w1.ss - w1.sr) / 2);
        drawSkybowl(w1.sr, w1.ss, cloud, w1.emoji, hourly);
        window._overrideNow = null;
      } else {
        drawSkybowl(srDt, ssDt, cloud, emoji, hourly);
      }
    }

  } else { // 'other2'
    if (isCurrentlyDay) {
      const w1 = dayWindow(1);
      if (w1) {
        window._overrideNow = new Date(w1.sr.getTime() + (w1.ss - w1.sr) / 2);
        drawSkybowl(w1.sr, w1.ss, cloud, w1.emoji, hourly);
        window._overrideNow = null;
      } else {
        drawSkybowl(srDt, ssDt, cloud, emoji, hourly);
      }
    } else {
      const w1 = dayWindow(1);
      if (w1) {
        window._overrideNow = new Date(w1.ss.getTime() + 1000);
        drawSkybowl(w1.sr, w1.ss, cloud, '🌙', hourly);
        window._overrideNow = null;
      } else {
        drawSkybowl(srDt, ssDt, cloud, '🌙', hourly);
      }
    }
  }
}
