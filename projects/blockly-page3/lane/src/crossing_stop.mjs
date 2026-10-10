// Intersection confirmation from per-frame crossing flags. The detector's
// crossing bit can flicker under reflections and partial occlusion (recordings show
// isolated true frames on plain track), so a stop requires support across a
// sliding window of processed frames, not a single frame.
export class CrossingStop {
  // window: number of most recent frames considered; need: crossing frames
  // required inside that window. Defaults confirm in ~2-3 frames at 30 fps
  // when the crossbar is really in view.
  constructor({window = 5, need = 3} = {}) {
    this.window = window;
    this.need = need;
    this.flags = [];
    this.stopped = false;
  }
  // Feed one frame's crossing flag; true only when the stop triggers.
  update(crossing) {
    if (this.stopped) return true;
    this.flags.push(!!crossing);
    if (this.flags.length > this.window) this.flags.shift();
    if (this.flags.length >= this.need &&
        this.flags.filter(f => f).length >= this.need) {
      this.stopped = true;
    }
    return this.stopped;
  }
}
