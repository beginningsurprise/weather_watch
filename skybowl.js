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

function cloudSliceColor(cldPct, isNight) {
  const f = Math.max(0, Math.min(100, cldPct)) / 100;

  if (isNight) {
    const r = Math.round(15  + f * 85);
    const g = Math.round(25  + f * 75);
    const b = Math.round(70  + f * 40);
    const a = (0.50 + f * 0.45).toFixed(2);
    return `rgba(${r},${g},${b},${a})`;
  }

  if (isSkinTerminal()) {
    if (f < 0.3) {
      const a = (0.08 + f * 0.60).toFixed(2);
      return `rgba(0, 255, 65, ${a})`;
    } else {
      const t = (f - 0.3) / 0.7;
      const r = Math.round(0   + t * 210);
      const g = Math.round(200 + t * 15);
      const b = Math.round(65  + t * 150);
      const a = (0.26 + t * 0.64).toFixed(2);
      return `rgba(${r},${g},${b},${a})`;
    }
  }

  // canonical skin: realistic sky-to-cloud gradient
  if (f <= 0.20) {
    const t = f / 0.20;
    const sr=64,  sg=128, sb=255;
    const er=176, eg=184, eb=196;
    return `rgb(${Math.round(sr+(er-sr)*t)},${Math.round(sg+(eg-sg)*t)},${Math.round(sb+(eb-sb)*t)})`;
  } else if (f <= 0.70) {
    const t = (f - 0.20) / 0.50;
    const sr=176, sg=184, sb=196;
    const er=148, eg=154, eb=162;
    return `rgb(${Math.round(sr+(er-sr)*t)},${Math.round(sg+(eg-sg)*t)},${Math.round(sb+(eb-sb)*t)})`;
  } else {
    const t = (f - 0.70) / 0.30;
    const sr=148, sg=154, sb=162;
    const er=90,  eg=95,  eb=102;
    return `rgb(${Math.round(sr+(er-sr)*t)},${Math.round(sg+(eg-sg)*t)},${Math.round(sb+(eb-sb)*t)})`;
  }
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
	
    const comfortEmoji = (AppState && AppState.derived && AppState.derived.comfortEmoji)
      ? AppState.derived.comfortEmoji : '🙂';
    if (anemEl) {
      anemEl.style.left = `${cx - base * 1.1}px`;
      anemEl.style.top  = `${cy - base * 0.95}px`;
    }

    if (locEl) {
		locEl.style.position = 'absolute';
		locEl.style.left = `${cx}px`;
		locEl.style.top  = `${cy - base * 0.2}px`;
		locEl.style.transform = 'translate(-50%, -50%)';
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

    for (let tMs = firstStepMs; tMs <= arcEndMs; tMs += 3600000) {
      const key   = toKey(tMs);
      const hdIdx = hdIndex.get(key);
      if (hdIdx === undefined) continue;
      const tNorm = (tMs - arcStartMs) / totalArcMs;
      hourSlots.push({
        tMs,
        tNorm,
        theta: Math.PI * (1 - tNorm),
        hdIdx,
        isDay: hourlyData.is_day[hdIdx] === 1,
      });
    }
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
        const color = cloudSliceColor(cld, !firstSlot.isDay);
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
        const color = cloudSliceColor(cld, !slot.isDay);

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

			  const pulseColor = getComputedStyle(document.body)
				.getPropertyValue('--pulse-color')
				.trim() || '#1a7fd4';

			  ctx.save();

			  ctx.beginPath();

			  // Outer arc
			  ctx.arc(cx, cy, base * 1.0, -tA, -tB, false);

			  // Inner arc (reverse direction)
			  ctx.arc(cx, cy, base * 0.75, -tB, -tA, true);

			  ctx.closePath();

			  ctx.strokeStyle = pulseColor;
			  ctx.lineWidth = 1.5 + 2 * pIntensity;
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
        const color = cloudSliceColor(cld, !lastSlot.isDay);
        wedges.push({ tA, tB, midTheta: (tA + tB) / 2, cld, hdIdx: lastSlot.hdIdx, tNorm: 1, isDay: lastSlot.isDay });
        drawWedge(ctx, cx, cy, base, 0.75, 1.0, tA, tB, color);
      }
    }
  }

  // ── LAYER 3: THE RIM ───────────────────────────────────────
  {
    const rimColor = isNightArc
      ? (isSkinCanonical() ? '#8899bb' : '#9999cc')
      : (isSkinCanonical() ? '#d4900a' : '#c8a820');
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
      const aL      = Math.max(4, Math.min(11, mph * 0.20));

      const arrowColor = isNightArc
        ? 'rgba(160,185,245,0.80)'
        : (isSkinCanonical() ? 'rgba(40,100,200,0.80)' : 'rgba(0,220,80,0.80)');

      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate((windDeg - 180) * Math.PI / 180);
      ctx.strokeStyle = arrowColor;
      ctx.lineWidth   = 1.2;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.beginPath(); ctx.moveTo(0, aL * 0.35); ctx.lineTo(0, -aL); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-aL * 0.38, -aL * 0.4); ctx.lineTo(0, -aL); ctx.lineTo(aL * 0.38, -aL * 0.4);
      ctx.stroke();
      ctx.restore();

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
		ctx.fillStyle = 'rgba(255,255,255,1)';
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
      const pt = sbPoint(midTheta, 1.12, cx, cy, base);
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
      const hr       = new Date(slot.tMs).getHours();
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

      const strokeStyle = isSkinCanonical()
        ? `rgba(80,120,200,${alpha})`
        : `rgba(${isNightArc ? '170,180,230' : '0,230,80'},${alpha})`;

      ctx.save();
      ctx.strokeStyle = strokeStyle;
      if (isPrimaryAxis || isSecondaryAxis) {
        const pOuter = sbPoint(slot.theta, 1.0, cx, cy, base);
        ctx.lineWidth   = baseLineWidth;
        ctx.globalAlpha = isPrimaryAxis ? alpha * 1.25 : alpha;
        ctx.beginPath();
        ctx.moveTo(pOuter.x, pOuter.y);
        ctx.lineTo(cx, cy);
      } else {
        ctx.lineWidth = baseLineWidth;
        ctx.beginPath();
        ctx.moveTo(tI.x, tI.y);
        ctx.lineTo(tO.x, tO.y);
      }
      ctx.stroke();
      ctx.restore();

      if (isEvery3) {
        const label = String(hr).padStart(2, '0');
        const lPt   = sbPoint(slot.theta, 1.215, cx, cy, base);
        if (lPt.x >= 3 && lPt.x <= W - 3 && lPt.y >= -4 && lPt.y <= cy - 2) {
          ctx.save();
          ctx.font = `bold 11px ${monoFont}`;
          ctx.fillStyle = isNightArc
            ? `rgba(190,200,240,${isPast ? 0.90 : 0.65})`
            : (isSkinCanonical()
              ? `rgba(50,90,170,${isPast ? 0.90 : 0.65})`
              : `rgba(180,220,180,${isPast ? 0.90 : 0.65})`);
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
      const emojiStr = (isNightArc && code === 0) ? '🌙' : info.e;
      const eSize    = isNowSlot ? 20 : 13;
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
    const rimColor   = isNightArc
      ? '#8899cc'
      : (isSkinCanonical() ? '#d4900a' : '#e0b820');

    ctx.save();
    /* Outer glow halo — breathes with pulse */
    const haloR = 6 + pScale * 3.5;
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
    ctx.arc(dotPt.x, dotPt.y, 3.5, 0, Math.PI * 2);
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
    const labelColor = isSkinCanonical() ? '#3a6aaa' : fg3;
    const startLbl  = isNightArc ? '🌇' : '🌅';
    const endLbl    = isNightArc ? '🌅' : '🌇';

    ctx.font = `11px ${monoFont}`;

    ctx.fillStyle    = labelColor;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${fmtTime12(arcStart)}${startLbl}`, 2, labelY);

    ctx.textAlign = 'right';
    ctx.fillText(`${endLbl}${fmtTime12(arcEnd)}`, W - 2, labelY);

    const durMin = Math.round(totalArcMs / 60000);
    ctx.fillStyle = fgDim;
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.floor(durMin/60)}h ${durMin%60}m`, cx, durY);
  }
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
    btns[0].textContent = 'TODAY';
    btns[1].textContent = 'TONIGHT';
    btns[2].textContent = 'TOMORROW';
  } else {
    btns[0].textContent = 'TONIGHT';
    btns[1].textContent = 'TOMORROW';
    btns[2].textContent = 'TMRW NIGHT';
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
