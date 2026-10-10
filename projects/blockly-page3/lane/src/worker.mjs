import {detect, speeds} from './lane.mjs';
import {CrossingStop} from './crossing_stop.mjs';
import {RUNTIME_CONFIG} from './runtime_config.mjs';
import {DETECTION_WIDTH,DETECTION_HEIGHT,supportedCameraSize} from './camera_geometry.mjs';
let controller, latest = null, processing = false, timer, lastArrival = 0;
let received = 0, processed = 0, dropped = 0, lastError = null, lastTime = 0, startTime = 0;
let controlParams, crossingStop, includePixels, streamGeneration = 0;
const canvas = new OffscreenCanvas(DETECTION_WIDTH, DETECTION_HEIGHT);
const ctx = canvas.getContext('2d', {willReadFrequently: true});
function fail(error) {
  clearInterval(timer);
  controller?.abort();
  postMessage({type: 'error', message: String(error.message || error)});
}
async function processLatest() {
  if (processing || !latest) return;
  processing = true;
  const {jpeg, arrived} = latest;
  const generation = streamGeneration;
  latest = null;
  let bitmap;
  try {
    const begin = performance.now();
    bitmap = await createImageBitmap(new Blob([jpeg], {type: 'image/jpeg'}));
    if (controller.signal.aborted || generation !== streamGeneration) return;
    const width = bitmap.width, height = bitmap.height;
    if(supportedCameraSize(width,height)){
      // Normalize the camera's full frame into the detector's 320x240
      // coordinates. Letterboxing here would hide the bottom track and make
      // the junction exit threshold unreachable.
      ctx.drawImage(bitmap,0,0,DETECTION_WIDTH,DETECTION_HEIGHT);
    }else{
      // Keep unsupported dimensions visible in preview; driving rejects them.
      const scale=Math.min(DETECTION_WIDTH/width,DETECTION_HEIGHT/height);
      ctx.fillStyle='#000';ctx.fillRect(0,0,DETECTION_WIDTH,DETECTION_HEIGHT);
      const w=Math.round(width*scale),h=Math.round(height*scale);
      ctx.drawImage(bitmap,Math.floor((DETECTION_WIDTH-w)/2),Math.floor((DETECTION_HEIGHT-h)/2),w,h);
    }
    bitmap.close(); bitmap = null;
    const pixels = ctx.getImageData(0, 0, DETECTION_WIDTH, DETECTION_HEIGHT);
    const decoded = performance.now();
    const result = detect(pixels.data);
    const finish = performance.now();
    // Intersection stop: confirm on a sliding window, then hold zero speed;
    // the last frame still flows through the normal command path so the
    // 0/0 reaches the board before the client ends the session.
    let wheels;
    if (controlParams.crossingStopEnabled) {
      const stopNow = crossingStop.update(result.crossing);
      wheels = stopNow ? {left: 0, right: 0}
        : speeds(result.error, lastError, (finish - lastTime) / 1000, controlParams);
    } else {
      wheels = speeds(result.error, lastError, (finish - lastTime) / 1000, controlParams);
    }
    lastError = result.error;
    lastTime = finish; processed++;
    const transfers = [];
    if (includePixels) transfers.push(pixels.data.buffer);
    postMessage({type: 'result', ...result, ...wheels, crossingStop: crossingStop.stopped, width, height,
      decodeMs: decoded - begin, algorithmMs: finish - decoded,
      // ageMs is elapsed time from stream receipt to the completed detection.
      // localMs remains as a compatibility alias for existing integrations.
      ageMs: finish - arrived, localMs: finish - arrived, receivedAt: arrived,
      received, processed, dropped, fps: processed * 1000 / (finish - startTime),
      ...(includePixels ? {pixels: pixels.data.buffer} : {})}, transfers);
  } catch (error) {
    if (!controller.signal.aborted && generation === streamGeneration) fail(error);
  }
  finally { bitmap?.close(); processing = false; }
}
async function stream(url) {
  const response = await fetch(url, {signal: controller.signal, cache: 'no-store'});
  if (!response.ok) {
    const error = new Error(`视频流 HTTP ${response.status}`); error.retryable = response.status >= 500; throw error;
  }
  if (!response.headers.get('content-type')?.includes('multipart/')) {
    const error = new Error('接口没有返回 MJPEG 视频流'); error.retryable = false; throw error;
  }
  const reader = response.body.getReader();
  let buffer = new Uint8Array();
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) { const error = new Error('视频流已断开'); error.retryable = true; throw error; }
      const merged = new Uint8Array(buffer.length + value.length);
      merged.set(buffer); merged.set(value, buffer.length); buffer = merged;
      let offset = 0;
      while (true) {
        let start = -1, end = -1;
        for (let i = offset; i + 1 < buffer.length; i++) {
          if (buffer[i] === 255 && buffer[i + 1] === 216) { start = i; break; }
        }
        if (start < 0) { buffer = buffer.slice(-1); break; }
        for (let i = start + 2; i + 1 < buffer.length; i++) {
          if (buffer[i] === 255 && buffer[i + 1] === 217) { end = i + 2; break; }
        }
        if (end < 0) { buffer = buffer.slice(start); break; }
        if (latest) dropped++;
        lastArrival = performance.now(); received++;
        latest = {jpeg: buffer.slice(start, end), arrived: lastArrival};
        offset = end;
      }
      if (buffer.length > 4 * 1024 * 1024) throw new Error('MJPEG 帧过大或格式损坏');
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function reconnectingStream(url) {
  let attempts = 0, lastReceived = received;
  while (!controller.signal.aborted) {
    try { await stream(url); }
    catch (error) {
      if (controller.signal.aborted || error.name === 'AbortError') return;
      if (error.retryable !== true && (error.retryable === false || error.name !== 'TypeError')) throw error;
      if (received > lastReceived) attempts = 0;
      lastReceived = received;
      latest = null;
      streamGeneration++;
      postMessage({type: 'stream-disconnected', message: String(error.message), attempt: ++attempts});
      // Reopen the existing stream only after a disconnection. Normal follow
      // still has one stream and no snapshots or extra per-frame requests.
      await new Promise(resolve => setTimeout(resolve, Math.min(300 * attempts, 1000)));
    }
  }
}
onmessage = async ({data}) => {
  includePixels = data.includePixels;
  controlParams = data.params;
  crossingStop = new CrossingStop();
  controller = new AbortController();
  startTime = lastTime = lastArrival = performance.now();
  timer = setInterval(() => {
    if (performance.now() - lastArrival > RUNTIME_CONFIG.cameraNoFrameTimeoutMs) {
      fail(new Error(`${RUNTIME_CONFIG.cameraNoFrameTimeoutMs} ms 没有收到完整图像`)); return;
    }
    void processLatest();
  }, 1000 / data.fps);
  try {
    if (data.mode === 'demo') {
      const demo = new OffscreenCanvas(320, 240), dc = demo.getContext('2d');
      while (!controller.signal.aborted) {
        dc.fillStyle = '#20252b'; dc.fillRect(0, 0, 320, 240);
        dc.strokeStyle = '#ffdf00'; dc.lineWidth = 9;
        dc.beginPath(); dc.moveTo(160 + 65 * Math.sin(performance.now() / 1500), 239); dc.lineTo(160, 110); dc.stroke();
        const blob = await demo.convertToBlob({type: 'image/jpeg', quality: 0.8});
        if (latest) dropped++;
        lastArrival = performance.now(); received++;
        latest = {jpeg: new Uint8Array(await blob.arrayBuffer()), arrived: lastArrival};
        await new Promise(resolve => setTimeout(resolve, 1000 / data.fps));
      }
    } else {
      const opened = await fetch(`${data.cameraBaseUrl}/api/camera/open`, {method: 'POST', signal: controller.signal});
      if (!opened.ok || !(await opened.json()).camera_on) throw new Error('无法打开摄像头');
      await reconnectingStream(`${data.cameraBaseUrl}/api/camera/stream`);
    }
  } catch (error) { if (error.name !== 'AbortError') fail(error); }
};
