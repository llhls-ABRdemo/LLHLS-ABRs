import EwmaBandWidthEstimator from '../utils/ewma-bandwidth-estimator';
import { Events } from '../events';
import { BufferHelper } from '../utils/buffer-helper';
import { ErrorDetails } from '../errors';
import { PlaylistLevelType } from '../types/loader';
import { logger } from '../utils/logger';
import type { Bufferable } from '../utils/buffer-helper';
import type { Fragment } from '../loader/fragment';
import type { Part } from '../loader/fragment';
import type { LoaderStats } from '../types/loader';
import type Hls from '../hls';
import type {
  FragLoadingData,
  FragLoadedData,
  FragBufferedData,
  ErrorData,
  LevelLoadedData,
} from '../types/events';
import type { ComponentAPI } from '../types/component-api';
import LoLpWeightSelector from './LoLpWeightSelector';
import LoLpQoeEvaluator from './LoLpQoeEvaluator';
import LearningAbrController from './LoLpRule';
import L2ARule, { l2AParametersDict, l2AStateDict } from './L2ARule';
import LlamaABR from './LlamaRule';
import StallionRule from './StallionRule';

class AbrController implements ComponentAPI {
  protected hls: Hls;
  private lastLoadedFragLevel: number = 0;
  private _nextAutoLevel: number = -1;
  private timer?: number;
  private onCheck: Function = this._abandonRulesCheck.bind(this);
  private fragCurrent: Fragment | null = null;
  private partCurrent: Part | null = null;
  private bitrateTestDelay: number = 0;

  public readonly bwEstimator: EwmaBandWidthEstimator;

  static readonly WEIGHT_SELECTION_MODES = {
    MANUAL: 'manual_weight_selection',
    RANDOM: 'random_weight_selection',
    DYNAMIC: 'dynamic_weight_selection',
  };

  private readonly useLoLpPlayback: boolean = true;
  private readonly liveCatchupPlaybackRate: number = 0.3;
  private readonly liveCatchUpMinDrift: number = 0.05;
  private readonly playbackBufferMin: number = 0.5;
  private readonly targetLatency: number = 1.5;
  private readonly liveCatchupLatencyThreshold: number = 60;

  private l2aRule: L2ARule | null = null;
  private l2AStateDict: l2AStateDict = {};
  private l2AParameterDict: l2AParametersDict = {};

  private llama: LlamaABR | null = null;
  private stallionRule: StallionRule | null = null;

  private lolpQoE: number | null = null;
  private ABRRule: string = 'LoLp';
  private lastABRRule: string = 'LoLp';
  private boxThroughputOn: boolean = true;

  constructor(hls: Hls) {
    this.hls = hls;

    const config = hls.config;
    this.bwEstimator = new EwmaBandWidthEstimator(
      config.abrEwmaSlowVoD,
      config.abrEwmaFastVoD,
      config.abrEwmaDefaultEstimate
    );

    this.registerListeners();
  }

  protected registerListeners() {
    const { hls } = this;
    hls.on(Events.FRAG_LOADING, this.onFragLoading, this);
    hls.on(Events.FRAG_LOADED, this.onFragLoaded, this);
    hls.on(Events.FRAG_BUFFERED, this.onFragBuffered, this);
    hls.on(Events.LEVEL_LOADED, this.onLevelLoaded, this);
    hls.on(Events.ERROR, this.onError, this);
  }

  protected unregisterListeners() {
    const { hls } = this;
    hls.off(Events.FRAG_LOADING, this.onFragLoading, this);
    hls.off(Events.FRAG_LOADED, this.onFragLoaded, this);
    hls.off(Events.FRAG_BUFFERED, this.onFragBuffered, this);
    hls.off(Events.LEVEL_LOADED, this.onLevelLoaded, this);
    hls.off(Events.ERROR, this.onError, this);
  }

  public destroy() {
    this.unregisterListeners();
    this.clearTimer();
  }

  protected onFragLoading(event: Events.FRAG_LOADING, data: FragLoadingData) {
    const frag = data.frag;
    if (frag.type === PlaylistLevelType.MAIN) {
      if (!this.timer) {
        this.fragCurrent = frag;
        this.partCurrent = data.part ?? null;
        this.timer = self.setInterval(this.onCheck, 100);
      }
    }
  }

  protected onLevelLoaded(event: Events.LEVEL_LOADED, data: LevelLoadedData) {
    const config = this.hls.config;
    if (data.details.live) {
      this.bwEstimator.update(config.abrEwmaSlowLive, config.abrEwmaFastLive);
    } else {
      this.bwEstimator.update(config.abrEwmaSlowVoD, config.abrEwmaFastVoD);
    }
  }

  /*
      This method monitors the download rate of the current fragment, and will downswitch if that fragment will not load
      quickly enough to prevent underbuffering
    */
  private _abandonRulesCheck() {
    const { fragCurrent: frag, partCurrent: part, hls } = this;
    const { autoLevelEnabled, config, media } = hls;
    if (!frag || !media) {
      return;
    }

    const stats: LoaderStats = part ? part.stats : frag.stats;
    const duration = part ? part.duration : frag.duration;
    // If loading has been aborted and not in lowLatencyMode, stop timer and return
    if (stats.aborted) {
      logger.warn('frag loader destroy or aborted, disarm abandonRules');
      this.clearTimer();
      // reset forced auto level value so that next level will be selected
      this._nextAutoLevel = -1;
      return;
    }

    // This check only runs if we're in ABR mode and actually playing
    if (
      !autoLevelEnabled ||
      media.paused ||
      !media.playbackRate ||
      !media.readyState
    ) {
      return;
    }

    const requestDelay = performance.now() - stats.loading.start;
    const playbackRate = Math.abs(media.playbackRate);
    // In order to work with a stable bandwidth, only begin monitoring bandwidth after half of the fragment has been loaded
    if (requestDelay <= (500 * duration) / playbackRate) {
      return;
    }

    const { levels, minAutoLevel } = hls;
    const level = levels[frag.level];
    const expectedLen =
      stats.total ||
      Math.max(stats.loaded, Math.round((duration * level.maxBitrate) / 8));
    const loadRate = Math.max(
      1,
      stats.bwEstimate
        ? stats.bwEstimate / 8
        : (stats.loaded * 1000) / requestDelay
    );
    // fragLoadDelay is an estimate of the time (in seconds) it will take to buffer the entire fragment
    const fragLoadedDelay = (expectedLen - stats.loaded) / loadRate;

    const pos = media.currentTime;
    // bufferStarvationDelay is an estimate of the amount time (in seconds) it will take to exhaust the buffer
    const bufferStarvationDelay =
      (BufferHelper.bufferInfo(media, pos, config.maxBufferHole).end - pos) /
      playbackRate;

    // Attempt an emergency downswitch only if less than 2 fragment lengths are buffered, and the time to finish loading
    // the current fragment is greater than the amount of buffer we have left
    if (
      bufferStarvationDelay >= (2 * duration) / playbackRate ||
      fragLoadedDelay <= bufferStarvationDelay
    ) {
      return;
    }

    let fragLevelNextLoadedDelay: number = Number.POSITIVE_INFINITY;
    let nextLoadLevel: number;
    // Iterate through lower level and try to find the largest one that avoids rebuffering
    for (
      nextLoadLevel = frag.level - 1;
      nextLoadLevel > minAutoLevel;
      nextLoadLevel--
    ) {
      // compute time to load next fragment at lower level
      // 0.8 : consider only 80% of current bw to be conservative
      // 8 = bits per byte (bps/Bps)
      const levelNextBitrate = levels[nextLoadLevel].maxBitrate;
      fragLevelNextLoadedDelay =
        (duration * levelNextBitrate) / (8 * 0.8 * loadRate);

      if (fragLevelNextLoadedDelay < bufferStarvationDelay) {
        break;
      }
    }
    // Only emergency switch down if it takes less time to load a new fragment at lowest level instead of continuing
    // to load the current one
    if (fragLevelNextLoadedDelay >= fragLoadedDelay) {
      return;
    }
    const bwEstimate: number = this.bwEstimator.getEstimate();
    logger.warn(`Fragment ${frag.sn}${
      part ? ' part ' + part.index : ''
    } of level ${
      frag.level
    } is loading too slowly and will cause an underbuffer; aborting and switching to level ${nextLoadLevel}
      Current BW estimate: ${
        Number.isFinite(bwEstimate) ? (bwEstimate / 1024).toFixed(3) : 'Unknown'
      } Kb/s
      Estimated load time for current fragment: ${fragLoadedDelay.toFixed(3)} s
      Estimated load time for the next fragment: ${fragLevelNextLoadedDelay.toFixed(
        3
      )} s
      Time to underbuffer: ${bufferStarvationDelay.toFixed(3)} s`);
    hls.nextLoadLevel = nextLoadLevel;
    this.bwEstimator.sample(requestDelay, stats.loaded);
    this.clearTimer();
    if (frag.loader) {
      this.fragCurrent = this.partCurrent = null;
      frag.loader.abort();
    }
    hls.trigger(Events.FRAG_LOAD_EMERGENCY_ABORTED, { frag, part, stats });
  }

  protected onFragLoaded(
    event: Events.FRAG_LOADED,
    { frag, part }: FragLoadedData
  ) {
    if (
      frag.type === PlaylistLevelType.MAIN &&
      Number.isFinite(frag.sn as number)
    ) {
      const stats = part ? part.stats : frag.stats;
      const duration = part ? part.duration : frag.duration;
      // stop monitoring bw once frag loaded
      this.clearTimer();
      // store level id after successful fragment load
      this.lastLoadedFragLevel = frag.level;
      // reset forced auto level value so that next level will be selected
      this._nextAutoLevel = -1;

      // compute level average bitrate
      if (this.hls.config.abrMaxWithRealBitrate) {
        const level = this.hls.levels[frag.level];
        const loadedBytes =
          (level.loaded ? level.loaded.bytes : 0) + stats.loaded;
        const loadedDuration =
          (level.loaded ? level.loaded.duration : 0) + duration;
        level.loaded = { bytes: loadedBytes, duration: loadedDuration };
        level.realBitrate = Math.round((8 * loadedBytes) / loadedDuration);
      }
      if (frag.bitrateTest) {
        const fragBufferedData: FragBufferedData = {
          stats,
          frag,
          part,
          id: frag.type,
        };
        this.onFragBuffered(Events.FRAG_BUFFERED, fragBufferedData);
        frag.bitrateTest = false;
      }
    }
  }

  protected onFragBuffered(
    event: Events.FRAG_BUFFERED,
    data: FragBufferedData
  ) {
    const { frag, part } = data;
    const stats = part ? part.stats : frag.stats;

    if (stats.aborted) {
      return;
    }
    // Only count non-alt-audio frags which were actually buffered in our BW calculations
    if (frag.type !== PlaylistLevelType.MAIN || frag.sn === 'initSegment') {
      return;
    }
    // Use the difference between parsing and request instead of buffering and request to compute fragLoadingProcessing;
    // rationale is that buffer appending only happens once media is attached. This can happen when config.startFragPrefetch
    // is used. If we used buffering in that case, our BW estimate sample will be very large.
    const processingMs = stats.parsing.end - stats.loading.start;
    const fragProcessingMs = frag.stats.loading.end - frag.stats.loading.start;
    if (this.boxThroughputOn) {
      // Filter the first and last chunks in a segment in both arrays [StartTimeData and EndTimeData]
      const _startTD = frag.stats.startTimeData;
      const _endTD = frag.stats.endTimeData;
      const startData = _startTD.filter(
        (data, i) => i > 0 && i < _startTD.length - 1
      );
      const endData = _endTD.filter(
        (dataE, i) => i > 0 && i < _endTD.length - 1
      );
      if (startData.length * endData.length > 0) {
        const boxProcessingMs =
          endData[endData.length - 1].timestamp - startData[0].timestamp;
        const boxLoaded = frag.stats.boxLoaded - _endTD[_endTD.length - 1].len;
        this.bwEstimator.sample(boxProcessingMs, boxLoaded);
      } else {
        this.bwEstimator.sample(fragProcessingMs, frag.stats.loaded);
      }
    } else {
      if (stats.loaded != 0)
        this.bwEstimator.sample(processingMs, stats.loaded);
      else this.bwEstimator.sample(fragProcessingMs, frag.stats.loaded);
    }

    stats.bwEstimate = this.bwEstimator.getEstimate();
    if (frag.bitrateTest) {
      this.bitrateTestDelay = processingMs / 1000;
    } else {
      this.bitrateTestDelay = 0;
    }
  }

  protected onError(event: Events.ERROR, data: ErrorData) {
    // stop timer in case of frag loading error
    switch (data.details) {
      case ErrorDetails.FRAG_LOAD_ERROR:
      case ErrorDetails.FRAG_LOAD_TIMEOUT:
        this.clearTimer();
        break;
      default:
        break;
    }
  }

  clearTimer() {
    self.clearInterval(this.timer);
    this.timer = undefined;
  }

  // return next auto level
  get nextAutoLevel() {
    const forcedAutoLevel = this._nextAutoLevel;
    const bwEstimator = this.bwEstimator;
    // in case next auto level has been forced, and bw not available or not reliable, return forced value
    if (
      forcedAutoLevel !== -1 &&
      (!bwEstimator || !bwEstimator.canEstimate())
    ) {
      return forcedAutoLevel;
    }

    // compute next level using ABR logic
    switch (this.lastABRRule) {
      case 'L2ARule':
        if (this.ABRRule !== 'L2ARule') {
          this.l2aRule?.unregisterListeners();
          this.l2aRule = null;
        }
        break;
      case 'Llama':
        if (this.ABRRule !== 'Llama') this.llama = null;
        break;
      case 'StallionRule':
        if (this.ABRRule !== 'StallionRule') this.stallionRule = null;
        break;
    }
    let nextABRAutoLevel = 0;
    switch (this.ABRRule) {
      case 'LoLp':
        nextABRAutoLevel = this._lolpLearningAbr();
        break;
      case 'L2ARule':
        nextABRAutoLevel = this._L2AAbr();
        break;
      case 'Llama':
        nextABRAutoLevel = this._LlamaAbr();
        break;
      case 'StallionRule':
        nextABRAutoLevel = this._StallionAbr();
        break;
      default:
        nextABRAutoLevel = this.getNextABRAutoLevel();
    }
    // if forced auto level has been defined, use it to cap ABR computed quality level
    if (forcedAutoLevel !== -1) {
      nextABRAutoLevel = Math.min(forcedAutoLevel, nextABRAutoLevel);
    }

    return nextABRAutoLevel;
  }

  private getNextABRAutoLevel() {
    const { fragCurrent, partCurrent, hls } = this;
    const { maxAutoLevel, config, minAutoLevel, media } = hls;
    const currentFragDuration = partCurrent
      ? partCurrent.duration
      : fragCurrent
      ? fragCurrent.duration
      : 0;
    const pos = media ? media.currentTime : 0;

    // playbackRate is the absolute value of the playback rate; if media.playbackRate is 0, we use 1 to load as
    // if we're playing back at the normal rate.
    const playbackRate =
      media && media.playbackRate !== 0 ? Math.abs(media.playbackRate) : 1.0;
    const avgbw = this.bwEstimator
      ? this.bwEstimator.getEstimate()
      : config.abrEwmaDefaultEstimate;
    // bufferStarvationDelay is the wall-clock time left until the playback buffer is exhausted.
    const bufferStarvationDelay =
      (BufferHelper.bufferInfo(media as Bufferable, pos, config.maxBufferHole)
        .end -
        pos) /
      playbackRate;

    this.calculateQoE();

    // First, look to see if we can find a level matching with our avg bandwidth AND that could also guarantee no rebuffering at all
    let bestLevel = this.findBestLevel(
      avgbw,
      minAutoLevel,
      maxAutoLevel,
      bufferStarvationDelay,
      config.abrBandWidthFactor,
      config.abrBandWidthUpFactor
    );
    if (bestLevel >= 0) {
      return bestLevel;
    }
    logger.trace(
      `${
        bufferStarvationDelay ? 'rebuffering expected' : 'buffer is empty'
      }, finding optimal quality level`
    );
    // not possible to get rid of rebuffering ... let's try to find level that will guarantee less than maxStarvationDelay of rebuffering
    // if no matching level found, logic will return 0
    let maxStarvationDelay = currentFragDuration
      ? Math.min(currentFragDuration, config.maxStarvationDelay)
      : config.maxStarvationDelay;
    let bwFactor = config.abrBandWidthFactor;
    let bwUpFactor = config.abrBandWidthUpFactor;

    if (!bufferStarvationDelay) {
      // in case buffer is empty, let's check if previous fragment was loaded to perform a bitrate test
      const bitrateTestDelay = this.bitrateTestDelay;
      if (bitrateTestDelay) {
        // if it is the case, then we need to adjust our max starvation delay using maxLoadingDelay config value
        // max video loading delay used in  automatic start level selection :
        // in that mode ABR controller will ensure that video loading time (ie the time to fetch the first fragment at lowest quality level +
        // the time to fetch the fragment at the appropriate quality level is less than ```maxLoadingDelay``` )
        // cap maxLoadingDelay and ensure it is not bigger 'than bitrate test' frag duration
        const maxLoadingDelay = currentFragDuration
          ? Math.min(currentFragDuration, config.maxLoadingDelay)
          : config.maxLoadingDelay;
        maxStarvationDelay = maxLoadingDelay - bitrateTestDelay;
        logger.trace(
          `bitrate test took ${Math.round(
            1000 * bitrateTestDelay
          )}ms, set first fragment max fetchDuration to ${Math.round(
            1000 * maxStarvationDelay
          )} ms`
        );
        // don't use conservative factor on bitrate test
        bwFactor = bwUpFactor = 1;
      }
    }
    bestLevel = this.findBestLevel(
      avgbw,
      minAutoLevel,
      maxAutoLevel,
      bufferStarvationDelay + maxStarvationDelay,
      bwFactor,
      bwUpFactor
    );
    return Math.max(bestLevel, 0);
  }

  private findBestLevel(
    currentBw: number,
    minAutoLevel: number,
    maxAutoLevel: number,
    maxFetchDuration: number,
    bwFactor: number,
    bwUpFactor: number
  ): number {
    const {
      fragCurrent,
      partCurrent,
      lastLoadedFragLevel: currentLevel,
    } = this;
    const { levels } = this.hls;
    const level = levels[currentLevel];
    const live = !!level?.details?.live;
    const currentCodecSet = level?.codecSet;

    const currentFragDuration = partCurrent
      ? partCurrent.duration
      : fragCurrent
      ? fragCurrent.duration
      : 0;
    for (let i = maxAutoLevel; i >= minAutoLevel; i--) {
      const levelInfo = levels[i];

      if (
        !levelInfo ||
        (currentCodecSet && levelInfo.codecSet !== currentCodecSet)
      ) {
        continue;
      }

      const levelDetails = levelInfo.details;
      const avgDuration =
        (partCurrent
          ? levelDetails?.partTarget
          : levelDetails?.averagetargetduration) || currentFragDuration;

      let adjustedbw: number;
      // follow algorithm captured from stagefright :
      // https://android.googlesource.com/platform/frameworks/av/+/master/media/libstagefright/httplive/LiveSession.cpp
      // Pick the highest bandwidth stream below or equal to estimated bandwidth.
      // consider only 80% of the available bandwidth, but if we are switching up,
      // be even more conservative (70%) to avoid overestimating and immediately
      // switching back.
      if (i <= currentLevel) {
        adjustedbw = bwFactor * currentBw;
      } else {
        adjustedbw = bwUpFactor * currentBw;
      }

      const bitrate: number = levels[i].maxBitrate;
      const fetchDuration: number = (bitrate * avgDuration) / adjustedbw;

      logger.trace(
        `level/adjustedbw/bitrate/avgDuration/maxFetchDuration/fetchDuration: ${i}/${Math.round(
          adjustedbw
        )}/${bitrate}/${avgDuration}/${maxFetchDuration}/${fetchDuration}`
      );
      // if adjusted bw is greater than level bitrate AND
      if (
        adjustedbw > bitrate &&
        // fragment fetchDuration unknown OR live stream OR fragment fetchDuration less than max allowed fetch duration, then this level matches
        // we don't account for max Fetch Duration for live streams, this is to avoid switching down when near the edge of live sliding window ...
        // special case to support startLevel = -1 (bitrateTest) on live streams : in that case we should not exit loop so that findBestLevel will return -1
        (!fetchDuration ||
          (live && !this.bitrateTestDelay) ||
          fetchDuration < maxFetchDuration)
      ) {
        // as we are looping from highest to lowest, this will return the best achievable quality level
        return i;
      }
    }
    // not enough time budget even with quality level 0 ... rebuffering might happen
    return -1;
  }

  set nextAutoLevel(nextLevel) {
    this._nextAutoLevel = nextLevel;
  }

  /**
   * Use LoL+ for bitrate selection
   * @returns {number} quality
   */
  private _lolpLearningAbr() {
    const DWS_TARGET_LATENCY = 1.5;
    const DWS_BUFFER_MIN = 0.3;

    const {
      fragCurrent,
      partCurrent,
      lastLoadedFragLevel: currentLevel,
      hls,
    } = this;
    const { config, media } = hls;
    const pos = media ? media.currentTime : 0;

    const learningController: LearningAbrController = new LearningAbrController(),
      qoeEvaluator: LoLpQoeEvaluator = new LoLpQoeEvaluator();

    const currentQuality = currentLevel;
    // let mediaType: string = PlaylistLevelType.MAIN;
    const mediaType = hls.levels[currentLevel]?.details
      ? hls.levels[currentLevel]?.details?.type
        ? hls.levels[currentLevel]?.details?.type
        : 'VOD'
      : 'VOD';

    const bufferStateVO = BufferHelper.bufferInfo(
      media,
      pos,
      config.maxBufferHole
    );
    // const scheduleController = rulesContext.getScheduleController();
    const currentBufferLevel = parseFloat(bufferStateVO.len.toFixed(2));
    let latency = hls.latency;

    // if (!rulesContext.useLoLPABR() || (mediaType === PlaylistLevelType.AUDIO)) {
    if (mediaType != 'VOD') {
      return currentQuality;
    }
    if (!fragCurrent || !media) {
      return currentQuality;
    }

    if (!latency) {
      latency = 0;
    }

    const playbackRate =
      media && media.playbackRate !== 0 ? Math.abs(media.playbackRate) : 1.0;
    const throughput = this.bwEstimator
      ? hls.bandwidthEstimate / 1000.0
      : config.abrEwmaDefaultEstimate / 1000.0;
    logger.debug(`Throughput ${Math.round(throughput)} kbps`);

    if (isNaN(throughput) || !bufferStateVO) {
      return currentQuality;
    }

    // if (abrController.getAbandonmentStateFor(mediaType) === MetricsConstants.ABANDON_LOAD) {
    //     return switchRequest;
    // }

    // QoE parameters
    const bitrateList = hls.levels; // [{bandwidth: 200000, width: 640, height: 360}, ...]
    const segmentDuration = fragCurrent
      ? fragCurrent.duration
      : partCurrent
      ? partCurrent.duration
      : 0;
    let minBitrateKbps = bitrateList[0].bitrate / 1000.0; // min bitrate level
    let maxBitrateKbps = bitrateList[bitrateList.length - 1].bitrate / 1000.0; // max bitrate level
    for (let i = 0; i < bitrateList.length; i++) {
      // in case bitrateList is not sorted as expected
      const b = bitrateList[i].bitrate / 1000.0;
      if (b > maxBitrateKbps) maxBitrateKbps = b;
      else if (b < minBitrateKbps) {
        minBitrateKbps = b;
      }
    }

    // Learning rule pre-calculations
    const currentBitrate = bitrateList[currentQuality].bitrate;
    const currentBitrateKbps = currentBitrate / 1000.0;
    const stats: LoaderStats = fragCurrent
      ? fragCurrent.stats
      : partCurrent!.stats;
    const lastFragmentDownloadTime =
      (stats.loading.end - stats.loading.start) / 1000;
    const segmentRebufferTime =
      lastFragmentDownloadTime > segmentDuration
        ? lastFragmentDownloadTime - segmentDuration
        : 0;
    qoeEvaluator.setupPerSegmentQoe(
      segmentDuration,
      maxBitrateKbps,
      minBitrateKbps
    );
    qoeEvaluator.logSegmentMetrics(
      currentBitrateKbps,
      segmentRebufferTime,
      latency,
      playbackRate
    );
    if (fragCurrent) this.lolpQoE = qoeEvaluator.getPerSegmentQoe()?.totalQoe;
    else this.lolpQoE = null;

    /*
     * Dynamic Weights Selector (step 1/2: initialization)
     */
    const dynamicWeightsSelector: LoLpWeightSelector = new LoLpWeightSelector({
      targetLatency: DWS_TARGET_LATENCY,
      bufferMin: DWS_BUFFER_MIN,
      segmentDuration,
      qoeEvaluator,
    });

    /*
     * Select next quality
     */
    const quality = learningController.getNextQuality(
      bitrateList,
      throughput * 1000,
      latency,
      currentBufferLevel,
      playbackRate,
      currentQuality,
      dynamicWeightsSelector
    );

    // scheduleController.setTimeToLoadDelay(0);

    if (media) media.playbackRate = this._LoLpPlaybackSpeed();

    // return switchRequest;
    return quality;
  }

  /**
   * Main function for playback speed control
   * @returns {number} newRate
   */
  private _LoLpPlaybackSpeed() {
    const { hls } = this;
    const { media } = hls;
    if (
      this.useLoLpPlayback &&
      media &&
      media.playbackRate > 0 &&
      !media.paused &&
      !media.seeking &&
      this._needToCatchUp()
    ) {
      return this.startPlaybackCatchUp();
    } else {
      return 1.0;
    }
  }

  /**
   * Apply catchup mode
   */
  private startPlaybackCatchUp() {
    const { hls } = this;
    const { config, media } = hls;
    const pos = media ? media.currentTime : 0;
    const bufferStateVO = BufferHelper.bufferInfo(
      media,
      pos,
      config.maxBufferHole
    );

    const currentPlaybackRate = media!.playbackRate;
    const liveCatchupPlaybackRate = this.liveCatchupPlaybackRate;
    const currentLiveLatency = hls.latency;
    const liveDelay = hls.targetLatency;
    const bufferLevel = parseFloat(bufferStateVO.len.toFixed(2));
    // Custom playback control: Based on buffer level
    const playbackBufferMin = this.playbackBufferMin;
    let newRate = this._calculateNewPlaybackRateLolP(
      liveCatchupPlaybackRate,
      currentLiveLatency,
      liveDelay,
      playbackBufferMin,
      bufferLevel,
      currentPlaybackRate
    );

    if (newRate === null) {
      newRate = media?.playbackRate;
    }
    // Obtain newRate and apply to video model
    // logger.log(`[playback-speed] >>> ${newRate} >>>`);
    return newRate;

    // const deltaLatency = currentLiveLatency - liveDelay!;
    // const maxDrift = hls.maxLatency - liveDelay!;
    // if (maxDrift > 0 && !isLowLatencySeekingInProgress &&
    //     deltaLatency > maxDrift) {
    //     logger.info('Low Latency catchup mechanism. Latency too high, doing a seek to live point');
    //     isLowLatencySeekingInProgress = true;
    //     seekToLive();
    // } else {
    //     isLowLatencySeekingInProgress = false;
    // }
  }

  /**
   * Checks whether the catchup mechanism should be enabled
   * @return {boolean}
   */
  private _needToCatchUp() {
    try {
      const { hls } = this;
      const { config, media } = hls;
      const pos = media ? media.currentTime : 0;
      const bufferStateVO = BufferHelper.bufferInfo(
        media,
        pos,
        config.maxBufferHole
      );
      const currentBuffer = parseFloat(bufferStateVO.len.toFixed(2));
      const currentLiveLatency = hls.latency;
      const liveDelay = hls.targetLatency;
      const liveCatchUpMinDrift = this.liveCatchUpMinDrift;
      const playbackBufferMin = this.playbackBufferMin;
      const liveCatchupLatencyThreshold = this.liveCatchupLatencyThreshold;

      return this._lolpNeedToCatchUpCustom(
        currentLiveLatency,
        liveDelay,
        liveCatchUpMinDrift,
        currentBuffer,
        playbackBufferMin,
        liveCatchupLatencyThreshold
      );
    } catch (e) {
      return false;
    }
  }

  /**
   * LoL+ logic to determine if catchup mode should be enabled
   * @param {number} currentLiveLatency
   * @param {number} liveDelay
   * @param {number} minDrift
   * @param {number} currentBuffer
   * @param {number} playbackBufferMin
   * @param {number} liveCatchupLatencyThreshold
   * @return {boolean}
   * @private
   */
  private _lolpNeedToCatchUpCustom(
    currentLiveLatency,
    liveDelay,
    minDrift,
    currentBuffer,
    playbackBufferMin,
    liveCatchupLatencyThreshold
  ) {
    try {
      const latencyDrift = Math.abs(currentLiveLatency - liveDelay);

      return (
        (isNaN(liveCatchupLatencyThreshold) ||
          currentLiveLatency <= liveCatchupLatencyThreshold) &&
        (latencyDrift > minDrift || currentBuffer < playbackBufferMin)
      );
    } catch (e) {
      return false;
    }
  }

  /**
   * Lol+ algorithm to calculate the new playback rate
   * @param {number} liveCatchUpPlaybackRate
   * @param {number} currentLiveLatency
   * @param {number} liveDelay
   * @param {number} minDrift
   * @param {number} playbackBufferMin
   * @param {number} bufferLevel
   * @param {number} currentPlaybackRate
   * @return {{newRate: number}}
   * @private
   */
  private _calculateNewPlaybackRateLolP(
    liveCatchUpPlaybackRate,
    currentLiveLatency,
    liveDelay,
    playbackBufferMin,
    bufferLevel,
    currentPlaybackRate
  ) {
    const cpr = liveCatchUpPlaybackRate;
    let newRate;

    // Hybrid: Buffer-based
    if (bufferLevel < playbackBufferMin) {
      // Buffer in danger, slow down
      const deltaBuffer = bufferLevel - playbackBufferMin; // -ve value
      const d = deltaBuffer * 5;

      // Playback rate must be between (1 - cpr) - (1 + cpr)
      // ex: if cpr is 0.5, it can have values between 0.5 - 1.5
      const s = (cpr * 2) / (1 + Math.pow(Math.E, -d));
      newRate = 1 - cpr + s;

      logger.debug(
        '[LoL+ playback control_buffer-based] bufferLevel: ' +
          bufferLevel +
          ', newRate: ' +
          newRate
      );
    } else {
      // Hybrid: Latency-based
      // Buffer is safe, vary playback rate based on latency

      // Check if latency is within range of target latency
      const minDifference = 0.02;
      if (
        Math.abs(currentLiveLatency - liveDelay) <=
        minDifference * liveDelay
      ) {
        newRate = 1;
      } else {
        const deltaLatency = currentLiveLatency - liveDelay;
        const d = deltaLatency * 5;

        // Playback rate must be between (1 - cpr) - (1 + cpr)
        // ex: if cpr is 0.5, it can have values between 0.5 - 1.5
        const s = (cpr * 2) / (1 + Math.pow(Math.E, -d));
        newRate = 1 - cpr + s;
      }

      logger.debug(
        '[LoL+ playback control_latency-based] latency: ' +
          currentLiveLatency +
          ', newRate: ' +
          newRate
      );
    }

    // if (playbackStalled) {
    //     if (bufferLevel > liveDelay / 2) {
    //         playbackStalled = false;
    //     }
    // }

    const ua =
      typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';

    // Detect safari browser (special behavior for low latency streams)
    const isSafari = /safari/.test(ua) && !/chrome/.test(ua);
    const minPlaybackRateChange = isSafari ? 0.25 : 0.02;

    // don't change playbackrate for small variations (don't overload element with playbackrate changes)
    if (Math.abs(currentPlaybackRate - newRate) <= minPlaybackRateChange) {
      newRate = null;
    }

    return newRate;
  }

  /**
   * Calculate QoE for the current stats
   */
  private calculateQoE() {
    const { fragCurrent, lastLoadedFragLevel: currentLevel, hls } = this;
    if (fragCurrent) {
      // calculate QoE
      const qoeEvaluator: LoLpQoeEvaluator = new LoLpQoeEvaluator();
      // QoE parameters
      const bitrateList = hls.levels; // [{bandwidth: 200000, width: 640, height: 360}, ...]
      const segmentDuration = fragCurrent.duration;
      let minBitrateKbps = bitrateList[0].bitrate / 1000.0; // min bitrate level
      let maxBitrateKbps = bitrateList[bitrateList.length - 1].bitrate / 1000.0; // max bitrate level
      for (let i = 0; i < bitrateList.length; i++) {
        // in case bitrateList is not sorted as expected
        const b = bitrateList[i].bitrate / 1000.0;
        if (b > maxBitrateKbps) maxBitrateKbps = b;
        else if (b < minBitrateKbps) {
          minBitrateKbps = b;
        }
      }

      // Learning rule pre-calculations
      const currentBitrate = bitrateList[currentLevel].bitrate;
      const currentBitrateKbps = currentBitrate / 1000.0;
      const stats: LoaderStats = fragCurrent.stats;
      const lastFragmentDownloadTime =
        (stats.loading.end - stats.loading.start) / 1000;
      const segmentRebufferTime =
        lastFragmentDownloadTime > segmentDuration
          ? lastFragmentDownloadTime - segmentDuration
          : 0;
      qoeEvaluator.setupPerSegmentQoe(
        segmentDuration,
        maxBitrateKbps,
        minBitrateKbps
      );
      qoeEvaluator.logSegmentMetrics(
        currentBitrateKbps,
        segmentRebufferTime,
        hls.latency,
        hls.media?.playbackRate
      );

      this.lolpQoE = qoeEvaluator.getPerSegmentQoe()?.totalQoe;
    } else this.lolpQoE = null;
  }

  /**
   * Use L2ARule for bitrate selection
   * @returns {number} quality
   */
  private _L2AAbr() {
    const {
      fragCurrent,
      partCurrent,
      lastLoadedFragLevel: currentLevel,
      hls,
    } = this;
    if (this.l2aRule === null) {
      this.l2aRule = new L2ARule({
        hls: hls,
        fragCurrent: fragCurrent,
        partCurrent: partCurrent,
        currentQuality: currentLevel,
      });
    } else {
      this.l2aRule.update({
        hls: hls,
        fragCurrent: fragCurrent,
        partCurrent: partCurrent,
        currentQuality: currentLevel,
      });
    }
    const quality = this.l2aRule.getMaxIndex();

    this.calculateQoE();
    // hls.latencyController.timeupdate();
    return quality;
  }

  /**
   * Use Llama ABR rule for bitrate selection
   * @returns {number} quality
   */
  private _LlamaAbr() {
    const {
      fragCurrent,
      partCurrent,
      lastLoadedFragLevel: currentLevel,
      hls,
    } = this;
    if (this.llama === null) {
      if (fragCurrent !== null)
        this.llama = new LlamaABR({
          hls: hls,
          fragCurrent: fragCurrent,
          partCurrent: partCurrent,
          currentQuality: currentLevel,
        });
    } else {
      this.llama.update({
        hls: hls,
        fragCurrent: fragCurrent,
        partCurrent: partCurrent,
        currentQuality: currentLevel,
      });
    }
    const quality = this.llama === null ? 0 : this.llama.getMaxIndex();

    this.calculateQoE();
    return quality;
  }

  /**
   * Use Stallion ABR rule for bitrate selection
   * @returns {number} quality
   */
  private _StallionAbr() {
    const {
      fragCurrent,
      partCurrent,
      lastLoadedFragLevel: currentLevel,
      hls,
    } = this;
    if (this.stallionRule === null) {
      this.stallionRule = new StallionRule({
        hls: hls,
        fragCurrent: fragCurrent,
        partCurrent: partCurrent,
        currentQuality: currentLevel,
      });
    } else {
      this.stallionRule.update({
        hls: hls,
        fragCurrent: fragCurrent,
        partCurrent: partCurrent,
        currentQuality: currentLevel,
      });
    }
    const quality = this.stallionRule.getMaxIndex();

    this.calculateQoE();
    return quality;
  }
}

export default AbrController;
