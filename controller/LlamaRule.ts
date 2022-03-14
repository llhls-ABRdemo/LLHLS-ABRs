import Hls, { Fragment, Part } from '../hls';
import { PlaylistLevelType } from '../types/loader';
import { BufferHelper } from '../utils/buffer-helper';

export default class LlamaABR {
  private hls: Hls;
  private fragCurrent: Fragment;
  private partCurrent: Part;
  private currentQuality: number;
  private sn0: number | string;
  private harmonicMeanQ: number[];
  private readonly THROUGHPUT_SAFETY_FACTOR = 1;
  private readonly HARMONIC_MEAN_SIZE = 10;
  private readonly MIN_BUFFER_LEVEL = -1;

  constructor(config) {
    this.hls = config.hls;
    this.fragCurrent = config.fragCurrent;
    this.partCurrent = config.partCurrent;
    this.currentQuality = config.currentQuality;
    this.sn0 = this.fragCurrent.sn;
    this.harmonicMeanQ = [];
  }

  update(config) {
    this.hls = config.hls;
    this.fragCurrent = config.fragCurrent;
    this.partCurrent = config.partCurrent;
    this.currentQuality = config.currentQuality;
    if (typeof this.sn0 === 'string') this.sn0 = this.fragCurrent.sn;
  }

  getMaxIndex() {
    const { hls, fragCurrent, currentQuality, sn0 } = this;
    const { media, config } = hls;
    const mediaType = fragCurrent ? fragCurrent.type : PlaylistLevelType.MAIN;
    const pos = media ? media.currentTime : 0;
    const bufferStateVO = BufferHelper.bufferInfo(
      media,
      pos,
      config.maxBufferHole
    );
    const bufferLevel = parseFloat(bufferStateVO.len.toFixed(2));
    let quality = currentQuality;

    if (mediaType === PlaylistLevelType.AUDIO) {
      return currentQuality;
    }

    if (!bufferStateVO) {
      quality = 0;
      return quality;
    }

    if (
      typeof sn0 === 'string' ||
      (typeof fragCurrent.sn !== 'string' && Math.abs(fragCurrent.sn - sn0) < 5)
    ) {
      quality = 0;
      return quality;
    }

    const throughputMeasureTime =
      fragCurrent.stats.loading.end - fragCurrent.stats.loading.start;
    const downloadBytes = fragCurrent.stats.loaded;
    const throughput = Math.round((8 * downloadBytes) / throughputMeasureTime);

    this.harmonicMeanQ.push(1 / throughput);
    if (this.harmonicMeanQ.length > this.HARMONIC_MEAN_SIZE)
      this.harmonicMeanQ.shift();

    const sampleSize = this.harmonicMeanQ.length;
    let harmonicMean =
      1 / (this.harmonicMeanQ.reduce((a, b) => a + 1 / b) / sampleSize);
    harmonicMean = harmonicMean * this.THROUGHPUT_SAFETY_FACTOR;

    const HLSThroughput = !isNaN(hls.bandwidthEstimate)
      ? hls.bandwidthEstimate / 1000.0
      : config.abrEwmaDefaultEstimate / 1000.0;
    const lastThroughput = HLSThroughput * this.THROUGHPUT_SAFETY_FACTOR;

    const bitrates = hls.levels.map((b) => b.bitrate / 1000.0);
    const bitrateCount = bitrates.length;

    const higherQuality =
      currentQuality + 1 < bitrateCount ? currentQuality + 1 : currentQuality;
    const lowerQuality =
      currentQuality - 1 > 0 ? currentQuality - 1 : currentQuality;

    if (lastThroughput < bitrates[currentQuality]) {
      //switch down
      quality = lowerQuality;
    } else if (
      harmonicMean > bitrates[higherQuality] &&
      lastThroughput > bitrates[higherQuality] &&
      bufferLevel >= this.MIN_BUFFER_LEVEL
    ) {
      //switch up
      quality = higherQuality;
    } else {
      //stay the same
      quality = currentQuality;
    }

    return quality;
  }
}
