// Branch paths and their shared junction, in the 317 x 112 ROI coordinates.
function connectedFork(mask, root) {
  let left=root,right=root,common=root.mid,split=0,hits=0;
  for(let y=105;y>=1;y--){
    const runs=[];
    for(let x=1;x<316;){
      if(!mask[y*317+x]){x++;continue;}
      const lo=x++;while(x<316&&mask[y*317+x])x++;
      if(x-lo>=3)runs.push({lo,hi:x-1,mid:(lo+x-1)/2});
    }
    const adjacent=(a,b)=>Math.max(a.lo-b.hi,b.lo-a.hi)<=1;
    const l=runs.filter(r=>adjacent(r,left)),r=runs.filter(r=>adjacent(r,right));
    if(!l.length||!r.length){
      // Ignore a short edge spur before the approach stem is established.
      if(split>86&&(l.length||r.length)){
        left=right=(l.length?l:r).reduce((a,b)=>Math.abs(a.mid-common)<=Math.abs(b.mid-common)?a:b);
        common=left.mid;split=0;hits=0;continue;
      }
      break;
    }
    left=l[0];right=r.at(-1);
    if(left.lo===right.lo){common=left.mid;split=0;hits=0;continue;}
    if(!split)split=y+1;
    // Connected arms must extend to opposite sides of a supported approach stem.
    if(split<=86&&split>=20&&common-left.mid>=20&&right.mid-common>=20&&right.mid-left.mid>=60){
      if(++hits>=3)return {x:common,y:split};
    }else hits=0;
  }
  return null;
}
export function findBranches(mask, yellowEvidence = mask) {
  const rows = new Map();
  for (let y=106;y>=1;y-=5) {
    const runs=[];
    for(let x=1;x<316;) {
      if(!mask[y*317+x]) {x++;continue;}
      const lo=x++;while(x<316&&mask[y*317+x])x++;
      if(x-lo>=3&&x-lo<=315)runs.push({lo,hi:x-1,mid:(lo+x-1)/2});
    }
    rows.set(y,runs);
  }
  const empty=()=>({error:null,points:[]});
  const out={fork:false,y:0,point:null,left:empty(),right:empty()};
  if(!rows.get(106).length)return out;
  const root=rows.get(106).reduce((a,b)=>Math.abs(a.mid-158)<=Math.abs(b.mid-158)?a:b);
  if(root.hi-root.lo>110||root.lo<=2||root.hi>=314)return out;
  function trace(right) {
    let prev=root;const points=[[106,root.mid]];let error=null;
    for(let y=101;y>=1;y-=5) {
      const next=rows.get(y).filter(r=>Math.max(r.lo-prev.hi,prev.lo-r.hi)<=18&&
        (r.hi-r.lo>110||prev.hi-prev.lo>110||Math.abs(r.mid-prev.mid)<=55));
      if(!next.length)break;
      prev=right?next.at(-1):next[0];
      points.push([y,prev.hi-prev.lo>110?Math.max(prev.lo,Math.min(prev.hi,points.at(-1)[1])):prev.mid]);
    }
    if(points.length>=9&&points[0][0]-points.at(-1)[0]>=40) {
      const p=points.filter(([y])=>y>=41&&y<=76);
      if(p.length>=5)error=(p.reduce((s,q)=>s+q[1],0)/p.length-158.5)*2;
    }
    return {error,points};
  }
  out.left=trace(false);out.right=trace(true);
  const n=Math.min(out.left.points.length,out.right.points.length);
  for(let i=1;i+2<n;i++) {
    if([25,35,45].every((v,j)=>out.right.points[i+j][1]-out.left.points[i+j][1]>=v)) {
      out.fork=out.left.points.length>=9&&out.right.points.length>=9;
      out.y=out.right.points[i][0]+5;break;
    }
  }
  const connected=connectedFork(mask,root);
  if(connected){out.fork=true;out.y=connected.y;out.point=connected;}
  else if(out.fork){
    // Use the last shared stem point, not the midpoint between distant arms.
    // Trace separation thresholds confirm the fork further ahead of its root.
    let shared=0;
    for(let i=1;i<n;i++){
      if(Math.abs(out.right.points[i][1]-out.left.points[i][1])>3)break;
      shared=i;
    }
    const [y,x]=out.left.points[shared];
    out.point={x,y};
  }
  if(out.point){
    // At a shallow fork the final shared run can span most of one arm.
    // Project the narrow incoming stem instead of steering to that run's middle.
    const stem=out.left.points.filter(([y,x])=>y>=out.point.y+12&&y<=out.point.y+42&&
      rows.get(y).some(r=>Math.abs(r.mid-x)<1&&r.hi-r.lo<=60));
    if(stem.length>=3){
      const ym=stem.reduce((s,p)=>s+p[0],0)/stem.length;
      const xm=stem.reduce((s,p)=>s+p[1],0)/stem.length;
      const slope=stem.reduce((s,p)=>s+(p[0]-ym)*(p[1]-xm),0)/stem.reduce((s,p)=>s+(p[0]-ym)**2,0);
      const x=xm+slope*(out.point.y-ym);
      if(x>=1&&x<=315&&Math.abs(slope)<=2&&stem.every(([y,x])=>Math.abs(x-xm-slope*(y-ym))<=4))out.point.x=x;
    }
    out.y=out.point.y;
    // Keep the glare-tolerant connected geometry, but require clear yellow on
    // both outgoing arms. Warm mesh must not turn the road's incoming stem
    // into a fork merely because the loose colour mask joins nearby cells.
    const evidence=[0,0];
    for(let x=Math.max(2,Math.ceil(out.point.x-100));x<=Math.min(314,out.point.x+100);x+=4){
      if(Math.abs(x-out.point.x)<20)continue;
      let pixels=0;
      for(let y=Math.max(1,Math.floor(out.point.y-35));y<=Math.min(110,out.point.y+6);y++)
        pixels+=yellowEvidence[y*317+x];
      if(pixels>=2)evidence[x<out.point.x?0:1]++;
    }
    if(evidence.some(columns=>columns<3)){out.point=null;out.fork=false;out.y=0;}
  }
  return out;
}
