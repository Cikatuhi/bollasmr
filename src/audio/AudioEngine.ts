export type CollisionSoundKind = 'circle' | 'polygon' | 'image' | 'box' | 'wall' | (string & {})

type Tone = { frequency: number; duration: number; type: OscillatorType }
type MergeSoundKey = `${string}:${number}`

const TONES: Partial<Record<CollisionSoundKind, Tone>> = {
  circle: { frequency: 330, duration: 0.08, type: 'sine' },
  polygon: { frequency: 220, duration: 0.11, type: 'triangle' },
  image: { frequency: 280, duration: 0.1, type: 'sine' },
  box: { frequency: 150, duration: 0.13, type: 'square' },
  wall: { frequency: 120, duration: 0.08, type: 'sawtooth' },
}

export class AudioEngine {
  private context?: AudioContext
  private master?: GainNode
  private enabled = true
  private volume = 0.32
  private activeSources = 0
  private lastSoundAt = 0
  private readonly userBuffers = new Map<CollisionSoundKind, AudioBuffer>()
  private readonly mergeBuffers = new Map<MergeSoundKey, AudioBuffer>()
  private readonly mergeVolumes = new Map<MergeSoundKey, number>()

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

  async loadUserAudio(file: File, kind: CollisionSoundKind = 'circle') {
    await this.unlock()
    this.userBuffers.set(kind, await this.context!.decodeAudioData(await file.arrayBuffer()))
  }

  /** Store a dedicated sample for a collection's level -> level+1 transition. */
  async loadMergeSound(collectionId: string, fromLevel: number, fileOrBlob: Blob, volume = 1) {
    if (!collectionId || !Number.isInteger(fromLevel) || fromLevel < 1) throw new Error('Некорректный переход уровня.')
    await this.unlock()
    const key = `${collectionId}:${fromLevel}` as MergeSoundKey
    const bytes = await fileOrBlob.arrayBuffer()
    this.mergeBuffers.set(key, await this.context!.decodeAudioData(bytes))
    this.mergeVolumes.set(key, Math.max(0, Math.min(1, volume)))
  }

  removeMergeSound(collectionId: string, fromLevel: number) {
    const key = `${collectionId}:${fromLevel}` as MergeSoundKey
    this.mergeBuffers.delete(key)
    this.mergeVolumes.delete(key)
  }

  setMergeSoundVolume(collectionId: string, fromLevel: number, volume: number) {
    const key = `${collectionId}:${fromLevel}` as MergeSoundKey
    if (this.mergeBuffers.has(key)) this.mergeVolumes.set(key, Math.max(0, Math.min(1, volume)))
  }

  async testMergeSound(collectionId: string, fromLevel: number, impact = 1) {
    await this.playMergeSound(collectionId, fromLevel, impact)
  }

  /** Play exactly one transition sample when a merge has succeeded. */
  async playMergeSound(collectionId: string, fromLevel: number, impact = 1) {
    if (!this.enabled || this.activeSources >= 5) return
    const key = `${collectionId}:${fromLevel}` as MergeSoundKey
    const buffer = this.mergeBuffers.get(key)
    if (!buffer) return
    try { await this.unlock() } catch { return }
    if (this.context?.state !== 'running' || !this.master) return
    this.startBuffer(buffer, impact, this.mergeVolumes.get(key) ?? 1, false)
  }

  async test(kind: CollisionSoundKind = 'circle') {
    await this.play(kind, 1)
  }

  async play(kind: CollisionSoundKind, impact = 1) {
    if (!this.enabled || this.activeSources >= 5) return
    const now = performance.now()
    if (now - this.lastSoundAt < 28) return
    this.lastSoundAt = now
    try { await this.unlock() } catch { return }
    const context = this.context!
    if (context.state !== 'running') return
    const master = this.master!
    this.activeSources += 1
    const gain = context.createGain()
    gain.gain.value = Math.min(0.9, 0.08 + Math.min(impact, 12) / 18)
    gain.connect(master)
    const userBuffer = this.userBuffers.get(kind)
    if (userBuffer) {
      this.activeSources -= 1
      gain.disconnect()
      this.startBuffer(userBuffer, impact, 1, true)
      return
    }
    const tone = TONES[kind] ?? TONES.box!
    const oscillator = context.createOscillator()
    oscillator.type = tone.type
    oscillator.frequency.value = tone.frequency + Math.min(impact, 10) * 12
    oscillator.connect(gain)
    const start = context.currentTime
    gain.gain.setValueAtTime(gain.gain.value, start)
    gain.gain.exponentialRampToValueAtTime(0.001, start + tone.duration)
    oscillator.onended = () => { this.activeSources = Math.max(0, this.activeSources - 1); gain.disconnect() }
    oscillator.start(start)
    oscillator.stop(start + tone.duration)
  }

  dispose() {
    this.userBuffers.clear()
    this.mergeBuffers.clear()
    this.mergeVolumes.clear()
    if (this.context) void this.context.close()
    this.context = undefined
    this.master = undefined
    this.activeSources = 0
  }

  private startBuffer(buffer: AudioBuffer, impact: number, gainScale: number, alreadyCounted = false) {
    if (!this.context || !this.master || this.activeSources >= 5) return
    const context = this.context
    if (!alreadyCounted) this.activeSources += 1
    const gain = context.createGain()
    gain.gain.value = Math.min(0.9, (0.08 + Math.min(impact, 12) / 18) * gainScale)
    gain.connect(this.master)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = 0.82 + Math.min(impact, 8) * 0.025
    source.connect(gain)
    source.onended = () => { this.activeSources = Math.max(0, this.activeSources - 1); gain.disconnect() }
    source.start()
  }
}
