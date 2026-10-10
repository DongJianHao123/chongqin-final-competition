// Independent crossbar geometry on the shared 317 x 112 yellow mask.
// Coordinates, including the returned intersection, are relative to the ROI.
export function detectIntersection(mask, observedCenters, alternativeTracks = [], yellowEvidence = mask) {
  const width = 317, height = 112, samples = [];
  const nearStem = observedCenters.filter(([y])=>y>=86 && y<=106);
  let nearHeading = null;
  if (nearStem.length >= 4) {
    const ym = nearStem.reduce((sum,p)=>sum+p[0],0)/nearStem.length;
    const xm = nearStem.reduce((sum,p)=>sum+p[1],0)/nearStem.length;
    const variance = nearStem.reduce((sum,p)=>sum+(p[0]-ym)**2,0);
    const heading = nearStem.reduce((sum,p)=>sum+(p[0]-ym)*(p[1]-xm),0)/variance;
    const residual = Math.max(...nearStem.map(([y,x])=>Math.abs(x-xm-heading*(y-ym))));
    if (residual <= 6) nearHeading = heading;
  }
  // A near T junction has no far-side continuation. Sample the short incoming
  // stem at pixel spacing so it can still anchor a point near the image edge.
  // These points are only used for near junction geometry, not line steering.
  const nearRows=[];
  for(let y=110;y>=80;y--){
    const runs=[];
    for(let x=1;x<316;){
      if(!mask[y*width+x]){x++;continue;}
      const lo=x++;while(x<316&&mask[y*width+x])x++;
      if(x-lo>=3&&x-lo<=60)runs.push({lo,hi:x-1,x:(lo+x-1)/2});
    }
    nearRows.push(runs);
  }
  const nearTracks=nearRows[0].map(root=>{
    let prev=root;const points=[[110,root.x]];
    for(let i=1;i<nearRows.length;i++){
      const next=nearRows[i].filter(r=>Math.max(r.lo-prev.hi,prev.lo-r.hi)<=1&&Math.abs(r.x-prev.x)<=3)
        .sort((a,b)=>Math.abs(a.x-prev.x)-Math.abs(b.x-prev.x))[0];
      if(!next)break;
      points.push([110-i,next.x]);prev=next;
    }
    return points;
  }).filter(points=>points.length>=6);
  // Column runs describe a thin transverse stripe, including tilted stripes.
  // A broad yellow patch or the longitudinal track is not a crossbar sample.
  for (let x = 2; x < width - 2; x += 4) {
    for (let y = 1; y < height - 1;) {
      if (!mask[y * width + x]) { y++; continue; }
      const start = y++;
      while (y < height - 1 && mask[y * width + x]) y++;
      const mid = (start + y - 1) / 2, thickness = y - start;
      if (thickness >= 2 && thickness <= Math.min(34, 9 + mid * .23))
        samples.push({x, y: mid, thickness});
    }
  }
  const candidates = [];
  for (let slope = -.6; slope <= .601; slope += .05) {
    const bins = new Map();
    for (const p of samples) {
      const intercept = Math.round((p.y - slope * (p.x - 158)) / 4) * 4;
      if (intercept < 8 || intercept > 108) continue;
      const group = bins.get(intercept) || [];
      group.push(p); bins.set(intercept, group);
    }
    for (const [intercept, points] of bins) {
      if (points.length >= 12) candidates.push({slope, intercept, points});
    }
  }
  candidates.sort((a, b) => b.points.length - a.points.length);
  for (const {slope, intercept} of candidates) {
    // Include neighbouring accumulator bins; otherwise a mildly curved or
    // quantized stripe can lose an entire arm at a bin boundary.
    const columns = new Map();
    for (const p of samples) {
      const residual = Math.abs(p.y - intercept - slope * (p.x - 158));
      if (residual > 4) continue;
      const previous = columns.get(p.x);
      if (!previous || residual < previous.residual) columns.set(p.x, {...p, residual});
    }
    const points = [...columns.values()];
    const thickness = points.reduce((s, p) => s + p.thickness, 0) / points.length;
    for (const track of [observedCenters, ...alternativeTracks, ...(intercept>=80?nearTracks:[])]) {
      // Only real near-side track points support an intersection. No bridge or
      // far-side continuation is needed, and extrapolation stays local.
      const dense=nearTracks.includes(track);
      let near = track.filter(([y, x]) => {
        const d = y - (intercept + slope * (x - 158));
        return d > thickness / 2 + 4 && d < 65;
      }).slice(dense?-8:-6);
      // At the image bottom the near-side track has left the image. A short,
      // observed far-side continuation can still anchor the visible crossbar.
      let farSide = false;
      if (near.length < 4 && intercept >= 75) {
        near = track.filter(([y, x]) => {
          const d = intercept + slope * (x - 158) - y;
          return d > thickness / 2 + 4 && d < 65;
        }).slice(0, 6);
        farSide = true;
      }
      // A bend can itself form a long stripe and borrow a different stem to
      // appear transverse. Check the actual incoming heading for either side;
      // a stripe running along that line cannot prove a crossbar.
      if (nearHeading !== null &&
          Math.abs(1-slope*nearHeading)/Math.hypot(1,slope)/Math.hypot(1,nearHeading) < .5) continue;
      if (near.length < 4 || near[0][0] - near.at(-1)[0] < (dense?5:15)) continue;
      const ym = near.reduce((s, p) => s + p[0], 0) / near.length;
      const xm = near.reduce((s, p) => s + p[1], 0) / near.length;
      const variance = near.reduce((s, p) => s + (p[0] - ym) ** 2, 0);
      const heading = near.reduce((s, p) => s + (p[0] - ym) * (p[1] - xm), 0) / variance;
      if (Math.max(...near.map(([y, x]) => Math.abs(x - xm - heading * (y - ym)))) > 8) continue;
      const denominator = 1 - slope * heading;
      if (Math.abs(denominator) / Math.hypot(1, slope) / Math.hypot(1, heading) < .5) continue;
      const y = (intercept + slope * (xm - heading * ym - 158)) / denominator;
      const x = xm + heading * (y - ym);
      const distance = farSide ? y - near[0][0] : near.at(-1)[0] - y;
      if (y < 28 || y > 108 || x < 20 || x > 297 || distance > 35) continue;
      const arm = 22 + y * .18;
      const left = points.filter(p => p.x < x - arm / 2);
      const right = points.filter(p => p.x > x + arm / 2);
      if (left.length < 5 || right.length < 5 || x - left[0].x < arm || right.at(-1).x - x < arm) continue;
      // Highlights can erase the stripe next to the junction. Bound that gap,
      // but do not demand that both arms touch the stem in the colour mask.
      if (x - left.at(-1).x > arm * 2 || right[0].x - x > arm * 2) continue;
      // Require some clear yellow on both arms, while allowing the junction
      // itself and much of the stripe to be washed out by glare.
      const clearYellow = p => {
        const cy = Math.round(p.y);
        let count = 0;
        for (let dy = -3; dy <= 3; dy++) {
          const row = cy + dy;
          if (row >= 0 && row < height) count += yellowEvidence[row * width + p.x];
        }
        return count >= 2;
      };
      if (left.filter(clearYellow).length < 3 || right.filter(clearYellow).length < 3) continue;
      // A short extrapolation is only valid when the incoming yellow stem
      // actually reaches the stripe. A basket rim can otherwise borrow the
      // visible road line below it across an empty or occluded interval.
      const endpoint = farSide ? near[0] : near.at(-1);
      const from = Math.round(Math.min(y, endpoint[0])), to = Math.round(Math.max(y, endpoint[0]));
      let gap = 0;
      for (let row = from; row <= to; row++) {
        const cx = Math.round(x + heading * (row - y));
        let count = 0;
        for (let dx = -4; dx <= 4; dx++) {
          const column = cx + dx;
          if (column >= 0 && column < width) count += mask[row * width + column];
        }
        gap = count >= 2 ? 0 : gap + 1;
        if (gap > 6) break;
      }
      if (gap > 6) continue;
      // Actual yellow at the crossing prevents disconnected stripes on either
      // side from intersecting only through extrapolation.
      let supported = false;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        if (mask[Math.round(y + dy) * width + Math.round(x + dx)]) supported = true;
      }
      if (!supported) continue;
      return {x, y, slope, thickness, left: left[0].x, right: right.at(-1).x};
    }
  }
  return null;
}
