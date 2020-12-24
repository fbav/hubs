const isMobile = AFRAME.utils.device.isMobile();
const isMobileVR = AFRAME.utils.device.isMobileVR();
const isFirefoxReality = isMobileVR && navigator.userAgent.match(/Firefox/);

// This is a list of regexes that match the microphone labels of HMDs.
//
// If entering VR mode, and if any of these regexes match an audio device,
// the user will be prevented from entering VR until one of those devices is
// selected as the microphone.
//
// Note that this doesn't have to be exhaustive: if no devices match any regex
// then we rely upon the user to select the proper mic.
const HMD_MIC_REGEXES = [/\Wvive\W/i, /\Wrift\W/i];

export default class AudioManager {
  constructor(scene, store) {
    this._scene = scene;
    this._store = store;
    this._micDevices = [];
    this._deviceId = null;
    this._audioTrack = null;
    this._mediaStream = null;

    navigator.mediaDevices.addEventListener("devicechange", this.onDeviceChange);
  }

  get deviceId() {
    return this._deviceId;
  }

  set deviceId(deviceId) {
    this._deviceId = deviceId;
  }

  get audioTrack() {
    return this._audioTrack;
  }

  set audioTrack(audioTrack) {
    this._audioTrack = audioTrack;
  }

  get micDevices() {
    return this._micDevices;
  }

  set micDevices(micDevices) {
    this._micDevices = micDevices;
  }

  get mediaStream() {
    return this._mediaStream;
  }

  set mediaStream(mediaStream) {
    this._mediaStream = mediaStream;
  }

  get selectedMicLabel() {
    return this.micLabelForAudioTrack(this.audioTrack);
  }

  get selectedMicDeviceId() {
    return this.micDeviceIdForMicLabel(this.selectedMicLabel);
  }

  get lastUsedMicDeviceId() {
    const { lastUsedMicDeviceId } = this._store.state.settings;
    return lastUsedMicDeviceId;
  }

  get isAudioDeviceSelected() {
    return this.audioTrack !== null;
  }

  onDeviceChange = () => {
    this.fetchMicDevices().then(() => {
      this._scene.emit("devicechange", null);
    });
  };

  async selectMicDevice(deviceId) {
    const constraints = { audio: { deviceId: { exact: [deviceId] } } };
    const result = await this.fetchAudioTrack(constraints);
    await this.setupNewMediaStream();

    return result;
  }

  async setMediaStreamToDefault() {
    let hasAudio = false;

    // Try to fetch last used mic, if there was one.
    if (this.lastUsedMicDeviceId) {
      hasAudio = await this.fetchAudioTrack({ audio: { deviceId: { ideal: this.lastUsedMicDeviceId } } });
    } else {
      hasAudio = await this.fetchAudioTrack({ audio: {} });
    }

    await this.setupNewMediaStream();

    return { hasAudio };
  }

  async fetchAudioTrack(constraints = { audio: {} }) {
    if (this.audioTrack) {
      this.audioTrack.stop();
    }

    constraints.audio.echoCancellation = this._store.state.preferences.disableEchoCancellation === true ? false : true;
    constraints.audio.noiseSuppression = this._store.state.preferences.disableNoiseSuppression === true ? false : true;
    constraints.audio.autoGainControl = this._store.state.preferences.disableAutoGainControl === true ? false : true;

    if (isFirefoxReality) {
      //workaround for https://bugzilla.mozilla.org/show_bug.cgi?id=1626081
      constraints.audio.echoCancellation =
        this._store.state.preferences.disableEchoCancellation === false ? true : false;
      constraints.audio.noiseSuppression =
        this._store.state.preferences.disableNoiseSuppression === false ? true : false;
      constraints.audio.autoGainControl = this._store.state.preferences.disableAutoGainControl === false ? true : false;

      this._store.update({
        preferences: {
          disableEchoCancellation: !constraints.audio.echoCancellation,
          disableNoiseSuppression: !constraints.audio.noiseSuppression,
          disableAutoGainControl: !constraints.audio.autoGainControl
        }
      });
    }

    try {
      const newStream = await navigator.mediaDevices.getUserMedia(constraints);

      const audioSystem = this._scene.systems["hubs-systems"].audioSystem;
      audioSystem.addStreamToOutboundAudio("microphone", newStream);
      this.mediaStream = audioSystem.outboundStream;
      this.audioTrack = newStream.getAudioTracks()[0];

      if (/Oculus/.test(navigator.userAgent)) {
        // HACK Oculus Browser 6 seems to randomly end the microphone audio stream. This re-creates it.
        // Note the ended event will only fire if some external event ends the stream, not if we call stop().
        const recreateAudioStream = async () => {
          console.warn(
            "Oculus Browser 6 bug hit: Audio stream track ended without calling stop. Recreating audio stream."
          );

          const newStream = await navigator.mediaDevices.getUserMedia(constraints);
          this.audioTrack = newStream.getAudioTracks()[0];

          audioSystem.addStreamToOutboundAudio("microphone", newStream);

          this._scene.emit("local-media-stream-created");

          this.audioTrack.addEventListener("ended", recreateAudioStream, { once: true });
        };

        this.audioTrack.addEventListener("ended", recreateAudioStream, { once: true });
      }

      return true;
    } catch (e) {
      // Error fetching audio track, most likely a permission denial.
      console.error("Error during getUserMedia: ", e);
      this.audioTrack = null;
      return false;
    }
  }

  async setupNewMediaStream() {
    await this.fetchMicDevices();

    // we should definitely have an audioTrack at this point unless they denied mic access
    if (this.audioTrack) {
      const micDeviceId = this.micDeviceIdForMicLabel(this.micLabelForAudioTrack(this.audioTrack));
      if (micDeviceId) {
        this._store.update({ settings: { lastUsedMicDeviceId: micDeviceId } });
        console.log(`Selected input device: ${this.micLabelForDeviceId(micDeviceId)}`);
      }
      this._scene.emit("local-media-stream-created");
    } else {
      console.log("No available audio tracks");
    }
  }

  async fetchMicDevices() {
    return new Promise(resolve => {
      navigator.mediaDevices.enumerateDevices().then(mediaDevices => {
        this.micDevices = mediaDevices
          .filter(d => d.kind === "audioinput")
          .map(d => ({ value: d.deviceId, label: d.label || `Mic (${d.deviceId.substr(0, 9)})` }));
        resolve();
      });
    });
  }

  async shouldShowHmdMicWarning() {
    if (isMobile || AFRAME.utils.device.isMobileVR()) return false;
    if (!this.state.enterInVR) return false;
    if (!this.hasHmdMicrophone()) return false;

    return !HMD_MIC_REGEXES.find(r => this.selectedMicLabel.match(r));
  }

  micLabelForAudioTrack(audioTrack) {
    return (audioTrack && audioTrack.label) || "";
  }

  micDeviceIdForMicLabel(label) {
    return this.micDevices.filter(d => d.label === label).map(d => d.value)[0];
  }

  micLabelForDeviceId(deviceId) {
    return this.micDevices.filter(d => d.value === deviceId).map(d => d.label)[0];
  }

  hasHmdMicrophone() {
    return !!this.state.micDevices.find(d => HMD_MIC_REGEXES.find(r => d.label.match(r)));
  }
}
