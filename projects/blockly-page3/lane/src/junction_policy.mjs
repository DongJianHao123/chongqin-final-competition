import {resolveFollowParams} from './follow_config.mjs';
import {speeds} from './lane.mjs';

// Coordinates are relative to the normalized 320x240 ROI (x + 1, y + 126).
export const JUNCTION_FOLLOW = Object.freeze({nearY:54,centerX:158.5,centerTolerance:32,
  maxStepX:64,maxStepY:45,maxRetreatY:25,exitMissingFrames:3,
  exitY:84,exitMaxOffset:64,exitMinSamples:5,exitMinTravelY:20,
  exitMaxStepX:20,exitMaxStepY:16,exitMaxRetreatY:4,exitMaxGapS:.5});
function junctionPoint(r){
  const p=r.intersection;
  return p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<317&&p.y>=0&&p.y<112?p:null;
}
function sameJunction(a,b){
  return !a||(Math.abs(a.x-b.x)<=JUNCTION_FOLLOW.maxStepX&&
    b.y-a.y<=JUNCTION_FOLLOW.maxStepY&&a.y-b.y<=JUNCTION_FOLLOW.maxRetreatY);
}

/** Pure policy for one approach, junction alignment and distance advance. */
export class JunctionPolicy {
  constructor(params={}){
    this.params=resolveFollowParams(params);this.phase='approach';
    this.last=-1;this.previous=this.missing=null;this.junction=null;this.junctionFlags=[];
    this.junctionProgress=null;this.junctionMissingFrames=0;
    this.trackSamples=0;this.trackMissingFrames=0;this.trackAbsentFrames=0;this.trackObservedAt=null;
    this.trackLeftView=false;
  }
  motionFinished(){this.phase='done';}
  observeJunction(point,now){
    const c=JUNCTION_FOLLOW,p=this.junctionProgress;
    const continuous=p&&now-p.time<=c.exitMaxGapS&&
      Math.abs(point.x-p.point.x)<=c.exitMaxStepX&&
      point.y-p.point.y<=c.exitMaxStepY&&p.maxY-point.y<=c.exitMaxRetreatY;
    this.junctionProgress={startY:continuous?p.startY:point.y,
      maxY:continuous?Math.max(p.maxY,point.y):point.y,
      samples:continuous?p.samples+1:1,point:{x:point.x,y:point.y},time:now};
  }
  bottomExitEvidence(now){
    const c=JUNCTION_FOLLOW,p=this.junctionProgress;
    const travelY=p?p.point.y-p.startY:0;
    return {samples:p?.samples??0,travelY,lastPoint:p?.point??null,
      ready:!!p&&now-p.time<=c.exitMaxGapS&&p.samples>=c.exitMinSamples&&
        travelY>=c.exitMinTravelY&&p.point.y>=c.exitY&&
        Math.abs(p.point.x-c.centerX)<=c.exitMaxOffset};
  }
  step(sequence,r,now){
    if(this.phase==='done')return {done:true};
    if(this.phase==='centering')return null;
    if(sequence<=this.last)return null;this.last=sequence;
    const point=junctionPoint(r);
    const matched=point&&sameJunction(this.junction,point);
    const trackingJunction=['following_junction','aligning_junction'].includes(this.phase);
    this.junctionMissingFrames=trackingJunction&&!point?this.junctionMissingFrames+1:0;
    const near=!!point&&point.y>=this.params.nearY-126;
    const centered=!!point&&Math.abs(point.x-JUNCTION_FOLLOW.centerX)<=this.params.centerTolerancePx;
    if(this.phase==='following_junction'){
      if(!matched){
        if(!point&&this.junctionMissingFrames>=JUNCTION_FOLLOW.exitMissingFrames){
          this.phase='centering';return {motion:['up','distance',this.params.advanceDistanceMm,this.params.advanceSpeed]};
        }
        this.previous=null;this.missing??=now;
        if(now-this.missing>1.2)throw Error('Junction target unavailable for 1.2 seconds');
        return {wheels:{left:0,right:0},waiting:'junction'};
      }
    }else if(this.phase==='aligning_junction'){
      if(!matched){
        if(!point&&this.bottomExitEvidence(now).ready){
          if(this.junctionMissingFrames>=JUNCTION_FOLLOW.exitMissingFrames){
            this.phase='centering';return {motion:['up','distance',this.params.advanceDistanceMm,this.params.advanceSpeed]};
          }
        }else{
          this.junctionProgress=null;
        }
        this.previous=null;this.missing??=now;
        if(now-this.missing>1.2)throw Error('Junction alignment target unavailable for 1.2 seconds');
        return {wheels:{left:0,right:0},waiting:'junction'};
      }
      if(near&&centered)this.phase='following_junction';
    }else{
      if(point&&!matched)this.junctionFlags=[];
      this.junctionFlags.push(!!point);
      if(this.junctionFlags.length>5)this.junctionFlags.shift();
      if(point&&this.junctionFlags.filter(Boolean).length>=3&&point.y>=this.params.nearY-126){
        this.phase=centered?'following_junction':'aligning_junction';this.previous=null;
      }
      if(!point&&!this.junctionFlags.some(Boolean))this.junction=null;
    }
    if(point)this.junction={x:point.x,y:point.y};
    const trackingPoint=['following_junction','aligning_junction'].includes(this.phase);
    if(trackingPoint){
      this.observeJunction(point,now);
    }
    const error=trackingPoint?(point.x-JUNCTION_FOLLOW.centerX)*2:r.error;
    const centers=r.centers??[];
    const noLine=!Number.isFinite(error)||(!trackingPoint&&Math.abs(error)>260&&centers.length<3);
    // Unrecognized colour fragments cannot establish lateral track loss.
    if(!trackingPoint&&!noLine){
      const near=centers.filter(([y,x])=>y>=86&&Number.isFinite(x));
      if(near.some(([,x])=>x<=32||x>=285))this.trackLeftView=true;
      else if(near.length>=3)this.trackLeftView=false;
    }
    if(noLine){
      if(this.trackObservedAt!==null&&now-this.trackObservedAt>.25){
        this.missing=null;this.trackMissingFrames=0;this.trackAbsentFrames=0;
      }
      this.trackObservedAt=now;
      this.trackMissingFrames++;
      this.trackAbsentFrames=r.error===null?this.trackAbsentFrames+1:0;
      this.missing??=now;this.previous=null;
      if(now-this.missing>1.2){
        // A line end is only meaningful after following a real track. Camera
        // freshness is checked by the caller before this observation counts.
        if(this.phase==='approach'&&!this.trackLeftView&&this.trackSamples>=3&&this.trackAbsentFrames>=3&&
          this.trackAbsentFrames===this.trackMissingFrames){
          this.phase='done';
          return {done:true,reason:'line_end'};
        }
        throw Error('Track unavailable for 1.2 seconds'+(this.trackLeftView?' (line left camera view)':''));
      }
      return {wheels:{left:0,right:0},waiting:'track'};
    }
    this.trackObservedAt=now;this.trackMissingFrames=0;this.trackAbsentFrames=0;
    if(centers.length>=3&&Number.isFinite(r.error))this.trackSamples++;
    this.missing=null;
    const offset=point?Math.abs(point.x-JUNCTION_FOLLOW.centerX):0;
    const base=this.phase==='aligning_junction'?this.params.base*
      Math.max(.25,Math.min(1,(this.params.centerTolerancePx/offset)**2)):this.params.base;
    const wheels=speeds(error,this.previous,0,{...this.params,base});this.previous=error;
    return {wheels};
  }
}
