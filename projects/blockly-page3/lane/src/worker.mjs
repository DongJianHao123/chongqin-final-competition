import {detect, speeds} from './lane.mjs';
import {CrossingStop} from './crossing_stop.mjs';

// Detection-only worker. The camera stream is read on the main thread (from the
// already-open <img> preview) and sent here as normalized 320x240 RGBA frames;
// the worker performs no network I/O of its own.
let controller, controlParams, crossingStop, includePixels;
let received = 0, processed = 0, dropped = 0, lastError = null, lastTime = 0, startTime = 0;

function fail(error) {
  controller?.abort();
  postMessage({type: 'error', message: String(error.message || error)});
}

function processFrame(rgba, arrived, width, height) {
  const begin = performance.now();
  const result = detect(rgba);
  const finish = performance.now();
  // Intersection stop: confirm on a sliding window, then hold zero speed; the
  // last frame still flows through the normal command path so the 0/0 reaches
  // the board before the client ends the session.
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
  if (includePixels) transfers.push(rgba.buffer);
  postMessage({type: 'result', ...result, ...wheels, crossingStop: crossingStop.stopped, width, height,
    decodeMs: 0, algorithmMs: finish - begin,
    // ageMs is elapsed time from frame receipt to the completed detection.
    // localMs remains as a compatibility alias for existing integrations.
    ageMs: finish - arrived, localMs: finish - arrived, receivedAt: arrived,
    received, processed, dropped, fps: processed * 1000 / (finish - startTime),
    ...(includePixels ? {pixels: rgba.buffer} : {})}, transfers);
}

function startDemo(fps) {
  const demo = new OffscreenCanvas(320, 240), dc = demo.getContext('2d');
  const frame = async () => {
    dc.fillStyle = '#20252b'; dc.fillRect(0, 0, 320, 240);
    dc.strokeStyle = '#ffdf00'; dc.lineWidth = 9;
    dc.beginPath(); dc.moveTo(160 + 65 * Math.sin(performance.now() / 1500), 239); dc.lineTo(160, 110); dc.stroke();
    const pixels = dc.getImageData(0, 0, 320, 240);
    const arrived = performance.now(); received++;
    processFrame(pixels.data, arrived, 320, 240);
    await new Promise(resolve => setTimeout(resolve, 1000 / fps));
  };
  (async () => { while (!controller.signal.aborted) await frame(); })();
}

onmessage = ({data}) => {
  if (data.type === 'init') {
    controlParams = data.params;
    includePixels = data.includePixels;
    crossingStop = new CrossingStop();
    controller = new AbortController();
    startTime = lastTime = performance.now();
    if (data.mode === 'demo') startDemo(data.fps || 15);
    return;
  }
  if (data.type !== 'frame' || !controlParams) return;
  const rgba = new Uint8ClampedArray(data.rgba);
  const arrived = performance.now(); received++;
  processFrame(rgba, arrived, data.width, data.height);
};
