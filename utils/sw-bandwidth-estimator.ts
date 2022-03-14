class SWBandWidthEstimator {
  private defaultEstimate_: number;
  private windowSize: number;
  private window: number[];

  constructor(defaultEstimate: number) {
    this.defaultEstimate_ = defaultEstimate;
    this.windowSize = 16;
    this.window = [];
  }

  sample(durationMs: number, numBytes: number) {
    const numBits = 8 * numBytes;
    // duration in seconds
    const durationS = durationMs / 1000;
    // bandwidth in bits/s
    const bandwidthInBps = numBits / durationS;
    if (this.window.length === this.windowSize) {
      const _ = this.window.shift();
    }
    this.window.push(bandwidthInBps);
  }

  getEstimate(): number {
    const average = (list) =>
      list.reduce((prev, curr) => prev + curr) / list.length;
    if (this.window.length > 0) {
      return average(this.window);
    } else {
      return this.defaultEstimate_;
    }
  }

  destroy() {}
}
export default SWBandWidthEstimator;
