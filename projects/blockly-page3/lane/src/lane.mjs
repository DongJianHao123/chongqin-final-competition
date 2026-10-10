import {findBranches} from './branch.mjs';
import {detectIntersection} from './intersection.mjs';
import {MIN_MOVING_SPEED} from './follow_config.mjs';
// HSV yellow detector; 320x240 input, 317x112 ROI, original error units.
export function detect(rgba) {
  const mask = new Uint8Array(317 * 112);
  const yellowEvidence = new Uint8Array(mask.length);
  for (let y = 0; y < 112; y++) for (let x = 0; x < 317; x++) {
    const i = ((126 + y) * 320 + x + 1) * 4;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const s = max === 0 ? 0 : Math.round(d * 255 / max);
    let h = 0;
    if (d !== 0) {
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
      if (h < 0) h += 360;
      h = Math.round(h / 2);
    }
    // Keep desaturated yellow under glare, but exclude yellow-green grass.
    // H is half the hue angle; the former upper bound 40 included 80° green.
    const yellow = h >= 15 && h <= 33 && s >= 25 && max >= 60;
    mask[y * 317 + x] = yellow ? 1 : 0;
    // Pale highlights can help trace a line, but cannot establish a junction
    // on their own. Warm plastic and white edges also enter the loose mask.
    yellowEvidence[y * 317 + x] = yellow && s >= 60 ? 1 : 0;
  }
  const clean = new Uint8Array(mask.length);
  const cleanEvidence = new Uint8Array(mask.length);
  for (let y = 1; y < 111; y++) for (let x = 1; x < 316; x++) {
    let n = 0, evidence = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      n += mask[(y+dy)*317+x+dx];
      evidence += yellowEvidence[(y+dy)*317+x+dx];
    }
    clean[y*317+x] = n >= 5 ? 1 : 0;
    cleanEvidence[y*317+x] = evidence >= 5 ? 1 : 0;
  }
  // Parse once. A wide run is only crossbar evidence, not proof of an intersection.
  const rows = new Map(), wideRows = [];
  for (let y = 106; y >= 1; y -= 5) {
    const segments = [];
    for (let x = 0; x < 317;) {
      if (!clean[y*317+x]) { x++; continue; }
      const start = x++;
      while (x < 317 && (clean[y*317+x] || (x+2 < 317 && clean[y*317+x+1] && clean[y*317+x+2]))) x++;
      const width = x - start;
      if (width > 120) wideRows.push({y, start, end:x-1});
      else if (width >= 3) segments.push({mid:(start+x-1)/2, width});
    }
    rows.set(y, segments);
  }
  function trace(seed = null) {
    const pts = seed ? [[seed.y, seed.x]] : [];
    let previous = seed ? seed.x : 158, previousY = seed ? seed.y : 111;
    let previousSegment = seed ? rows.get(seed.y).find(segment => segment.mid === seed.x) : null;
    let slope = 0, misses = 0;
    for (let y = seed ? seed.y-5 : 106; y >= 1; y -= 5) {
      const predicted = previous + slope * (previousY-y), maxWidth = 12+y*0.45;
      let best = null, bestScore = Infinity;
      for (const segment of rows.get(y)) {
        const {mid, width} = segment;
        const delta = Math.abs(mid-predicted);
        let limit = Math.min(50, 12+(previousY-y)*1.3+misses*8);
        // Perspective and glare can move the centre of a broad bottom run
        // farther than the narrow-line limit. The next-row check below still
        // rejects an isolated patch at this first transition.
        if (pts.length === 1 && y >= 86 && width <= maxWidth+8) limit = Math.min(35,limit+12);
        const overlap = previousSegment && previousY-y === 5 ?
          Math.min(mid+width/2,previousSegment.mid+previousSegment.width/2)-
          Math.max(mid-width/2,previousSegment.mid-previousSegment.width/2) : 0;
        const connected = previousSegment && width <= maxWidth+8 &&
          previousSegment.width <= 12+previousY*.45+8 && delta <= 35 &&
          overlap >= Math.max(6,Math.min(width,previousSegment.width)*.25);
        if (pts.length && delta > limit && !connected) continue;
        let score = delta - (width <= maxWidth ? Math.min(width,20)*0.2 : 0) + (width > maxWidth ? 4 : 0);
        if (pts.length === 1 && y >= 6) {
          // At the first transition two yellow patches can be equally near
          // the bottom seed. Prefer the one that continues to the next row;
          // a local reflection otherwise determines the entire trace.
          const next = rows.get(y-5);
          if (next.length) {
            const heading = Math.max(-2, Math.min(2, (mid-previous)/(previousY-y)));
            const projected = mid + heading*5;
            const continuation = Math.min(...next.map(segment => Math.abs(segment.mid-projected)));
            score += Math.min(25, continuation*.8);
          }
        }
        if (score < bestScore) { best = segment; bestScore = score; }
      }
      if (best !== null) {
        if (pts.length) slope = Math.max(-2, Math.min(2, (best.mid-previous)/(previousY-y)));
        pts.push([y,best.mid]); previous = best.mid; previousY = y;
        previousSegment = best; misses = 0;
      } else if (pts.length) {
        // Recovery candidates must have continuous real support, unlike normal tracking.
        if (seed) break;
        misses++;
        // Do not stitch a foreground fragment to distant warm highlights.
        // Only a visible crossbar can justify several missing centre rows,
        // and that bridge stays within the existing 40-pixel recovery span.
        const crossbar = wideRows.some(row => row.y === y && row.start <= predicted && predicted <= row.end);
        if (previousY-y > 40 || misses >= 2 && !crossbar) break;
        if (misses >= 2) { slope = 0; previous = pts.at(-1)[1]; }
      }
    }
    return pts;
  }
  let centers = trace();
  const initialNear = centers.filter(([y]) => y >= 86 && y <= 106);
  const initialMeanY = initialNear.reduce((sum,p)=>sum+p[0],0)/initialNear.length;
  const initialMeanX = initialNear.reduce((sum,p)=>sum+p[1],0)/initialNear.length;
  const initialVarianceY = initialNear.reduce((sum,p)=>sum+(p[0]-initialMeanY)**2,0);
  const initialSlope = initialNear.length >= 4 ? initialNear.reduce((sum,p)=>
    sum+(p[0]-initialMeanY)*(p[1]-initialMeanX),0)/initialVarianceY : 0;
  const initialResidual = initialNear.length >= 4 ? Math.max(...initialNear.map(([y,x])=>
    Math.abs(x-initialMeanX-initialSlope*(y-initialMeanY)))) : Infinity;
  if ((initialNear.length < 4 || initialResidual > 6) && rows.get(106).length > 1) {
    const alternatives = rows.get(106).filter(seg => seg.width <= 12 + 106*.45 + 8)
      .map(seg => {
        const pts = trace({y:106, x:seg.mid});
        const near = pts.filter(([y]) => y >= 86);
        if (pts.length < 5 || near.length < 5) return null;
        const meanY = near.reduce((sum,p)=>sum+p[0],0)/near.length;
        const meanX = near.reduce((sum,p)=>sum+p[1],0)/near.length;
        const varianceY = near.reduce((sum,p)=>sum+(p[0]-meanY)**2,0);
        const slope = near.reduce((sum,p)=>sum+(p[0]-meanY)*(p[1]-meanX),0)/varianceY;
        const residual = Math.max(...near.map(([y,x])=>Math.abs(x-meanX-slope*(y-meanY))));
        return residual <= 6 ? {pts,nearCount:near.length,residual} : null;
      }).filter(Boolean).sort((a,b)=>b.nearCount-a.nearCount || a.residual-b.residual || b.pts.length-a.pts.length);
    // An ambiguous bottom seed can point into a reflection for 2-3 rows.
    // Switch only when one alternative has a longer, coherent near stem.
    if (alternatives.length &&
        (alternatives.length === 1 || alternatives[0].nearCount >= alternatives[1].nearCount+2)) {
      centers = alternatives[0].pts;
    }
  }
  const inferredCenters = [];
  let recoveredBottom = false;
  const hasSupport = pts => pts.length >= 6 && pts[0][0] >= 75 && pts[0][0]-pts.at(-1)[0] >= 30;
  // Local fallback only: a bottom crossbar and failed normal path. No temporal
  // blind driving; no change to successful normal paths or to motor control.
  if (!hasSupport(centers) && wideRows.some(r => r.y === 106)) {
    for (let seedY = 101; seedY >= 86; seedY -= 5) {
      if (!rows.get(seedY).length) continue;
      const candidates = [];
      for (const seg of rows.get(seedY)) {
        if (seg.width > 12+seedY*0.45+8) continue;
        const pts = trace({y:seedY, x:seg.mid});
        if (pts.length < 7) continue;
        // Fit only the nearest five observed points, x = xMean + slope*(y-yMean).
        const fit = pts.slice(0,5);
        const ym = fit.reduce((s,p)=>s+p[0],0)/5, xm = fit.reduce((s,p)=>s+p[1],0)/5;
        const slope = fit.reduce((s,p)=>s+(p[0]-ym)*(p[1]-xm),0) / fit.reduce((s,p)=>s+(p[0]-ym)**2,0);
        const residual = Math.max(...fit.map(([y,x])=>Math.abs(x-(xm+slope*(y-ym)))));
        if (Math.abs(slope) > 1 || residual > 2.5) continue;
        const fill = [];
        for (let y = seedY+5; y <= 106; y += 5) {
          const x = xm+slope*(y-ym);
          if (x < 1 || x > 315 || !wideRows.some(r=>r.y===y && r.start<=x && x<=r.end)) break;
          fill.push([y,x]);
        }
        if (fill.length !== (106-seedY)/5) continue;
        candidates.push({pts, fill, residual});
      }
      candidates.sort((a,b)=>b.pts.length-a.pts.length || a.residual-b.residual);
      // Ambiguous straight branches are not resolved by an arbitrary center bias.
      if (candidates.length && (candidates.length === 1 || candidates[0].pts.length >= candidates[1].pts.length+3)) {
        centers = candidates[0].pts;
        inferredCenters.push(...candidates[0].fill);
        recoveredBottom = true;
      }
      // Never skip a trackable row to hunt for an unrelated distant candidate.
      break;
    }
  }
  const observedCount = centers.length;
  const observedSupport = hasSupport(centers);
  // Keep the steering reference at fixed rows near the car. The legacy error
  // below averages a fraction of the visible trace; its sample rows jump when
  // a distant bend enters or leaves the image, even if the near line is still.
  const nearObserved = centers.filter(([y]) => y >= 86 && y <= 106);
  let nearCount = nearObserved.length;
  let nearSlope = null, nearError = null, nearResidual = null, nearModel = null,
    nearContinuity = null;
  const threeBottomRows = nearObserved.length === 3 &&
    nearObserved.every(([y], i) => y === 106 - i*5);
  if (nearObserved.length >= 4 || threeBottomRows) {
    const fitNear = points => {
      const meanY = points.reduce((sum, point) => sum + point[0], 0) / points.length;
      const meanX = points.reduce((sum, point) => sum + point[1], 0) / points.length;
      const varianceY = points.reduce((sum, point) => sum + (point[0] - meanY) ** 2, 0);
      const slope = points.reduce((sum, point) =>
        sum + (point[0] - meanY) * (point[1] - meanX), 0) / varianceY;
      const residual = Math.max(...points.map(([y,x])=>
        Math.abs(x-meanX-slope*(y-meanY))));
      return {slope, residual, x:meanX+slope*(96-meanY)};
    };
    let fit = fitNear(nearObserved);
    nearModel = 'linear';
    // Five consecutive real rows can also describe a smooth bend. Fit a
    // quadratic in t=(y-96)/5, keeping the same reference row and rejecting
    // jagged traces by their residual instead of requiring the road be straight.
    if (fit.residual > 3 && nearObserved.length === 5 &&
        nearObserved.every(([y], i) => y === 106-i*5)) {
      const xs = nearObserved.map(point => point[1]);
      const a = (2*xs[0]-xs[1]-2*xs[2]-xs[3]+2*xs[4])/14;
      const b = (2*xs[0]+xs[1]-xs[3]-2*xs[4])/10;
      const c = (-3*xs[0]+12*xs[1]+17*xs[2]+12*xs[3]-3*xs[4])/35;
      const residual = Math.max(...xs.map((x,i)=>Math.abs(x-(a*(2-i)**2+b*(2-i)+c))));
      const deltas = xs.slice(1).map((x,i)=>x-xs[i]);
      const coherent = deltas.every(delta=>delta>=-2) || deltas.every(delta=>delta<=2);
      if (residual <= 4 && coherent) { fit = {slope:b/5,residual,x:c}; nearModel = 'curve'; }
    }
    // A genuine bend can start at y=86 while the four closer rows remain
    // straight. Use that contiguous local stem only when all four real rows
    // exist and fit tightly; never drop an arbitrary bad point or extrapolate
    // from a fragment. The steering reference stays inside the stem at y=96.
    if (fit.residual > 6 && nearObserved.length === 5 &&
        nearObserved.slice(0,4).every(([y], i) => y === 106-i*5)) {
      const closer = fitNear(nearObserved.slice(0,4));
      if (closer.residual <= 3) { fit = closer; nearCount = 4; nearModel = 'local_linear'; }
    }
    if (fit.residual > 6 && nearObserved.length === 5 &&
        nearObserved.every(([y],i)=>y===106-i*5)) {
      const segments = nearObserved.map(([y,x])=>rows.get(y).find(seg=>seg.mid===x));
      const overlaps = segments.slice(1).map((seg,i)=>seg && segments[i] ?
        Math.min(seg.mid+seg.width/2,segments[i].mid+segments[i].width/2)-
        Math.max(seg.mid-seg.width/2,segments[i].mid-segments[i].width/2) : -Infinity);
      const connected = segments.every((seg,i)=>seg && seg.width <= 12+nearObserved[i][0]*.45+8 &&
        (!i || overlaps[i-1] >= Math.max(6,Math.min(seg.width,segments[i-1].width)*.25)));
      const local = fitNear(nearObserved.slice(0,3));
      if (connected && local.residual <= 2) {
        fit = {slope:local.slope,residual:local.residual,x:nearObserved[2][1]};
        nearModel = 'connected';
      } else if (connected && observedCount >= 8 &&
                 Math.max(...nearObserved.slice(1).map(([,x],i)=>
                   Math.abs(x-nearObserved[i][1]))) <= 28) {
        // The centre at y=96 is directly observed. Keep it when a short bend
        // or glare makes a single-line fit invalid, provided all five nearby
        // colour runs form one overlapping stem. Two fresh frames must still
        // agree before the step controller may move.
        nearModel = 'connected_row';
        nearContinuity = Math.min(...overlaps);
      } else if (observedCount >= 8 && segments.slice(0,3).every(Boolean) &&
                 overlaps.slice(0,2).every((overlap,i)=>overlap >=
                   Math.max(6,Math.min(segments[i].width,segments[i+1].width)*.25))) {
        // A stripe can hide the continuation while the three closest rows
        // remain one visible yellow stem. Report only that limited support so
        // the step controller permits at most two short moves before holding.
        nearModel = 'bottom_three';
        nearCount = 3;
        nearContinuity = Math.min(...overlaps.slice(0,2));
      }
    }
    nearSlope = fit.slope;
    nearResidual = fit.residual;
    // Evaluate the fit at one fixed row even when one observed row is missing.
    // Averaging the remaining rows moves the reference along a steep line.
    if (nearResidual <= (threeBottomRows ? 3 : 6))
      nearError = (fit.x-158.5)*2;
    else if (nearModel === 'connected_row' || nearModel === 'bottom_three')
      nearError = (nearObserved[2][1]-158.5)*2;
  }
  // A tilted crossbar can itself win the steering trace's centre-biased seed.
  // Inspect other observed bottom stems for junction evidence only; this does
  // not change the selected steering path or authorize driving without a line.
  const stems = rows.get(106).filter(s => s.width <= 60)
    .map(s => trace({y:106, x:s.mid}));
  const transverse = detectIntersection(clean, centers, stems, cleanEvidence);
  const branches = findBranches(clean, cleanEvidence);
  // A fork is a junction even when neither arm forms a transverse stripe.
  // Prefer its connected root over a line fit through just one shallow arm.
  const intersection = branches.point ? {...branches.point, kind:'fork'}
    : transverse ? {...transverse, kind:'transverse'} : null;
  // Existing two-sided crossbar bridge; use the longitudinal path, not bar midpoint.
  const bridged = [];
  for (let i = 0; i+1 < centers.length; i++) {
    const [y0,x0] = centers[i], [y1,x1] = centers[i+1], gap = y0-y1;
    if (gap <= 5 || gap > 40 || i < 1 || i+2 >= centers.length) continue;
    const fill = [];
    for (let y = y0-5; y > y1; y -= 5) {
      const x = x0+(x1-x0)*(y0-y)/gap;
      if (!wideRows.some(r=>r.y===y && r.start<=x && x<=r.end)) { fill.length = 0; break; }
      fill.push([y,x]);
    }
    bridged.push(...fill);
  }
  inferredCenters.push(...bridged);
  centers.push(...inferredCenters);
  centers.sort((a,b)=>b[0]-a[0]);
  let nearPixels = 0;
  for (let y = 75; y < 112; y++) for (let x = 0; x < 317; x++) nearPixels += clean[y*317+x];
  let error = null;
  if (observedSupport && nearPixels >= 100) {
    const threshold = centers[0][0]-(centers[0][0]-centers.at(-1)[0])/3;
    const near = centers.filter(p=>p[0]>=threshold);
    error = (near.reduce((s,p)=>s+p[1],0)/near.length-158.5)*2;
  }
  return {branches, error, nearError, nearSlope, nearResidual, nearCount, nearModel,
    nearContinuity,
    centers, crossing: intersection !== null, intersection,
    confidence: error === null ? 0 : observedCount/22,
    observedCount, inferredCenters, recoveredBottom};
}

// Shift rounded driving targets together to clear the motor's 0..20 dead zone.
// Preserve their difference until the faster wheel reaches the API's maximum.
export function speeds(error, previous, dt, params = {base:24, kp:0.05, kd:0, maxCorrection:2}) {
  if (!Number.isFinite(error) || params.base === 0) return {left: 0, right: 0};
  // Match board PD: per processed frame, not per second. dt is retained for API compatibility.
  const derivative = previous === null ? 0 : error - previous;
  const correction = Math.max(-params.maxCorrection, Math.min(params.maxCorrection, params.kp * error + params.kd * derivative));
  const left = Math.round(params.base + correction), right = Math.round(params.base - correction);
  const lift = Math.max(0, MIN_MOVING_SPEED - Math.min(left, right));
  return {left: Math.min(100, left + lift), right: Math.min(100, right + lift)};
}
