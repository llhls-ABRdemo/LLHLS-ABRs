/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2020, Unified Streaming.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */

import Hls, { Fragment } from '../hls';
import { Events } from '../events';
import { ErrorDetails } from '../errors';
import {
  ErrorData,
  FragLoadedData,
  FragParsedData,
  LevelSwitchingData,
} from '../types/events';
import { PlaylistLevelType } from '../types/loader';
import { BufferHelper } from '../utils/buffer-helper';
import { Part } from '../loader/fragment';
import { logger } from '../utils/logger';

// For a description of the Learn2Adapt-LowLatency (L2A-LL) bitrate adaptation algorithm, see https://github.com/unifiedstreaming/Learn2Adapt-LowLatency/blob/master/Online_learning_for_bitrate_adaptation_in_low_latency_live_streaming_CR.pdf

const L2A_STATE_ONE_BITRATE = 0; // If there is only one bitrate (or initialization failed), always return NO_CHANGE.
const L2A_STATE_STARTUP = 1; // Set placeholder buffer such that we download fragments at most recently measured throughput.
const L2A_STATE_STEADY = 2; // Buffer primed, we switch to steady operation.

// interface iniState {
//     state: number;
//     bitrates: number[];
//     lastQuality: number;
// };

interface l2AState {
  state: number;
  bitrates: number[];
  abrQuality: number;
  lastQuality: number;
  lastSegmentStart: number;
  lastSegmentDurationS: number;
  lastSegmentRequestTimeMs: number;
  lastSegmentFinishTimeMs: number;
  mostAdvancedSegmentStart: number;
  lastSegmentWasReplacement: boolean;
  placeholderBuffer: number;
}

interface l2AParameters {
  Q: number;
  w: number[];
  prev_w: number[];
  B_target: number;
  segment_request_start_s: number;
  segment_download_finish_s: number;
}

export type l2AStateDict = Record<string, l2AState>;

export type l2AParametersDict = Record<string, l2AParameters>;

export default class L2ARule {
  private hls: Hls;
  private fragCurrent: Fragment;
  private partCurrent: Part;
  private currentQuality: number;
  private l2AStateDict: l2AStateDict;
  private l2AParameterDict: l2AParametersDict;

  constructor(config) {
    this.hls = config.hls;
    this.fragCurrent = config.fragCurrent;
    this.partCurrent = config.partCurrent;
    this.currentQuality = config.currentQuality;
    this.l2AStateDict = {};
    this.l2AParameterDict = {};
    this.registerListeners();
  }

  /**
   * Register listeners used by L2ARule
   * @private
   */
  private registerListeners() {
    const { hls } = this;
    hls.on(Events.ERROR, this._onPlaybackSeeking, this);
    hls.on(Events.FRAG_LOADED, this._onMediaFragmentLoaded, this);
    hls.on(Events.FRAG_PARSED, this._onMetricAdded, this);
    hls.on(Events.LEVEL_SWITCHING, this._onQualityChangeRequested, this);
  }

  /**
   * Unregister listeners used by L2ARule before quit
   */
  unregisterListeners() {
    const { hls } = this;
    hls.off(Events.ERROR, this._onPlaybackSeeking, this);
    hls.off(Events.FRAG_LOADED, this._onMediaFragmentLoaded, this);
    hls.off(Events.FRAG_PARSED, this._onMetricAdded, this);
    hls.off(Events.LEVEL_SWITCHING, this._onQualityChangeRequested, this);
  }

  /**
   * Update fragment and current quality at each boundary
   */
  update(config) {
    this.hls = config.hls;
    this.fragCurrent = config.fragCurrent;
    this.partCurrent = config.partCurrent;
    this.currentQuality = config.currentQuality;
  }

  /**
   * Sets the initial state of the algorithm. Calls the initialize function for the paramteters.
   * @param {PlaylistLevelType} mediaType
   * @return {iniState} initialState
   * @private
   */
  private _getInitialL2AState(mediaType: PlaylistLevelType) {
    const { hls } = this;
    const bitrates = hls.levels.map((b) => {
      return b.bitrate / 1000;
    });

    const initialState: l2AState = {
      state: L2A_STATE_STARTUP,
      bitrates: bitrates,
      lastQuality: 0,
      abrQuality: 0,
      placeholderBuffer: 0,
      mostAdvancedSegmentStart: NaN,
      lastSegmentWasReplacement: false,
      lastSegmentStart: NaN,
      lastSegmentDurationS: NaN,
      lastSegmentRequestTimeMs: NaN,
      lastSegmentFinishTimeMs: NaN,
    };

    this._initializeL2AParameters(mediaType);

    return initialState;
  }

  /**
   * Initializes the parameters of the algorithm. This will be done once for each media type.
   * @param {PlaylistLevelType} mediaType
   * @private
   */
  private _initializeL2AParameters(mediaType: PlaylistLevelType) {
    const { l2AParameterDict } = this;

    if (!mediaType) {
      return;
    }
    l2AParameterDict[mediaType] = {
      Q: 0, //Initialization of Lagrangian multiplier (This keeps track of the buffer displacement)
      w: [], //Vector of probabilities associated with bitrate decisions
      prev_w: [], //Vector of probabilities associated with bitrate decisions calculated in the previous step
      B_target: 1.5, //Target buffer level
      segment_request_start_s: 0,
      segment_download_finish_s: 0,
    };
  }

  /**
   * Clears the state object
   * @param {l2AState} l2AState
   * @private
   */
  private _clearL2AStateOnSeek(l2AState) {
    l2AState.placeholderBuffer = 0;
    l2AState.mostAdvancedSegmentStart = NaN;
    l2AState.lastSegmentWasReplacement = false;
    l2AState.lastSegmentStart = NaN;
    l2AState.lastSegmentDurationS = NaN;
    l2AState.lastSegmentRequestTimeMs = NaN;
    l2AState.lastSegmentFinishTimeMs = NaN;
  }

  /**
   * Returns the state object for a fiven media type. If the state object is not yet defined _getInitialL2AState is called
   * @param {PlaylistLevelType} mediaType
   * @return {l2AState} l2AState
   * @private
   */
  private _getL2AState(mediaType: PlaylistLevelType) {
    const { l2AStateDict } = this;
    let l2AState: l2AState = l2AStateDict[mediaType];

    if (!l2AState) {
      l2AState = this._getInitialL2AState(mediaType);
      l2AStateDict[mediaType] = l2AState;
    }
    return l2AState;
  }

  /**
   * Event handler for the seeking event.
   * @param {Events.ERROR} eventName
   * @param {ErrorData} data
   * @private
   */
  private _onPlaybackSeeking(eventName, data: ErrorData) {
    if (data.details === ErrorDetails.BUFFER_STALLED_ERROR) {
      const { l2AStateDict } = this;
      for (const mediaType in l2AStateDict) {
        if (l2AStateDict.hasOwnProperty(mediaType)) {
          const l2aState = l2AStateDict[mediaType];
          if (l2aState.state !== L2A_STATE_ONE_BITRATE) {
            l2aState.state = L2A_STATE_STARTUP;
            this._clearL2AStateOnSeek(l2aState);
          }
        }
      }
    }
  }

  /**
   * Event handler for the mediaFragmentLoaded event
   * @param {Events.FRAG_LOADED} eventName
   * @param {FragLoadedData} data
   * @private
   */
  private _onMediaFragmentLoaded(eventName, data: FragLoadedData) {
    const { l2AParameterDict, l2AStateDict } = this;
    if (data.frag) {
      const frag: Fragment = data.frag;
      const l2AState = l2AStateDict[frag.type];
      const l2AParameters = l2AParameterDict[frag.type];

      if (l2AState && l2AState.state !== L2A_STATE_ONE_BITRATE) {
        const start = frag.start;
        if (
          isNaN(l2AState.mostAdvancedSegmentStart) ||
          start > l2AState.mostAdvancedSegmentStart
        ) {
          l2AState.mostAdvancedSegmentStart = start;
          l2AState.lastSegmentWasReplacement = false;
        } else {
          l2AState.lastSegmentWasReplacement = true;
        }

        l2AState.lastSegmentStart = start;
        l2AState.lastSegmentDurationS = frag.duration; // ???
        l2AState.lastQuality = frag.level;

        this._checkNewSegment(l2AState, l2AParameters);
      }
    }
    // logger.log(
    //   `>>> LOADED!!!!!l2AStateDict[mediaType]: ${data.frag.type} ${
    //     l2AStateDict[data.frag.type].lastSegmentDurationS
    //   } >>>`
    // );
  }

  /**
   * Event handler for the metricAdded event
   * @param {Events.FRAG_PARSED} eventName
   * @private
   */
  private _onMetricAdded(eventName, data: FragParsedData) {
    const { l2AParameterDict, l2AStateDict } = this;
    const { frag } = data;
    if (frag) {
      const l2AState = l2AStateDict[frag.type];
      const l2AParameters = l2AParameterDict[frag.type];

      if (l2AState && l2AState.state !== L2A_STATE_ONE_BITRATE) {
        l2AState.lastSegmentRequestTimeMs = frag.stats.loading.start;
        l2AState.lastSegmentFinishTimeMs = frag.stats.parsing.end;
        this._checkNewSegment(l2AState, l2AParameters);
      }
    }
  }

  /**
   * When a new metric has been added or a media fragment has been loaded the state is adjusted accordingly
   * @param {l2AState} L2AState
   * @param {l2AParameters} l2AParameters
   * @private
   */
  private _checkNewSegment(L2AState, l2AParameters) {
    if (
      !isNaN(L2AState.lastSegmentStart) &&
      !isNaN(L2AState.lastSegmentRequestTimeMs)
    ) {
      l2AParameters.segment_request_start_s =
        0.001 * L2AState.lastSegmentRequestTimeMs;
      l2AParameters.segment_download_finish_s =
        0.001 * L2AState.lastSegmentFinishTimeMs;
      L2AState.lastSegmentStart = NaN;
      L2AState.lastSegmentRequestTimeMs = NaN;
    }
  }

  /**
   * Event handler for the qualityChangeRequested event
   * @param {Events.LEVEL_SWITCHING} eventName
   * @param {LevelSwitchingData} data
   * @private
   */
  private _onQualityChangeRequested(eventName, data: LevelSwitchingData) {
    const { l2AStateDict, fragCurrent } = this;
    const mediaType = fragCurrent ? fragCurrent.type : PlaylistLevelType.MAIN;
    // Useful to store change requests when abandoning a download.
    if (data) {
      const L2AState = l2AStateDict[mediaType];
      if (L2AState && L2AState.state !== L2A_STATE_ONE_BITRATE) {
        L2AState.abrQuality = data.level;
      }
    }
  }

  /**
   * Dot multiplication of two arrays
   * @param {array} arr1
   * @param {array} arr2
   * @return {number} sumdot
   * @private
   */
  private _dotmultiplication(arr1, arr2) {
    if (arr1.length !== arr2.length) {
      return -1;
    }
    let sumdot = 0;
    for (let i = 0; i < arr1.length; i++) {
      sumdot = sumdot + arr1[i] * arr2[i];
    }
    return sumdot;
  }

  /**
   * Project an n-dim vector y to the simplex Dn
   * Dn = { x : x n-dim, 1 >= x >= 0, sum(x) = 1}
   * Algorithm is explained at http://arxiv.org/abs/1101.6081
   * @param {array} arr
   * @return {array}
   * @private
   */
  private euclideanProjection(arr) {
    const m = arr.length;
    let bget = false;
    const arr2: number[] = [];
    for (let ii = 0; ii < m; ++ii) {
      arr2[ii] = arr[ii];
    }
    const s = arr.sort(function (a, b) {
      return b - a;
    });
    let tmpsum = 0;
    let tmax = 0;
    const x: number[] = [];
    for (let ii = 0; ii < m - 1; ++ii) {
      tmpsum = tmpsum + s[ii];
      tmax = (tmpsum - 1) / (ii + 1);
      if (tmax >= s[ii + 1]) {
        bget = true;
        break;
      }
    }
    if (!bget) {
      tmax = (tmpsum + s[m - 1] - 1) / m;
    }
    for (let ii = 0; ii < m; ++ii) {
      x[ii] = Math.max(arr2[ii] - tmax, 0);
    }
    return x;
  }

  /**
   * @param {number} bitrate A bitrate value, kbps
   * @returns {number} A quality index <= for the given bitrate
   * @memberof AbrController#
   */
  getQualityForBitrate(bitrate) {
    const { hls, fragCurrent } = this;
    const { latency } = hls;

    if (latency && fragCurrent) {
      const fragmentDuration = fragCurrent.duration;
      const targetLatency = hls.targetLatency ? hls.targetLatency : 0;
      const deltaLatency = Math.abs(latency - targetLatency);
      logger.log(
        `>>> latency: ${latency} target: ${targetLatency} delta: ${deltaLatency} fragDuration: ${fragmentDuration} >>>`
      );
      if (deltaLatency > fragmentDuration) {
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

  /**
   * Returns the quality level to be played
   * @return {number} quality
   */
  getMaxIndex() {
    const { l2AParameterDict, hls, fragCurrent } = this;
    const { config, media } = hls;
    const horizon = 4; // Optimization horizon (The amount of steps required to achieve convergence)
    const vl = Math.pow(horizon, 0.99); // Cautiousness parameter, used to control aggressiveness of the bitrate decision process.
    const alpha = Math.max(Math.pow(horizon, 1), vl * Math.sqrt(horizon)); // Step size, used for gradient descent exploration granularity
    const bitrates = hls.levels.map((b) => b.bitrate);
    const bitrateCount = bitrates.length;
    const throughput = !isNaN(hls.bandwidthEstimate)
      ? hls.bandwidthEstimate / 1000.0
      : config.abrEwmaDefaultEstimate / 1000.0;
    const useL2AABR = true;
    const pos = media ? media.currentTime : 0;
    const bufferStateVO = BufferHelper.bufferInfo(
      media,
      pos,
      config.maxBufferHole
    );
    const bufferLevel = parseFloat(bufferStateVO.len.toFixed(2));
    const react = 2; // Reactiveness to volatility (abrupt throughput drops), used to re-calibrate Lagrangian multiplier Q
    let quality: number = 0;
    const currentPlaybackRate = media ? media.playbackRate : 1;
    const mediaType = fragCurrent ? fragCurrent.type : PlaylistLevelType.MAIN;
    const currentQuality = this.currentQuality;

    if (!useL2AABR || mediaType === PlaylistLevelType.AUDIO) {
      // L2A decides bitrate only for video. Audio to be included in decision process in a later stage
      return currentQuality;
    }

    // scheduleController.setTimeToLoadDelay(0);

    const l2AState: l2AState = this._getL2AState(mediaType);

    if (l2AState.state === L2A_STATE_ONE_BITRATE) {
      // shouldn't even have been called
      return currentQuality;
    }

    const l2AParameter: l2AParameters = l2AParameterDict[mediaType];

    if (!l2AParameter) {
      return currentQuality;
    }

    if (isNaN(throughput)) {
      // still starting up - not enough information
      return currentQuality;
    }

    // start state
    const targetLatency = hls.targetLatency ? hls.targetLatency : 0;
    const deltaLatency = Math.abs(hls.latency - targetLatency);
    // steady state
    const diff1: number[] = []; //Used to calculate the difference between consecutive decisions (w-w_prev)
    let lastthroughput = throughput; // bits/ms = kbits/s
    const V = l2AState.lastSegmentDurationS;
    let sign = 1;
    const temp: number[] = [];
    logger.log(`>>> state: ${l2AState.state} >>>`);
    switch (l2AState.state) {
      case L2A_STATE_STARTUP:
        if (
          hls.isLive &&
          (fragCurrent == null || deltaLatency >= fragCurrent.duration)
        )
          break;
        quality = this.getQualityForBitrate(throughput); //During strat-up phase abr.controller is responsible for bitrate decisions.
        l2AState.lastQuality = quality;

        if (
          !isNaN(l2AState.lastSegmentDurationS) &&
          bufferLevel >= l2AParameter.B_target
        ) {
          l2AState.state = L2A_STATE_STEADY;
          l2AParameter.Q = vl; // Initialization of Q langrangian multiplier
          // Update of probability vector w, to be used in main adaptation logic of L2A below (steady state)
          for (let i = 0; i < bitrateCount; ++i) {
            if (i === l2AState.lastQuality) {
              l2AParameter.prev_w[i] = 1;
            } else {
              l2AParameter.prev_w[i] = 0;
            }
          }
        }

        logger.log(`>>> start up >>>`);
        break; // L2A_STATE_STARTUP
      case L2A_STATE_STEADY:
        // Manual calculation of latency and throughput during previous request
        if (lastthroughput < 1) {
          lastthroughput = 1;
        } //To avoid division with 0 (avoid infinity) in case of an absolute network outage

        //Main adaptation logic of L2A-LL
        for (let i = 0; i < bitrateCount; ++i) {
          bitrates[i] = bitrates[i] / 1000; // Originally in bps, now in Kbps
          if (currentPlaybackRate * bitrates[i] > lastthroughput) {
            // In this case buffer would deplete, leading to a stall, which increases latency and thus the particular probability of selsection of bitrate[i] should be decreased.
            sign = -1;
          }
          // The objective of L2A is to minimize the overall latency=request-response time + buffer length after download+ potential stalling (if buffer less than chunk downlad time)
          l2AParameter.w[i] =
            l2AParameter.prev_w[i] +
            sign *
              (V / (2 * alpha)) *
              ((l2AParameter.Q + vl) *
                ((currentPlaybackRate * bitrates[i]) / lastthroughput)); //Lagrangian descent
        }

        // Apply euclidean projection on w to ensure w expresses a probability distribution
        l2AParameter.w = this.euclideanProjection(l2AParameter.w);

        for (let i = 0; i < bitrateCount; ++i) {
          diff1[i] = l2AParameter.w[i] - l2AParameter.prev_w[i];
          l2AParameter.prev_w[i] = l2AParameter.w[i];
        }

        // Lagrangian multiplier Q calculation:
        l2AParameter.Q = Math.max(
          0,
          l2AParameter.Q -
            V +
            V *
              currentPlaybackRate *
              ((this._dotmultiplication(bitrates, l2AParameter.prev_w) +
                this._dotmultiplication(bitrates, diff1)) /
                lastthroughput)
        );

        // Quality is calculated as argmin of the absolute difference between available bitrates (bitrates[i]) and bitrate estimation (dotmultiplication(w,bitrates)).
        for (let i = 0; i < bitrateCount; ++i) {
          temp[i] = Math.abs(
            bitrates[i] - this._dotmultiplication(l2AParameter.w, bitrates)
          );
        }

        // Quality is calculated based on the probability distribution w (the output of L2A)
        quality = temp.indexOf(Math.min(...temp));
        // temp.forEach(element => logger.log(`>>> temp ele: ${element} >>>`));
        logger.log(`>>> calculated quality: ${quality} >>>`);

        // We employ a cautious -stepwise- ascent
        if (quality > l2AState.lastQuality) {
          if (bitrates[l2AState.lastQuality + 1] <= lastthroughput) {
            quality = l2AState.lastQuality + 1;
          }
        }

        // Provision against bitrate over-estimation, by re-calibrating the Lagrangian multiplier Q, to be taken into account for the next chunk
        if (bitrates[quality] >= lastthroughput) {
          l2AParameter.Q = react * Math.max(vl, l2AParameter.Q);
        }

        l2AState.lastQuality = quality;
        break;
      default:
        // should not arrive here, try to recover
        logger.debug('L2A ABR rule invoked in bad state.');
        quality = this.getQualityForBitrate(throughput);
        l2AState.state = L2A_STATE_STARTUP;
        this._clearL2AStateOnSeek(l2AState);
        logger.log(`>>> default >>>`);
    }
    return quality;
  }

  getL2AStateDict() {
    return this.l2AStateDict;
  }

  getL2AParameterDict() {
    return this.l2AParameterDict;
  }
}
