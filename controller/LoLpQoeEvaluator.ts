import QoeInfo from './LoLpQoeInfo';

export default class LoLpQoeEvaluator {
  private voPerSegmentQoeInfo: QoeInfo | null = null;
  private segmentDuration: number | null = null;
  private maxBitrateKbps: number | null = null;
  private minBitrateKbps: number | null = null;

  /**
   * Set up Per Segment QoeInfo
   * @param {number} sDuration
   * @param {number} maxBrKbps
   * @param {number} minBrKbps
   */
  setupPerSegmentQoe(sDuration, maxBrKbps, minBrKbps) {
    // Set up Per Segment QoeInfo
    this.voPerSegmentQoeInfo = this._createQoeInfo(
      'segment',
      sDuration,
      maxBrKbps,
      minBrKbps
    );
    this.segmentDuration = sDuration;
    this.maxBitrateKbps = maxBrKbps;
    this.minBitrateKbps = minBrKbps;
  }

  /**
   * Creates and Returns a QoeInfo object
   * @param {string} fragmentType
   * @param {number} fragmentDuration
   * @param {number} maxBitrateKbps
   * @param {number} minBitrateKbps
   * @return {QoeInfo}
   */
  _createQoeInfo(
    fragmentType,
    fragmentDuration,
    maxBitrateKbps,
    minBitrateKbps
  ) {
    /*
     * [Weights][Source: Abdelhak Bentaleb, 2020 (last updated: 30 Mar 2020)]
     * bitrateReward:           segment duration, e.g. 0.5s
     * bitrateSwitchPenalty:    0.02s or 1s if the bitrate switch is too important
     * rebufferPenalty:         max encoding bitrate, e.g. 1000kbps
     * latencyPenalty:          if L ≤ 1.1 seconds then = min encoding bitrate * 0.05, otherwise = max encoding bitrate * 0.1
     * playbackSpeedPenalty:    min encoding bitrate, e.g. 200kbps
     */

    // Creates new QoeInfo object
    const qoeInfo = new QoeInfo();
    qoeInfo.type = fragmentType;

    // Set weight: bitrateReward
    // set some safe value, else consider throwing error
    if (!fragmentDuration) {
      qoeInfo.weights.bitrateReward = 1;
    } else {
      qoeInfo.weights.bitrateReward = fragmentDuration;
    }

    // Set weight: bitrateSwitchPenalty
    // qoeInfo.weights.bitrateSwitchPenalty = 0.02;
    qoeInfo.weights.bitrateSwitchPenalty = 1;

    // Set weight: rebufferPenalty
    // set some safe value, else consider throwing error
    if (!maxBitrateKbps) {
      qoeInfo.weights.rebufferPenalty = 1000;
    } else {
      qoeInfo.weights.rebufferPenalty = maxBitrateKbps;
    }

    // Set weight: latencyPenalty
    qoeInfo.weights.latencyPenalty = [];
    qoeInfo.weights.latencyPenalty.push({
      threshold: 1.1,
      penalty: minBitrateKbps * 0.05,
    });
    qoeInfo.weights.latencyPenalty.push({
      threshold: 100000000,
      penalty: maxBitrateKbps * 0.1,
    });

    // Set weight: playbackSpeedPenalty
    if (!minBitrateKbps) qoeInfo.weights.playbackSpeedPenalty = 200;
    // set some safe value, else consider throwing error
    else qoeInfo.weights.playbackSpeedPenalty = minBitrateKbps;

    return qoeInfo;
  }

  /**
   * Updates Segment QoE value
   * @param {number} segmentBitrate
   * @param {number} segmentRebufferTime
   * @param {number} currentLatency
   * @param {number} currentPlaybackSpeed
   */
  logSegmentMetrics(
    segmentBitrate,
    segmentRebufferTime,
    currentLatency,
    currentPlaybackSpeed
  ) {
    if (this.voPerSegmentQoeInfo) {
      this._logMetricsInQoeInfo(
        segmentBitrate,
        segmentRebufferTime,
        currentLatency,
        currentPlaybackSpeed,
        this.voPerSegmentQoeInfo
      );
    }
  }

  /**
   * Calculates and Updates QoE value of the segment
   * @param {number} bitrate
   * @param {number} rebufferTime
   * @param {number} latency
   * @param {number} playbackSpeed
   * @param {QoeInfo} qoeInfo
   */
  _logMetricsInQoeInfo(bitrate, rebufferTime, latency, playbackSpeed, qoeInfo) {
    // Update: bitrate Weighted Sum value
    qoeInfo.bitrateWSum += qoeInfo.weights.bitrateReward * bitrate;

    // Update: bitrateSwitch Weighted Sum value
    if (qoeInfo.lastBitrate) {
      qoeInfo.bitrateSwitchWSum +=
        qoeInfo.weights.bitrateSwitchPenalty *
        Math.abs(bitrate - qoeInfo.lastBitrate);
    }
    qoeInfo.lastBitrate = bitrate;

    // Update: rebuffer Weighted Sum value
    qoeInfo.rebufferWSum += qoeInfo.weights.rebufferPenalty * rebufferTime;

    // Update: latency Weighted Sum value
    for (let i = 0; i < qoeInfo.weights.latencyPenalty.length; i++) {
      const latencyRange = qoeInfo.weights.latencyPenalty[i];
      if (latency <= latencyRange.threshold) {
        qoeInfo.latencyWSum += latencyRange.penalty * latency;
        break;
      }
    }

    // Update: playbackSpeed Weighted Sum value
    qoeInfo.playbackSpeedWSum +=
      qoeInfo.weights.playbackSpeedPenalty * Math.abs(1 - playbackSpeed);

    // Update: Total Qoe value
    qoeInfo.totalQoe =
      qoeInfo.bitrateWSum -
      qoeInfo.bitrateSwitchWSum -
      qoeInfo.rebufferWSum -
      qoeInfo.latencyWSum -
      qoeInfo.playbackSpeedWSum;
  }

  // Returns current Per Segment QoeInfo
  getPerSegmentQoe() {
    return this.voPerSegmentQoeInfo;
  }

  //
  /**
   * Returns totalQoe based on a single set of metrics
   * (For one-time use only)
   * @param {number} segmentBitrate
   * @param {number} segmentRebufferTime
   * @param {number} currentLatency
   * @param {number} currentPlaybackSpeed
   */
  calculateSingleUseQoe(
    segmentBitrate,
    segmentRebufferTime,
    currentLatency,
    currentPlaybackSpeed
  ) {
    let singleUseQoeInfo: QoeInfo | null = null;

    if (this.segmentDuration && this.maxBitrateKbps && this.minBitrateKbps) {
      singleUseQoeInfo = this._createQoeInfo(
        'segment',
        this.segmentDuration,
        this.maxBitrateKbps,
        this.minBitrateKbps
      );
    }

    if (singleUseQoeInfo) {
      this._logMetricsInQoeInfo(
        segmentBitrate,
        segmentRebufferTime,
        currentLatency,
        currentPlaybackSpeed,
        singleUseQoeInfo
      );
      return singleUseQoeInfo.totalQoe;
    } else {
      // Something went wrong..
      return 0;
    }
  }
}
