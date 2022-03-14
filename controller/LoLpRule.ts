import { logger } from '../utils/logger';

type State = {
  throughput: number;
  latency: number;
  rebuffer: number;
  switch: number;
};

type Neuron = {
  qualityIndex: number;
  bitrate: number;
  state: State;
};

export default class LearningAbrController {
  // const context = this.context;
  private readonly WEIGHT_SELECTION_MODES = {
    MANUAL: 'manual_weight_selection',
    RANDOM: 'random_weight_selection',
    DYNAMIC: 'dynamic_weight_selection',
  };
  private somBitrateNeurons: Neuron[] | null = null;
  private bitrateNormalizationFactor: number = 1;
  private latencyNormalizationFactor: number = 100;
  private minBitrate: number = 0;
  private minBitrateNeuron: Neuron | null = null;
  private weights: number[] | null = null;
  private sortedCenters: number[][] | null = null;
  private weightSelectionMode: string = this.WEIGHT_SELECTION_MODES.DYNAMIC;

  /**
   * Returns the maximum throughput
   * @return {number}
   * @private
   */
  _getMaxThroughput() {
    let maxThroughput = 0;

    if (this.somBitrateNeurons) {
      for (let i = 0; i < this.somBitrateNeurons.length; i++) {
        const neuron = this.somBitrateNeurons[i];
        if (neuron.state.throughput > maxThroughput) {
          maxThroughput = neuron.state.throughput;
        }
      }
    }

    return maxThroughput;
  }

  /**
   * Returns squareroot of sum of array elements
   * @param {array} w
   * @return {number}
   * @private
   */
  _getMagnitude(w) {
    const magnitude = w
      .map((x) => Math.pow(x, 2))
      .reduce((sum, now) => sum + now);

    return Math.sqrt(magnitude);
  }

  /**
   * Returns calculated distance of two neurons (sub)
   * @param {array} a
   * @param {array} b
   * @param {array} w
   * @return {number}
   * @private
   */
  _getDistance(a, b, w) {
    const sum = a
      .map((x, i) => w[i] * Math.pow(x - b[i], 2)) // square the difference*w
      .reduce((sum, now) => sum + now); // sum
    const sign = sum < 0 ? -1 : 1;

    return sign * Math.sqrt(Math.abs(sum));
  }

  /**
   * Returns calculated distance of two neurons (super)
   * @param {Neuron} a
   * @param {Neuron} b
   * @return {number}
   * @private
   */
  _getNeuronDistance(a, b) {
    const aState = [
      a.state.throughput,
      a.state.latency,
      a.state.rebuffer,
      a.state.switch,
    ];
    const bState = [
      b.state.throughput,
      b.state.latency,
      b.state.rebuffer,
      b.state.switch,
    ];

    return this._getDistance(aState, bState, [1, 1, 1, 1]);
  }

  /**
   * Updates the Neuron itself and its neighbour neurons from all the neurons
   * @param {Neuron} winnerNeuron
   * @param {array} somElements
   * @param {array} x
   * @private
   */
  _updateNeurons(winnerNeuron, somElements, x) {
    for (let i = 0; i < somElements.length; i++) {
      const somNeuron = somElements[i];
      const sigma = 0.1;
      const neuronDistance = this._getNeuronDistance(somNeuron, winnerNeuron);
      const neighbourHood = Math.exp(
        (-1 * Math.pow(neuronDistance, 2)) / (2 * Math.pow(sigma, 2))
      );
      this._updateNeuronState(somNeuron, x, neighbourHood);
    }
  }

  /**
   * Updates a neuron according to neighbourhood relationship
   * @param {Neuron} neuron
   * @param {array} x
   * @param {number} neighbourHood
   * @private
   */
  _updateNeuronState(neuron, x, neighbourHood) {
    const state = neuron.state;
    const w = [0.01, 0.01, 0.01, 0.01]; // learning rate

    state.throughput =
      state.throughput + (x[0] - state.throughput) * w[0] * neighbourHood;
    state.latency =
      state.latency + (x[1] - state.latency) * w[1] * neighbourHood;
    state.rebuffer =
      state.rebuffer + (x[2] - state.rebuffer) * w[2] * neighbourHood;
    state.switch = state.switch + (x[3] - state.switch) * w[3] * neighbourHood;
  }

  /**
   * Returns the neuron with just a little bit lower bitrate level
   * while keeping bitrate in a safe range (< throughput)
   * @param {Neuron} currentNeuron
   * @param {number} currentThroughput
   * @return {Neuron}
   * @private
   */
  _getDownShiftNeuron(currentNeuron, currentThroughput) {
    let maxSuitableBitrate = 0;
    let result = currentNeuron;

    if (this.somBitrateNeurons) {
      for (let i = 0; i < this.somBitrateNeurons.length; i++) {
        const n = this.somBitrateNeurons[i];
        if (
          n.bitrate < currentNeuron.bitrate &&
          n.bitrate > maxSuitableBitrate &&
          currentThroughput > n.bitrate
        ) {
          // possible downshiftable neuron
          maxSuitableBitrate = n.bitrate;
          result = n;
        }
      }
    }

    return result;
  }

  /**
   * Updates neurons and returns BMU's bitrate quality index
   * @param {Array} bitrateList
   * @param {number} throughput
   * @param {number} latency
   * @param {number} bufferSize
   * @param {number} playbackRate
   * @param {number} currentQualityIndex
   * @param {object} dynamicWeightsSelector
   * @return {null|*}
   */
  getNextQuality(
    bitrateList,
    throughput,
    latency,
    bufferSize,
    playbackRate,
    currentQualityIndex,
    dynamicWeightsSelector
  ) {
    // For Dynamic Weights Selector
    const currentLatency = latency;
    const currentBuffer = bufferSize;
    const currentThroughput = throughput;

    const somElements = this._getSomBitrateNeurons(bitrateList);
    // normalize throughput
    let throughputNormalized = throughput / this.bitrateNormalizationFactor;
    // saturate values higher than 1
    if (throughputNormalized > 1) {
      throughputNormalized = this._getMaxThroughput();
    }
    // normalize latency
    latency = latency / this.latencyNormalizationFactor;

    const targetLatency = 0;
    const targetRebufferLevel = 0;
    const targetSwitch = 0;
    // 10K + video encoding is the recommended throughput
    const throughputDelta = 10000;

    logger.debug(
      `getNextQuality called throughput:${throughputNormalized} latency:${latency} bufferSize:${bufferSize} currentQualityIndex:${currentQualityIndex} playbackRate:${playbackRate}`
    );

    const currentNeuron = somElements[currentQualityIndex];
    const downloadTime =
      (currentNeuron.bitrate * dynamicWeightsSelector.getSegmentDuration()) /
      currentThroughput;
    const rebuffer = Math.max(0, downloadTime - currentBuffer);

    // check buffer for possible stall
    if (currentBuffer - downloadTime < dynamicWeightsSelector.getMinBuffer()) {
      logger.debug(
        `Buffer is low for bitrate= ${currentNeuron.bitrate} downloadTime=${downloadTime} currentBuffer=${currentBuffer} rebuffer=${rebuffer}`
      );
      return this._getDownShiftNeuron(currentNeuron, currentThroughput)
        .qualityIndex;
    }

    switch (this.weightSelectionMode) {
      case this.WEIGHT_SELECTION_MODES.MANUAL:
        this._manualWeightSelection();
        break;
      case this.WEIGHT_SELECTION_MODES.RANDOM:
        this._randomWeightSelection(somElements);
        break;
      case this.WEIGHT_SELECTION_MODES.DYNAMIC:
        this._dynamicWeightSelection(
          dynamicWeightsSelector,
          somElements,
          currentLatency,
          currentBuffer,
          rebuffer,
          currentThroughput,
          playbackRate
        );
        break;
      default:
        this._dynamicWeightSelection(
          dynamicWeightsSelector,
          somElements,
          currentLatency,
          currentBuffer,
          rebuffer,
          currentThroughput,
          playbackRate
        );
    }

    let minDistance: number | null = null;
    let minIndex: number | null = null;
    let winnerNeuron: Neuron | null = null;
    let winnerWeights: number[] | null = null;

    for (let i = 0; i < somElements.length; i++) {
      const somNeuron = somElements[i];
      const somNeuronState = somNeuron.state;
      const somData = [
        somNeuronState.throughput,
        somNeuronState.latency,
        somNeuronState.rebuffer,
        somNeuronState.switch,
      ];

      const distanceWeights = this.weights!.slice();
      const nextBuffer = dynamicWeightsSelector.getNextBufferWithBitrate(
        somNeuron.bitrate,
        currentBuffer,
        currentThroughput
      );
      const isBufferLow = nextBuffer < dynamicWeightsSelector.getMinBuffer();
      if (isBufferLow) {
        logger.debug(
          `Buffer is low for bitrate=${somNeuron.bitrate} downloadTime=${downloadTime} currentBuffer=${currentBuffer} nextBuffer=${nextBuffer}`
        );
      }
      // special condition downshift immediately
      if (somNeuron.bitrate > throughput - throughputDelta || isBufferLow) {
        if (somNeuron.bitrate !== this.minBitrate) {
          // encourage to pick smaller bitrates throughputWeight=100
          distanceWeights[0] = 100;
        }
      }

      // calculate the distance with the target
      const distance = this._getDistance(
        somData,
        [
          throughputNormalized,
          targetLatency,
          targetRebufferLevel,
          targetSwitch,
        ],
        distanceWeights
      );
      if (minDistance === null || distance < minDistance) {
        minDistance = distance;
        minIndex = somNeuron.qualityIndex;
        winnerNeuron = somNeuron;
        winnerWeights = distanceWeights;
      }
    }

    // update current neuron and the neighbourhood with the calculated QoE
    // will punish current if it is not picked
    const bitrateSwitch =
      Math.abs(currentNeuron.bitrate - winnerNeuron!.bitrate) /
      this.bitrateNormalizationFactor;
    this._updateNeurons(currentNeuron, somElements, [
      throughputNormalized,
      latency,
      rebuffer,
      bitrateSwitch,
    ]);

    // update bmu and  neighbours with targetQoE=1, targetLatency=0
    this._updateNeurons(winnerNeuron, somElements, [
      throughputNormalized,
      targetLatency,
      targetRebufferLevel,
      bitrateSwitch,
    ]);

    return minIndex;
  }

  /**
   * Option 1: Manual weights
   * Set manually pre-selected weights
   */
  _manualWeightSelection() {
    const throughputWeight = 0.4;
    const latencyWeight = 0.4;
    const bufferWeight = 0.4;
    const switchWeight = 0.4;

    this.weights = [
      throughputWeight,
      latencyWeight,
      bufferWeight,
      switchWeight,
    ]; // throughput, latency, buffer, switch
  }

  /**
   * Option 2: Random (Xavier) weights
   * Set random (Xavier) weights
   * @param {array} somElements
   */
  _randomWeightSelection(somElements) {
    this.weights = this._getXavierWeights(somElements.length, 4);
  }

  /**
   * Option 3: Dynamic Weight Selector weights
   * Set dynamic Weight Selector weights
   * @param {object} dynamicWeightsSelector
   * @param {array} somElements
   * @param {number} currentLatency
   * @param {number} currentBuffer
   * @param {number} rebuffer
   * @param {number} currentThroughput
   * @param {number} playbackRate
   */
  _dynamicWeightSelection(
    dynamicWeightsSelector,
    somElements,
    currentLatency,
    currentBuffer,
    rebuffer,
    currentThroughput,
    playbackRate
  ) {
    if (!this.weights) {
      this.weights = this.sortedCenters![this.sortedCenters!.length - 1];
    }
    // Dynamic Weights Selector (step 2/2: find weights)
    const weightVector = dynamicWeightsSelector.findWeightVector(
      somElements,
      currentLatency,
      currentBuffer,
      rebuffer,
      currentThroughput,
      playbackRate
    );
    if (weightVector !== null && weightVector !== -1) {
      // null: something went wrong, -1: constraints not met
      this.weights = weightVector;
    }
  }

  /**
   * Generates and returns random Xavier weights with set upperbound
   * @param {number} neuronCount
   * @param {number} weightCount
   * @return {array}
   */
  _getXavierWeights(neuronCount, weightCount) {
    const W: number[] = [];
    const upperBound = Math.sqrt(2 / neuronCount);

    for (let i = 0; i < weightCount; i++) {
      W.push(Math.random() * upperBound);
    }

    this.weights = W;

    return this.weights;
  }

  /**
   * Generates and returns neurons of SOM corresponding to each bitrate level
   * @param {Array} bitrateList
   * @return {array}
   * @private
   */
  _getSomBitrateNeurons(bitrateList) {
    if (!this.somBitrateNeurons) {
      this.somBitrateNeurons = [];
      const _bitrateList = bitrateList;
      const bitrateVector: number[] = [];
      this.minBitrate = _bitrateList[0].bitrate;

      _bitrateList.forEach((element) => {
        bitrateVector.push(element.bitrate);
        if (element.bitrate < this.minBitrate) {
          this.minBitrate = element.bitrate;
        }
      });
      this.bitrateNormalizationFactor = this._getMagnitude(bitrateVector);

      for (let i = 0; i < _bitrateList.length; i++) {
        const _state: State = {
          throughput: _bitrateList[i].bitrate / this.bitrateNormalizationFactor,
          latency: 0,
          rebuffer: 0,
          switch: 0,
        };
        const neuron: Neuron = {
          qualityIndex: i,
          bitrate: _bitrateList[i].bitrate,
          state: _state,
        };
        this.somBitrateNeurons.push(neuron);
        if (neuron.bitrate === this.minBitrate) {
          this.minBitrateNeuron = neuron;
        }
      }

      this.sortedCenters = this._getInitialKmeansPlusPlusCenters(
        this.somBitrateNeurons
      );
    }

    return this.somBitrateNeurons;
  }

  /**
   * Returns an array of neuron data generated randomly
   * @param {number} size
   * @return {array}
   * @private
   */
  _getRandomData(size) {
    const dataArray: number[][] = [];

    for (let i = 0; i < size; i++) {
      const data = [
        Math.random() * this._getMaxThroughput(), //throughput
        Math.random(), //latency
        Math.random(), //buffersize
        Math.random(), //switch
      ];
      dataArray.push(data);
    }

    return dataArray;
  }

  /**
   *
   * @param {array} somElements
   * @return {array}
   * @private
   */
  _getInitialKmeansPlusPlusCenters(somElements) {
    const centers: number[][] = [];
    const randomDataSet = this._getRandomData(Math.pow(somElements.length, 2));
    centers.push(randomDataSet[0]);
    const distanceWeights = [1, 1, 1, 1];

    for (let k = 1; k < somElements.length; k++) {
      let nextPoint: number[] | null = null;
      let maxDistance: number | null = null;
      for (let i = 0; i < randomDataSet.length; i++) {
        const currentPoint = randomDataSet[i];
        let minDistance: number | null = null;
        for (let j = 0; j < centers.length; j++) {
          const distance = this._getDistance(
            currentPoint,
            centers[j],
            distanceWeights
          );
          if (minDistance === null || distance < minDistance) {
            minDistance = distance;
          }
        }
        if (maxDistance === null || minDistance! > maxDistance) {
          nextPoint = currentPoint;
          maxDistance = minDistance;
        }
      }
      centers.push(nextPoint!);
    }

    // find the least similar center
    let maxDistance: number | null = null;
    let leastSimilarIndex: number | null = null;
    for (let i = 0; i < centers.length; i++) {
      let distance = 0;
      for (let j = 0; j < centers.length; j++) {
        if (i === j) continue;
        distance += this._getDistance(centers[i], centers[j], distanceWeights);
      }
      if (maxDistance === null || distance > maxDistance) {
        maxDistance = distance;
        leastSimilarIndex = i;
      }
    }

    // move centers to sortedCenters
    const sortedCenters: number[][] = [];
    sortedCenters.push(centers[leastSimilarIndex!]);
    centers.splice(leastSimilarIndex!, 1);
    while (centers.length > 0) {
      let minDistance: number | null = null;
      let minIndex: number | null = null;
      for (let i = 0; i < centers.length; i++) {
        const distance = this._getDistance(
          sortedCenters[0],
          centers[i],
          distanceWeights
        );
        if (minDistance === null || distance < minDistance) {
          minDistance = distance;
          minIndex = i;
        }
      }
      sortedCenters.push(centers[minIndex!]);
      centers.splice(minIndex!, 1);
    }

    return sortedCenters;
  }
}
