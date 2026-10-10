// Detector coordinates always use a 320x240 working image. Scale the full
// camera frame, including 640x360 firmware output, into those coordinates.
export const DETECTION_WIDTH=320, DETECTION_HEIGHT=240;
export function supportedCameraSize(width,height){
  return Number.isInteger(width)&&Number.isInteger(height)&&width>=320&&height>=180&&
    (width*9===height*16||width*3===height*4);
}
