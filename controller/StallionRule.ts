import Hls, { Fragment, Part } from '../hls';
import { PlaylistLevelType } from '../types/loader';
import { BufferHelper } from '../utils/buffer-helper';

export default class StallionRule {
  private hls: Hls;
  private fragCurrent: Fragment;
  private partCurrent: Part;
  private currentQuality: number;
  private throughputArr: number[];
  private latencyArr: number[];
  private readonly THROUGHPUT_SAFETY_FACTOR = 1;
  private readonly LATENCY_SAFETY_FACTOR = 1.25;
  private readonly THROUGHPUT_SAMPLE_AMOUNT = 3;
  private readonly LATENCY_SAMPLE_AMOUNT = 4;

  constructor(config) {
    this.hls = config.hls;
    this.fragCurrent = config.fragCurrent;
    this.partCurrent = config.partCurrent;
    this.currentQuality = config.currentQuality;
    this.throughputArr = [];
    this.latencyArr = [];
  }

  update(config) {
    this.hls = config.hls;
    this.fragCurrent = config.fragCurrent;
    this.partCurrent = config.partCurrent;
    this.currentQuality = config.currentQuality;
  }

  private getMean(array) {
    return array.reduce((a, b) => a + b) / array.length;
  }

  private getStandardDeviation(array) {
    const n = array.length;
    const mean = array.reduce((a, b) => a + b) / n;
    return Math.sqrt(
      array.map((x) => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / n
    );
  }

  /**
   * @param {number} bitrate A bitrate value, kbps
   * @returns {number} A quality index <= for the given bitrate
   * @memberof AbrController#
   */
  getQualityForBitrate(bitrate, latency) {
    const { hls, fragCurrent } = this;

    if (latency && fragCurrent) {
      const fragmentDuration = fragCurrent.duration;
      const targetLatency = hls.targetLatency ? hls.targetLatency : 0;
      const deltaLatency = Math.abs(latency - targetLatency);
      if (deltaLatency >= fragmentDuration) {
        return 0;
      } else {
        const deadTimeRatio = deltaLatency / fragmentDuration;
        bitrate = bitrate * (1 - deadTimeRatio);
      }
    }

    const bitrateList = hls.levels.map((b) => b.bitrate);

    for (let i = bitrateList.length - 1; i >= 0; i--) {
      if (bitrate * 1000 >= bitrateList[i]) {
        return i;
      }
    }
    return 0;
  }

  getMaxIndex() {
    const { hls, fragCurrent, currentQuality } = this;
    const { media, config } = hls;
    const mediaType = fragCurrent ? fragCurrent.type : PlaylistLevelType.MAIN;
    const pos = media ? media.currentTime : 0;
    const bufferStateVO = BufferHelper.bufferInfo(
      media,
      pos,
      config.maxBufferHole
    );
    let quality = currentQuality;

    if (mediaType === PlaylistLevelType.AUDIO) return currentQuality;

    const HLSThroughput = !isNaN(hls.bandwidthEstimate)
      ? hls.bandwidthEstimate / 1000.0
      : config.abrEwmaDefaultEstimate / 1000.0;
    this.throughputArr.push(HLSThroughput);
    this.latencyArr.push(hls.latency);

    if (this.throughputArr.length > this.THROUGHPUT_SAMPLE_AMOUNT)
      this.throughputArr.shift();
    if (this.latencyArr.length > this.LATENCY_SAMPLE_AMOUNT)
      this.latencyArr.shift();

    const throughput = this.getMean(this.throughputArr);
    const throughput_std = this.getStandardDeviation(this.throughputArr);
    //calculate bitrate using throughput minus a factor of its standard deviation
    const bitrate = throughput - this.THROUGHPUT_SAFETY_FACTOR * throughput_std;

    const latency = this.getMean(this.latencyArr);
    const std_latency = this.getStandardDeviation(this.latencyArr);
    //calculate latency estimate using latency plus a factor of of its standard deviation
    const lat = latency + this.LATENCY_SAFETY_FACTOR * std_latency;

    if (!hls.isLive) {
      this.throughputArr.pop();
      this.latencyArr.pop();
    }

    if (isNaN(throughput) || !bufferStateVO) {
      return quality;
    }

    const targetLatency = hls.targetLatency ? hls.targetLatency : 0;
    const deltaLatency = Math.abs(lat - targetLatency);
    if (
      fragCurrent != null &&
      deltaLatency < fragCurrent.duration &&
      bufferStateVO.len > 0
    )
      quality = this.getQualityForBitrate(bitrate, lat);
    return quality;
  }
}
