type LatencyP = {
  threshold: number;
  penalty: number;
};

type Weight = {
  bitrateReward: number | null;
  bitrateSwitchPenalty: number | null;
  rebufferPenalty: number | null;
  latencyPenalty: LatencyP[] | null;
  playbackSpeedPenalty: number | null;
};

export default class QoeInfo {
  public type: string | null;
  public lastBitrate: number | null;
  public weights: Weight;
  public bitrateWSum: number;
  public bitrateSwitchWSum: number;
  public rebufferWSum: number;
  public latencyWSum: number;
  public playbackSpeedWSum: number;
  public totalQoe: any;

  constructor() {
    // Type e.g. 'segment'
    this.type = null;

    // Store lastBitrate for calculation of bitrateSwitchWSum
    this.lastBitrate = null;

    // Weights for each Qoe factor
    this.weights = {
      bitrateReward: null,
      bitrateSwitchPenalty: null,
      rebufferPenalty: null,
      latencyPenalty: null,
      playbackSpeedPenalty: null,
    };

    // Weighted Sum for each Qoe factor
    this.bitrateWSum = 0; // kbps
    this.bitrateSwitchWSum = 0; // kbps
    this.rebufferWSum = 0; // seconds
    this.latencyWSum = 0; // seconds
    this.playbackSpeedWSum = 0; // e.g. 0.95, 1.0, 1.05

    // Store total Qoe value based on current Weighted Sum values
    this.totalQoe = 0;
  }
}
