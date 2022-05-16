# Integration of LLHLS-ABRs (LoL+, L2A, Stallion, and Llama)

# Integration of LoL+ in hls.js

Low-on-Latency-plus (LoL+) [1] has been implemented in [NUStreaming](https://github.com/NUStreaming)/**[LoL-plus](https://github.com/NUStreaming/LoL-plus)** based on [dash.js referance player v.3.2.0](https://github.com/Dash-Industry-Forum/dash.js), which has been proved to have an outstanding performance.

This project is to integrate this live streaming algorithm with [video-dev](https://github.com/video-dev)/**[hls.js](https://github.com/video-dev/hls.js)**, a JavaScript HLS client using Media Source Extension. All the involved design and algorithm are illustrated in [1].

## Main Modules

### QoE Evaluation Module

There is an independent QoE (Quality of Experience) evalutation module in LoL+. It takes in five metrics into calculation, including one reward and four penanlties.

Reward:

- bitrate selected (𝑅𝑠𝑖)

Penalty:

- bitrate switches (𝐻𝑠𝑖 = |𝑅𝑠𝑖+1 − 𝑅𝑠𝑖|)
- rebuffering time (𝐸𝑠𝑖)
- latency (𝐿𝑠𝑖)
- playback speed variance (|1 - 𝑃𝑠𝑖|)

> The QoE equation is displayed as follows.

<img src="http://latex.codecogs.com/svg.latex?\inline&space;QoE_S^K=\sum_{i=1}^{K}(\alpha&space;Rsi-\beta&space;Esi-\gamma&space;Lsi-\sigma&space;|1-Psi|)-\sum_{i=1}^{K-1}\mu&space;Hsi" title="http://latex.codecogs.com/svg.latex?\inline QoE_S^K=\sum_{i=1}^{K}(\alpha Rsi-\beta Esi-\gamma Lsi-\sigma |1-Psi|)-\sum_{i=1}^{K-1}\mu Hsi" />

Where:

- <img src="http://latex.codecogs.com/svg.latex?\inline&space;\alpha=\text{segment&space;duration}" title="http://latex.codecogs.com/svg.latex?\inline \alpha=\text{segment duration}" />
- <img src="http://latex.codecogs.com/svg.latex?\inline&space;\beta=\text{maximum&space;bitrate}" title="http://latex.codecogs.com/svg.latex?\inline \beta=\text{maximum bitrate}" />
- <img src="http://latex.codecogs.com/svg.latex?\gamma=0.05&space;\times&space;\text{min&space;birate&space;if&space;}L&space;\le&space;1.6" title="http://latex.codecogs.com/svg.latex?\gamma=0.05 \times \text{min birate if }L \le 1.6" />
- <img src="http://latex.codecogs.com/svg.latex?\gamma&space;=&space;0.1&space;\times&space;\text{max&space;birate&space;if&space;}L&space;>&space;&space;1.6"/>
- <img src="http://latex.codecogs.com/svg.latex?\sigma=\text{minimum&space;bitrate}" title="http://latex.codecogs.com/svg.latex?\sigma=\text{minimum bitrate}" />
- <img src="http://latex.codecogs.com/svg.latex?\mu=1" title="http://latex.codecogs.com/svg.latex?\mu=1" />

> The module is implemented in two separate files, _[controller/LoLpQoeInfo.ts](https://anonymous.4open.science/r/LLHLS-ABRs-80FE/controller/LoLpQoeInfo.ts)_ and _[controller/LoLpQoeEvaluator.ts](https://github.com/llhls-ABRdemo/LLHLS-ABRs/blob/main/controller/LoLpQoeEvaluator.ts)_.

**LoLpQoeInfo.ts** implements a class called **QoeInfo**, which is used to record the metrics and parameters for QoE calculation.

**LoLpQoeEvaluator.ts** implements a class called **LoLpQoeEvaluator** to set up and calulate QoE value for each segment.

### Weight Selection Module

Since LoL+ uses Self-organized Map (SOM) for bitrate selection, weight selection is an essential part. It is invoked by bitrate selection module that inputs current neurons and retrieves the desired weight vector. The weight vector is then used in distance calculation when searching for the Best Matching Unit (BMU) in Bitrate Selection Module.

Weights:

- throughput weight
- latency weight
- rebuffering time weight
- bitrate switch number weight

To reduce complexity, weights are normalized into a range between 0 and 1, choosing from a value list [0.2, 0.4, 0.6, 0.8, 1]. For each neuron, the algorithm goes through all the possible weight permutations. It is going to select the weight combination that produces best QoE score among all the neurons.

> The module is implemented in [controller/LoLpWeightSelector.ts](https://anonymous.4open.science/r/LLHLS-ABRs-80FE/controller/LoLpWeightSelector.ts).

### Bitrate Selection Module

Bitrate selection module, the heart of LoL+, takes in the metrics provided by other modules and outputs an optimized bitrate selection result. It is also triggered to run at the end of each segment download.

The job of this module is to select the best bitrate that leads to a maximum QoE as well as adjust playback rate to make the latency close to the target.

LoL+ treats the bitrate selection problem as an unsupervised classification. The algorithm is implemented with Self-organized Map(SOM). For each bitrate level in the manifest, there is a corresponding SOM neuron. Hence, the number of neuron equals to that of bitrate levels.

The neuron records its quality index, bitrate and some state information related. To note that, both throughput and latency are normalized before saving their values into the Neurons.

Neuron:

- quality index
- bitrate
- state
  - throughput
    - _bitrate/Magnitude(bitrate vector)_ (initial value)
  - latency
    - _0_ (initial value)
  - rebuffering time
    - _0_ (initial value)
  - bitrate switch number
    - _0_ (initial value)

At the download boundary of each segment, the algorithm is going to find the Best Matching Unit (BMU) in the SOM, namely the best matching neuron. The next selected quality is from that neuron.

The whole BMU searching procedure is listed as follows:

1. Collect metrics, normalize throughput and latency.
2. Find the weight vector leading to the highest QoE value among all the neurons with Weight Selection Module.
   - regard the weights as distance weights in SOM
3. Traverse all the neurons, calculate the distance between each neuron and the target neuron, find out the neuron with the smallest distance (BMU).
   - target neuron
     - throughput = normalized throughput
     - latency = target latency
     - rebuffer time = 0
     - switch number = 0
   - weighted by distance weights calculated in step 3
4. Update the states of current neuron and its neighbours
5. Update the states of BMU and its neighbours.
6. Return the quality level of BMU.

> The module is implemented in [controller/LoLpRule.ts](https://anonymous.4open.science/r/LLHLS-ABRs-80FE/controller/LoLpRule.ts).

### Throughput Measurement Module

The throughput measurement of hls.js is not precise enough because it takes in the request duration as part of download time unintentionally. To solve this problem, LoL+ designs a brand-new throughput measurement method.

According to ISO/IEC 14496-12 fragmented MP4 format, the fragmented MP4 structure follows such a format.

<img src="http://latex.codecogs.com/svg.latex?\text{moov&space;|&space;[moof&space;&space;mdat]&plus;&space;|&space;mfra}" title="http://latex.codecogs.com/svg.latex?\text{moov | [moof mdat]+ | mfra}" />

Each moof/mdat pair defines a MP4 fragment. In live streaming, it is namely one part of a segment. Therefore, the idea is that we records the timestamps of *moof*s and *mdat*s in the network packages during the downloading of one segment. The time difference of first _moof_ and last _mdat_ is the download time of that segment. Additionally, to avoid transient outliers, the first and last part of a segment are actually not taken into the consideration.

So the throughput calculation can be expressed in the following formula.

<img src="http://latex.codecogs.com/svg.latex?\text{throughput}&space;=&space;\dfrac{n&space;\times&space;\text{part&space;length}}{\text{mdat&space;time}[-2]-\text{moof&space;time}[1]}" title="http://latex.codecogs.com/svg.latex?\text{throughput} = \dfrac{n \times \text{part length}}{\text{mdat time}[-2]-\text{moof time}[1]}" />

where:

- <img src="http://latex.codecogs.com/svg.latex?\inline&space;n&space;=&space;\text{number&space;of&space;parts&space;in&space;one&space;segment}" title="http://latex.codecogs.com/svg.latex?\inline n = \text{number of parts in one segment}" />
- <img src="http://latex.codecogs.com/svg.latex?\inline&space;\text{mdat&space;time}&space;=&space;\text{timestamps&space;of&space;mdat}" title="http://latex.codecogs.com/svg.latex?\inline \text{mdat time} = \text{timestamps of mdat}" />
- <img src="http://latex.codecogs.com/svg.latex?\inline&space;\text{moof&space;time}&space;=&space;\text{timestamps&space;of&space;moof&space;}" title="http://latex.codecogs.com/svg.latex?\inline \text{moof time} = \text{timestamps of moof }" />

> The module is implemented in [utils/fetch-loader.ts](https://anonymous.4open.science/r/LLHLS-ABRs-80FE/utils/fetch-loader.ts) and [controller/abr-controller.ts](https://anonymous.4open.science/r/LLHLS-ABRs-80FE/controller/abr-controller.ts).

**fetch-loader.ts** implements _moof_ and _mdat_ detection, and corresponding timestamp recording.

**abr-controller.ts** implements the throughput calculation.

### Playback Speed Control Module

To ensure latency close to target, the playback speed (rate) control module is designed to adjust playback rendering speed while running a risk of rebuffering.

First, the algorithm checks whether playback speed control is necessary. If all the following listed conditios are met, it will invoke the speed calculation function.

Conditions:

- <img src="http://latex.codecogs.com/svg.latex?\inline&space;\text{current&space;latency}&space;\le&space;\text{&space;liveCatchupLatencyThreshold}" title="http://latex.codecogs.com/svg.latex?\inline \text{current latency} \le \text{ liveCatchupLatencyThreshold}" />

    - <img src="http://latex.codecogs.com/svg.latex?\inline&space;\text{Threshold}&space;=&space;60" title="http://latex.codecogs.com/svg.latex?\inline \text{Threshold} = 60" />
- <img src="http://latex.codecogs.com/svg.latex?\inline&space;|\text{current&space;latency}-\text{target&space;latency}|&space;>&space;\text{minDrift&space;}&space;OR&space;\text{&space;current&space;buffer}&space;<&space;\text{bufferMin}" title="http://latex.codecogs.com/svg.latex?\inline |\text{current latency}-\text{target latency}| > \text{minDrift } OR \text{ current buffer} < \text{bufferMin}" />

  - <img src="http://latex.codecogs.com/svg.latex?\inline&space;\text{minDrift}&space;=&space;0.05" title="http://latex.codecogs.com/svg.latex?\inline \text{minDrift} = 0.05" />
  - <img src="http://latex.codecogs.com/svg.latex?\inline&space;\text{bufferMin}&space;=&space;0.5" title="http://latex.codecogs.com/svg.latex?\inline \text{bufferMin} = 0.5" />

Then if needed, the new playback rate is calculated based on collected metrics of buffer and latency. It is a hybrid method. When the buffer level is in danger, the new rate is calculated based on buffer. Suppose that buffer is safe, the algorithm goes on checking whether latency is in a tolerant range close to target latency. If not, a new rate will be calculated.

For all the cases not requiring rate calculation, the playback speed is set to 1, the original rate.

The calculation takes advantages of natural exponential to fix the range of generated new rate with a reasonable threshold. You can find the detailed calculation explanation in [dash.js's wiki page](https://github.com/Dash-Industry-Forum/dash.js/wiki/Low-Latency-streaming#calculating-the-new-playback-rate).

> The module is implemented in [controller/abr-controller.ts](https://anonymous.4open.science/r/LLHLS-ABRs-80FE/controller/abr-controller.ts) as several functions.

## Reference

[1] Bentaleb, A., Akcay, M. N., Lim, M., Begen, A. C., & Zimmermann, R. (2020, Sept). Catching the Moment with LoL^+ in Twitch-Like Low-Latency Live Streaming Platforms (under review).

## Acknowledge

By Dr. Abdelhak Bentaleb and Zhengdao Zhan
