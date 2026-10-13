import {MIN_MOVING_SPEED,resolveFollowParams} from './follow_config.mjs';
import {JunctionPolicy} from './junction_policy.mjs';
import {RUNTIME_CONFIG} from './runtime_config.mjs';
import {supportedCameraSize} from './camera_geometry.mjs';
export {DEFAULT_FOLLOW_PARAMS} from './follow_config.mjs';
export {DETECTION_WIDTH,DETECTION_HEIGHT,supportedCameraSize} from './camera_geometry.mjs';

/** Browser-only detection and one-junction control over existing motor endpoints. */
export function createJunctionFollower(options={}){
  const base=new URL(options.motorBaseUrl||'/',globalThis.location?.href||'http://localhost/').href.replace(/\/$/,'');
  const now=()=>performance.now()/1000;
  let params=resolveFollowParams(options.params),run=null,stopping=null,destroyed=false;
  const state=()=>structuredClone(run?.state??{status:'idle',phase:'idle',reason:null,stop_confirmed:null});
  const notify=(name,value)=>{try{options[name]?.(value);}catch(error){console.error(error);}};
  const emit=()=>notify('onState',state());
  const active=current=>run===current&&current.state.status==='running';
  const stationary=m=>m?.motor?.connected===true&&
    ['left_speed','right_speed'].every(k=>Number.isFinite(m[k])&&Math.abs(m[k])<=.005);
  async function request(path,timeoutMs=RUNTIME_CONFIG.actionRequestTimeoutMs){
    const signal=AbortSignal.timeout(timeoutMs);
    try{
      const response=await fetch(base+path,{cache:'no-store',keepalive:true,
        signal});
      let value;
      try{value=await response.json();}catch(error){
        if(signal.aborted)throw error;
        throw Error(`HTTP ${response.status}: expected JSON`);
      }
      if(!response.ok||!value||typeof value!=='object'||Array.isArray(value))throw Error(value?.error||`HTTP ${response.status}`);
      return value;
    }catch(cause){
      // Firefox may report AbortError for an expired timeout signal. Read the
      // signal instead of treating the browser's generic message as a cancel.
      const error=signal.aborted?
        new Error(`电机接口响应超时（${timeoutMs/1000} 秒）：${path.split('?')[0]}`,{cause}):cause;
      if(signal.aborted){error.name='MotorRequestTimeoutError';error.code='MOTOR_REQUEST_TIMEOUT';}
      throw error;
    }
  }
  async function direct(wheels,duration=0){
    const reply=await request(`/api/motor/direct?left=${wheels.left}&right=${wheels.right}${duration>0?`&duration=${duration}`:''}`);
    if(reply.status!=='success')throw Error(reply.error||reply.message||'Wheel command rejected');
    return reply;
  }
  async function feedback(){
    const m=await request('/api/motor/status');
    if(m.motor?.connected!==true||!['left_speed','right_speed'].every(k=>Number.isFinite(m[k])))throw Error('Invalid motor feedback');
    return m;
  }
  async function stopAndConfirm(){
    try{
      await direct({left:0,right:0});
      for(let i=0;i<6;i++){
        if(stationary(await feedback()))return true;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
    }catch(error){notify('onWarning',{code:'stop-unconfirmed',message:String(error.message)});}
    return false;
  }
  function finish(status='cancelled',reason='Cancelled by user',completionReason=null){
    if(stopping)return stopping;
    if(!run)return Promise.resolve(null);
    if(run.state.stop_confirmed===true&&['completed','cancelled','failed'].includes(run.state.status))return Promise.resolve(state());
    const current=run;
    clearInterval(current.timer);current.worker?.terminate();current.latest=null;
    current.state.status='stopping';current.state.phase='stopping';
    // Interrupt timed drive/distance requests, then drain them before the final
    // zero so a late request cannot hand control back to the cancelled run.
    stopping=(async()=>{
      await Promise.allSettled([direct({left:0,right:0}),current.pending,...current.wheelRequests]);
      const confirmed=await stopAndConfirm();
      current.motion=null;
      current.state.status=confirmed?status:'failed';current.state.phase=current.state.status;
      current.state.reason=confirmed?reason:`${reason}; stop unconfirmed`;
      current.state.completion_reason=confirmed&&status==='completed'?completionReason:null;
      current.state.stop_confirmed=confirmed;
      current.state.wheels=confirmed?{left:0,right:0}:null;
      emit();return state();
    })().finally(()=>{stopping=null;});
    emit();return stopping;
  }
  function wheels(current,value,duration){
    if(!active(current))return;
    const sequence=++current.driveSequence;
    const pending=direct(value,duration).then(reply=>{
      // Native C++ waits for completion and its distance endpoint uses cm.
      // Python returns mode=scheduled and keeps the original mm contract.
      if(reply.mode==='completed'&&typeof reply.completed==='boolean')current.nativeControl=true;
      if(active(current)&&sequence===current.driveSequence&&reply.completed===true){
        current.state.wheels={left:0,right:0};emit();
      }
    }).catch(error=>{
      if(active(current))void finish('failed',String(error.message));
    }).finally(()=>current.wheelRequests.delete(pending));
    current.wheelRequests.add(pending);
    current.state.wheels={...value};emit();
  }
  async function step(current){
    if(!active(current))return;
    const t=now();
    if(t-current.started>current.params.timeoutS)throw Error('Follow timeout');
    if(current.motion){
      const m=await feedback();
      if(!active(current))return;
      const motion=current.motion;
      if(t-motion.started>motion.timeout)throw Error('Motion completion timeout');
      if(!stationary(m)){motion.moved=true;motion.zero=null;}
      else if(motion.moved){
        motion.zero??=t;
        if(t-motion.zero>=RUNTIME_CONFIG.motionConfirmZeroMs/1000){
          queueMicrotask(()=>void finish('completed','Arrived at junction','arrived_at_junction'));
        }
      }
      return;
    }
    const latest=current.latest,age=latest?.ageMs??latest?.localMs;
    const remainingMs=latest&&Number.isFinite(age)&&age>=0?
      RUNTIME_CONFIG.frameFreshnessMs-age-(t-current.arrived)*1000:0;
    if(latest&&!supportedCameraSize(latest.width,latest.height)){
      throw Error(`摄像头分辨率 ${latest.width}×${latest.height} 不支持，请使用宽度至少 320 像素的 16:9 或 4:3 画面`);
    }
    if(remainingMs<1){
      if(current.state.phase!=='waiting_for_camera'){
        current.state.phase='waiting_for_camera';current.state.wheels=null;emit();
      }
      current.stale??=t;
      // Opening the camera after another vision action can take longer than a
      // running stream's interruption. Neither wait grants any driving lease.
      const limit=current.hasFreshFrame?RUNTIME_CONFIG.cameraWaitTimeoutMs:RUNTIME_CONFIG.cameraStartupTimeoutMs;
      if(t-current.stale>limit/1000)throw Error(`摄像头画面不可用（Camera unavailable）：${current.hasFreshFrame?
        `连续 ${limit/1000} 秒没有新鲜帧`:`启动 ${limit/1000} 秒内没有收到可用图像`}`);
      return;
    }
    current.stale=null;current.hasFreshFrame=true;
    // Allow one request to replace another still waiting for its duration ACK.
    // Never queue more drive commands when responses stall; keep only latest.
    if(current.wheelRequests.size>=RUNTIME_CONFIG.maxWheelRequests)return;
    // Fresh intermediate frames received during slow I/O are superseded, not
    // replayed into steering or junction evidence after the request completes.
    const out=current.policy.step(current.sequence,latest,t);
    if(!active(current)||!out)return;
    current.state.phase=current.policy.phase;
    if(out.done&&out.reason==='line_end'){
      queueMicrotask(()=>void finish('completed','Reached line end','line_end'));
    }else if(out.motion){
      // Stop direct drive before handing over the configured distance advance.
      await direct({left:0,right:0});
      await Promise.allSettled([...current.wheelRequests]);
      if(!active(current))return;
      const distance=current.params.advanceDistanceMm;
      const speed=current.params.advanceSpeed===0?0:Math.max(MIN_MOVING_SPEED,current.params.advanceSpeed);
      current.motion={started:now(),moved:false,zero:null,timeout:Math.min(current.params.timeoutS,
        distance<=120?RUNTIME_CONFIG.shortMotionTimeoutS:RUNTIME_CONFIG.longMotionTimeoutS)};
      current.state.wheels=null;emit();
      const target=current.nativeControl?distance/10:distance;
      const reply=await request(`/api/control?action=up&speed=${speed}&distance=${target}`,
        current.nativeControl?Math.ceil(current.motion.timeout*1000):RUNTIME_CONFIG.actionRequestTimeoutMs);
      if(!active(current))return;
      if(current.nativeControl){
        if(reply.completed!==true)throw Error(reply.error||'Advance command rejected');
        // The synchronous completion ACK is movement evidence; following
        // status reads still have to confirm a sustained zero and final stop.
        current.motion.moved=true;current.motion.started=now();
      }else if(reply.status!=='started'||reply.target!==distance||reply.unit!=='mm'){
        throw Error('Advance command rejected');
      }
    }else{
      if(out.waiting)current.state.phase='waiting_for_track';
      wheels(current,out.wheels,out.wheels.left||out.wheels.right?Math.floor(remainingMs)/1000:0);
    }
  }
  async function start(){
    if(destroyed||stopping||['starting','running','stopping'].includes(run?.state.status))throw Error('Follower busy or destroyed');
    if(run?.state.stop_confirmed===false)throw Error('Stop not confirmed');
    if(globalThis.document?.hidden)throw Error('Page hidden');
    if(!globalThis.Worker||!globalThis.OffscreenCanvas||!globalThis.createImageBitmap)throw Error('Worker, OffscreenCanvas and createImageBitmap are required');
    const settings={...params};
    const current={params:settings,policy:new JunctionPolicy(settings),pending:null,timer:null,worker:null,
      wheelRequests:new Set(),driveSequence:0,nativeControl:false,
      latest:null,arrived:0,sequence:0,stale:null,hasFreshFrame:false,motion:null,started:now(),
      state:{status:'starting',phase:'starting',reason:null,stop_confirmed:null,follow_params:settings,wheels:{left:0,right:0}}};
    run=current;
    current.pending=(async()=>{
      if(!stationary(await feedback()))throw Error('Motor must be connected and stationary');
      if(current.state.status!=='starting')return;
      await direct({left:0,right:0});
      if(current.state.status!=='starting')return;
      const worker=options.workerUrl
        ?new Worker(options.workerUrl)
        :new Worker(new URL('./worker.mjs',import.meta.url),{type:'module'});
      current.worker=worker;
      worker.onerror=event=>{if(active(current))void finish('failed',event.message);};
      worker.onmessage=({data:result})=>{
        if(!active(current))return;
        if(result.type==='error'){void finish('failed',result.message);return;}
        if(result.type==='stream-disconnected'){
          current.latest=null;current.stale??=now();
          notify('onWarning',{code:'camera-reconnecting',message:result.message});return;
        }
        result.frameId=++current.sequence;
        current.latest=result;current.arrived=now();
        notify('onResult',result);
      };
      current.started=now();current.state.status='running';current.state.phase='approach';
      worker.postMessage({type:'init',mode:'frames',includePixels:true,
        params:{...settings,crossingStopEnabled:false}});
      current.timer=setInterval(()=>{
        if(current.pending||!active(current))return;
        current.pending=step(current).catch(error=>{
          queueMicrotask(()=>void finish('failed',String(error.message)));
        }).finally(()=>{current.pending=null;});
      },30);
      emit();
    })();
    emit();
    try{await current.pending;}catch(error){await finish('failed',String(error.message));throw error;}
    finally{current.pending=null;}
    return state();
  }
  const hide=()=>{if(globalThis.document?.hidden&&['starting','running'].includes(run?.state.status))void finish('cancelled','Page hidden');};
  const unload=()=>{if(['starting','running'].includes(run?.state.status))void finish('cancelled','Page closed');};
  globalThis.document?.addEventListener('visibilitychange',hide);
  globalThis.window?.addEventListener('pagehide',unload);
  return {
    configure(patch){
      if(destroyed)throw Error('Follower destroyed');
      if(stopping||['starting','running','stopping'].includes(run?.state.status)||run?.state.stop_confirmed===false)throw Error('Stop and confirm parking before configuring');
      params=resolveFollowParams(patch,params);return {...params};
    },
    getConfig(){return {...params};},start,stop:()=>finish(),status:state,
    // Feed a normalized 320x240 RGBA frame (an ArrayBuffer) into the detection
    // worker. The caller samples the already-open camera <img> on the main
    // thread, so the worker performs no camera network I/O.
    pushFrame(rgba,width,height){
      const worker=run?.worker;
      if(!worker)return;
      try{worker.postMessage({type:'frame',rgba,width,height},[rgba]);}catch{}
    },
    async destroy(){
      destroyed=true;
      globalThis.document?.removeEventListener('visibilitychange',hide);
      globalThis.window?.removeEventListener('pagehide',unload);
      await finish();
    }
  };
}
