import LoLpQoeEvaluator from './LoLpQoeEvaluator';

export default class LoLpWeightSelector {
  private targetLatency: number | null = null;
  private bufferMin: number | null = null;
  private segmentDuration: number | null = null;
  private qoeEvaluator: LoLpQoeEvaluator | null = null;
  private valueList: number[] = [0.2, 0.4, 0.6, 0.8, 1];
  private weightTypeCount: number = 4;
  private weightOptions: number[][] | null = null;
  private previousLatency: number = 0;

  constructor(config) {
    this.targetLatency = config.targetLatency;
    this.bufferMin = config.bufferMin;
    this.segmentDuration = config.segmentDuration;
    this.qoeEvaluator = config.qoeEvaluator;
    this.weightOptions = this._getPermutations();
  }

  /**
   * Next, at each segment boundary, ABR to input current neurons and target state (only used in Method II) to find the desired weight vector
   * @param {array} neurons
   * @param {number} currentLatency
   * @param {number} currentBuffer
   * @param {number} currentRebuffer
   * @param {number} currentThroughput
   * @param {number} playbackRate
   * @return {null}
   */
  findWeightVector(
    neurons,
    currentLatency,
    currentBuffer,
    currentRebuffer,
    currentThroughput,
    playbackRate
  ) {
    let maxQoE: number | null = null;
    let winnerWeights: number[] | number | null = null;
    let winnerBitrate = null;
    const deltaLatency = Math.abs(currentLatency - this.previousLatency);

    // For each neuron, m
    neurons.forEach((neuron) => {
      // For each possible weight vector, z
      // E.g. For [ throughput, latency, buffer, playbackRate, QoE ]
      //      Possible weightVector = [ 0.2, 0.4, 0.2, 0, 0.2 ]
      const downloadTime =
        (neuron.bitrate * this.segmentDuration!) / currentThroughput;
      const nextBuffer = this.getNextBuffer(currentBuffer, downloadTime);
      const rebuffer = Math.max(0.00001, downloadTime - nextBuffer);

      if (this._checkConstraints(currentLatency, nextBuffer, deltaLatency)) {
        this.weightOptions!.forEach((weightVector) => {
          // Apply weightVector to neuron, compute utility and determine winnerWeights
          // Method I: Utility based on QoE given current state

          const weightsObj = {
            throughput: weightVector[0],
            latency: weightVector[1],
            buffer: weightVector[2],
            switch: weightVector[3],
          };

          let wt;
          if (weightsObj.buffer === 0) {
            wt = 10;
          } else {
            wt = 1 / weightsObj.buffer;
          }
          const weightedRebuffer = wt * rebuffer;

          if (weightsObj.latency === 0) {
            wt = 10;
          } else {
            wt = 1 / weightsObj.latency; // inverse the weight because wt and latency should have positive relationship, i.e., higher latency = higher wt
          }
          const weightedLatency = wt * neuron.state.latency;

          const totalQoE = this.qoeEvaluator!.calculateSingleUseQoe(
            neuron.bitrate,
            weightedRebuffer,
            weightedLatency,
            playbackRate
          );
          if (maxQoE === null || totalQoE > maxQoE) {
            maxQoE = totalQoE;
            winnerWeights = weightVector;
            winnerBitrate = neuron.bitrate;
          }
        });
      }
    });

    // winnerWeights was found, check if constraints are satisfied
    if (winnerWeights === null && winnerBitrate === null) {
      winnerWeights = -1;
    }

    this.previousLatency = currentLatency;
    return winnerWeights;
  }

  /**
   * Checks whether the neuron option is acceptable
   * @param {number} nextLatency
   * @param {number} nextBuffer
   * @param {number} deltaLatency
   * @return {boolean}
   */
  _checkConstraints(nextLatency, nextBuffer, deltaLatency) {
    // A1
    // disabled till we find a better way of estimating latency
    // fails for all with current value
    if (nextLatency > this.targetLatency + deltaLatency) {
      return false;
    }

    return nextBuffer >= this.bufferMin!;
  }

  /**
   * Generates Permutations from a given array
   * @param {number[][]} list
   * @param {number} length
   * @return {*}
   */
  _getPermutations() {
    const list = this.valueList;
    const length = this.weightTypeCount;
    // Copy initial values as arrays
    const perm = list.map(function (val) {
      return [val];
    });
    // Our permutation generator
    const generate = function (perm, length, currLen) {
      // Reached desired length
      if (currLen === length) {
        return perm;
      }
      // For each existing permutation
      const len = perm.length;
      for (let i = 0; i < len; i++) {
        const currPerm = perm.shift();
        // Create new permutation
        for (let k = 0; k < list.length; k++) {
          perm.push(currPerm.concat(list[k]));
        }
      }
      // Recurse
      return generate(perm, length, currLen + 1);
    };
    // Start with size 1 because of initial values
    return generate(perm, length, 1);
  }

  /**
   *
   * @return {number}
   */
  private getMinBuffer() {
    return this.bufferMin;
  }

  /**
   *
   * @return {number}
   */
  private getSegmentDuration() {
    return this.segmentDuration;
  }

  /**
   * Returns estimated next buffer length
   * @param {number} bitrateToDownload
   * @param {number} currentBuffer
   * @param {number} currentThroughput
   * @return {number}
   */
  getNextBufferWithBitrate(
    bitrateToDownload,
    currentBuffer,
    currentThroughput
  ) {
    const downloadTime =
      (bitrateToDownload * this.segmentDuration!) / currentThroughput;
    return this.getNextBuffer(currentBuffer, downloadTime);
  }

  /**
   * Returns estimated next buffer length
   * @param {number} currentBuffer
   * @param {number} downloadTime
   * @return {number}
   */
  getNextBuffer(currentBuffer, downloadTime) {
    const segmentDuration = this.getSegmentDuration();
    let nextBuffer;
    if (downloadTime > this.segmentDuration!) {
      nextBuffer = currentBuffer - segmentDuration!;
    } else {
      nextBuffer = currentBuffer + segmentDuration - downloadTime;
    }
    return nextBuffer;
  }
}
