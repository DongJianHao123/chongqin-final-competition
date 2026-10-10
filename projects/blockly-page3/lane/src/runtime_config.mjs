// Shared timing limits. Keep safety limits separate from network and motion timing.
export const RUNTIME_CONFIG = Object.freeze({
  laneRequestTimeoutMs: 1500,
  actionRequestTimeoutMs: 3000,
  frameFreshnessMs: 250,
  maxWheelRequests: 2,
  cameraStartupTimeoutMs: 5000,
  cameraNoFrameTimeoutMs: 5000,
  cameraWaitTimeoutMs: 1500,
  motionConfirmZeroMs: 300,
  shortMotionTimeoutS: 4,
  rotateMotionTimeoutS: 8,
  longMotionTimeoutS: 30,
  betweenActionPauseS: 0.8,
});
