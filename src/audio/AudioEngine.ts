type MergeSoundKey = `${string}:${number}`

export class AudioEngine {
  private context?: AudioContext
  private master?: GainNode
  private readonly recordingDestinations = new Set<MediaStreamAudioDestinationNode>()
  private enabled = true
  private volume = 0.32
  private activeSources = 0
  private readonly activeNodes: Array<{ source: AudioBufferSourceNode; gain: GainNode }> = []
  private readonly mergeBuffers = new Map<MergeSoundKey, AudioBuffer>()
  private readonly mergeVolumes = new Map<MergeSoundKey, number>()
  private readonly mergeRates = new Map<MergeSoundKey, number>()

  get isEnabled() { return this.enabled }
  get currentVolume() { return this.volume }

  setEnabled(enabled: boolean) { this.enabled = enabled }

  setVolume(volume: number) {
    this.volume = Math.max(0, Math.min(1, volume))
    if (this.master) this.master.gain.value = this.volume
  }

  async unlock() {
    if (!this.context) {
      this.context = new AudioContext()
      this.master = this.context.createGain()
      this.master.gain.value = this.volume
      this.master.connect(this.context.destination)
    }
    if (this.context.state === 'suspended') await this.context.resume()
  }

  /** Capture the same master bus as a dedicated track for a video recording. */
  async getRecordingTrack() {
    await this.unlock()
    if (!this.context || !this.master) throw new Error('Аудиодвижок недоступен.')
    const destination = this.context.createMediaStreamDestination()
    this.master.connect(destination)
    this.recordingDestinations.add(destination)
    return destination.stream.getAudioTracks()[0]!
  }

  releaseRecordingTrack(track: MediaStreamTrack) {
    for (const destination of this.recordingDestinations) {
      if (!destination.stream.getTracks().includes(track)) continue
      this.master?.disconnect(destination)
      track.stop()
      this.recordingDestinations.delete(destination)
      break
    }
  }

  /** Store a dedicated sample for a collection's level -> level+1 transition. */
  async loadMergeSound(collectionId: string, fromLevel: number, fileOrBlob: Blob, volume = 1, rate = 1) {
    if (!collectionId || !Number.isInteger(fromLevel) || fromLevel < 1) throw new Error('Некорректный переход уровня.')
    await this.unlock()
    const key = `${collectionId}:${fromLevel}` as MergeSoundKey
    const bytes = await fileOrBlob.arrayBuffer()
    // Decode before replacing the current sample: a corrupt new file should
    // not make a previously working transition silent.
    const decoded = await this.context!.decodeAudioData(bytes)
    this.mergeBuffers.set(key, decoded)
    this.mergeVolumes.set(key, Math.max(0, Math.min(1, volume)))
    this.mergeRates.set(key, Math.max(0.1, Math.min(2, rate)))
  }

  removeMergeSound(collectionId: string, fromLevel: number) {
    const key = `${collectionId}:${fromLevel}` as MergeSoundKey
    this.mergeBuffers.delete(key)
    this.mergeVolumes.delete(key)
    this.mergeRates.delete(key)
  }

  setMergeSoundVolume(collectionId: string, fromLevel: number, volume: number) {
    const key = `${collectionId}:${fromLevel}` as MergeSoundKey
    if (this.mergeBuffers.has(key)) this.mergeVolumes.set(key, Math.max(0, Math.min(1, volume)))
  }

  setMergeSoundRate(collectionId: string, fromLevel: number, rate: number) {
    const key = `${collectionId}:${fromLevel}` as MergeSoundKey
    if (this.mergeBuffers.has(key)) this.mergeRates.set(key, Math.max(0.1, Math.min(2, rate)))
  }

  async testMergeSound(collectionId: string, fromLevel: number, impact = 1) {
    await this.playMergeSound(collectionId, fromLevel, impact)
  }

  /** Play exactly one transition sample when a merge has succeeded. */
  async playMergeSound(collectionId: string, fromLevel: number, impact = 1) {
    if (!this.enabled) return
    const key = `${collectionId}:${fromLevel}` as MergeSoundKey
    const buffer = this.mergeBuffers.get(key)
    if (!buffer) return
    try { await this.unlock() } catch { return }
    if (this.context?.state !== 'running' || !this.master) return
    this.startBuffer(buffer, impact, this.mergeVolumes.get(key) ?? 1, this.mergeRates.get(key) ?? 1)
  }

  dispose() {
    this.mergeBuffers.clear()
    this.mergeVolumes.clear()
    this.mergeRates.clear()
    for (const destination of this.recordingDestinations) destination.stream.getTracks().forEach((track) => track.stop())
    this.recordingDestinations.clear()
    if (this.context) void this.context.close()
    this.context = undefined
    this.master = undefined
    this.activeSources = 0
    this.activeNodes.length = 0
  }

  private startBuffer(buffer: AudioBuffer, impact: number, gainScale: number, rate: number) {
    if (!this.context || !this.master) return
    const context = this.context
    while (this.activeNodes.length >= 5) this.activeNodes.shift()?.source.stop()
    this.activeSources += 1
    const gain = context.createGain()
    gain.gain.value = Math.min(0.9, (0.08 + Math.min(impact, 12) / 18) * gainScale)
    gain.connect(this.master)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = Math.max(0.1, Math.min(2, rate)) * (0.82 + Math.min(impact, 8) * 0.025)
    source.connect(gain)
    const node = { source, gain }
    this.activeNodes.push(node)
    source.onended = () => {
      this.activeSources = Math.max(0, this.activeSources - 1)
      const index = this.activeNodes.indexOf(node)
      if (index >= 0) this.activeNodes.splice(index, 1)
      gain.disconnect()
    }
    source.start()
  }
}
