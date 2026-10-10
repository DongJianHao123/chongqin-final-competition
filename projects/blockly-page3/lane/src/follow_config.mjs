/** Public parameters. nearY uses normalized 320x240 detector coordinates. */
export const MIN_MOVING_SPEED=21;
export const DEFAULT_FOLLOW_PARAMS=Object.freeze({base:24,kp:.05,kd:0,maxCorrection:2,
  advanceDistanceMm:120,advanceSpeed:22,nearY:180,centerTolerancePx:32,timeoutS:30});
const ranges={base:[0,100],kp:[0,10],kd:[0,10],maxCorrection:[0,100],
  advanceDistanceMm:[1,2000],advanceSpeed:[0,100],nearY:[154,234],centerTolerancePx:[1,120],timeoutS:[1,120]};
export function resolveFollowParams(patch={},base=DEFAULT_FOLLOW_PARAMS){
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Error('Expected follow parameter object');
  for(const [key,value] of Object.entries(patch)){
    const range=ranges[key];
    if(!range||typeof value!=='number'||!Number.isFinite(value)||value<range[0]||value>range[1])throw Error(`Invalid follow parameter: ${key}`);
  }
  return Object.freeze({...base,...patch});
}
