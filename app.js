(() => {
  'use strict';

  /* ========================================================================
     Constants & Storage Keys
     ======================================================================== */

  const STORAGE_KEYS = {
    CUSTOM_PRESETS: 'pulse_custom_presets_v1',
    HISTORY: 'pulse_history_v1',
    SELECTED_PRESET: 'pulse_selected_preset_v1',
    SOUND_ENABLED: 'pulse_sound_enabled_v1'
  };

  const BUILTIN_PRESETS = [
    {
      id: 'focus-45',
      name: '45-Min Session',
      type: 'focus',
      workSec: 45 * 60,
      restSec: 0,
      rounds: 1,
      builtin: true
    },
    {
      id: 'hiit-40-20',
      name: 'HIIT Intervals',
      type: 'interval',
      workSec: 40,
      restSec: 20,
      rounds: 10,
      builtin: true
    },
    {
      id: 'focus-15',
      name: 'Quick 15-Min Focus',
      type: 'focus',
      workSec: 15 * 60,
      restSec: 0,
      rounds: 1,
      builtin: true
    }
  ];

  const RING_RADIUS = 118;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

  /* ========================================================================
     Safe Storage Helpers
     ======================================================================== */

  function readStorage(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Ignore storage quota / private browsing errors
    }
  }

  /* ========================================================================
     Formatting & Date Helpers
     ======================================================================== */

  function formatClock(totalSeconds) {
    const clamped = Math.max(0, Math.ceil(totalSeconds));
    const hours = Math.floor(clamped / 3600);
    const minutes = Math.floor((clamped % 3600) / 60);
    const seconds = clamped % 60;

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function formatDurationLabel(totalSeconds) {
    const secs = Math.max(0, Math.round(totalSeconds));
    if (secs < 60) return `${secs}s`;
    const hours = Math.floor(secs / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    const remSecs = secs % 60;
    if (hours > 0) {
      return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    }
    if (remSecs > 0 && mins < 10) {
      return `${mins}m ${remSecs}s`;
    }
    return `${mins} min`;
  }

  function formatCompactTotalMinutes(totalSeconds) {
    const totalMins = Math.round(totalSeconds / 60);
    if (totalMins < 60) return `${totalMins} min total`;
    const hours = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    return mins > 0 ? `${hours}h ${mins}m total` : `${hours}h total`;
  }

  function toLocalDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function formatSessionTimestamp(isoString) {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '';

    const now = new Date();
    const todayKey = toLocalDateKey(now);
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const yesterdayKey = toLocalDateKey(yesterday);
    const itemKey = toLocalDateKey(date);

    const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (itemKey === todayKey) return `Today · ${timeStr}`;
    if (itemKey === yesterdayKey) return `Yesterday · ${timeStr}`;

    const dayStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `${dayStr} · ${timeStr}`;
  }

  function presetTotalSeconds(preset) {
    if (preset.type === 'interval') {
      return (preset.workSec + preset.restSec) * preset.rounds;
    }
    return preset.workSec;
  }

  function describePreset(preset) {
    if (preset.type === 'interval') {
      const workTxt = preset.workSec >= 60 ? formatDurationLabel(preset.workSec) : `${preset.workSec}s`;
      const restTxt = preset.restSec >= 60 ? formatDurationLabel(preset.restSec) : `${preset.restSec}s`;
      const totalTxt = formatDurationLabel(presetTotalSeconds(preset));
      return `${workTxt} work / ${restTxt} rest × ${preset.rounds} · ${totalTxt}`;
    }
    return `Single focus block · ${formatDurationLabel(preset.workSec)}`;
  }

  function buildPhases(preset) {
    if (preset.type === 'interval') {
      const phases = [];
      for (let round = 1; round <= preset.rounds; round += 1) {
        phases.push({
          kind: 'work',
          label: 'WORK',
          durationMs: preset.workSec * 1000,
          round,
          totalRounds: preset.rounds
        });
        if (preset.restSec > 0) {
          phases.push({
            kind: 'rest',
            label: 'REST',
            durationMs: preset.restSec * 1000,
            round,
            totalRounds: preset.rounds
          });
        }
      }
      return phases;
    }

    return [
      {
        kind: 'work',
        label: 'FOCUS',
        durationMs: preset.workSec * 1000,
        round: 1,
        totalRounds: 1
      }
    ];
  }

  /* ========================================================================
     Web Audio API Chime Synthesizer (Zero External Audio Files)
     ======================================================================== */

  const AudioEngine = (() => {
    let ctx = null;
    let enabled = readStorage(STORAGE_KEYS.SOUND_ENABLED, true) !== false;

    function getContext() {
      if (!ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          ctx = new AudioCtx();
        }
      }
      return ctx;
    }

    function unlock() {
      const audioCtx = getContext();
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
    }

    function isEnabled() {
      return enabled;
    }

    function setEnabled(next) {
      enabled = Boolean(next);
      writeStorage(STORAGE_KEYS.SOUND_ENABLED, enabled);
      if (enabled) {
        unlock();
        playSoftTap();
      }
    }

    function scheduleChimeNote(audioCtx, freq, offsetSec, durationSec, gainPeak) {
      const now = audioCtx.currentTime + offsetSec;

      const oscMain = audioCtx.createOscillator();
      const oscHarmonic = audioCtx.createOscillator();
      const mainGain = audioCtx.createGain();
      const harmonicGain = audioCtx.createGain();

      oscMain.type = 'sine';
      oscMain.frequency.setValueAtTime(freq, now);

      oscHarmonic.type = 'triangle';
      oscHarmonic.frequency.setValueAtTime(freq * 2, now);

      // Smooth envelope to eliminate clicks
      mainGain.gain.setValueAtTime(0.0001, now);
      mainGain.gain.linearRampToValueAtTime(gainPeak, now + 0.014);
      mainGain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

      harmonicGain.gain.setValueAtTime(0.0001, now);
      harmonicGain.gain.linearRampToValueAtTime(gainPeak * 0.16, now + 0.012);
      harmonicGain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec * 0.65);

      oscMain.connect(mainGain);
      oscHarmonic.connect(harmonicGain);
      mainGain.connect(audioCtx.destination);
      harmonicGain.connect(audioCtx.destination);

      oscMain.start(now);
      oscHarmonic.start(now);
      oscMain.stop(now + durationSec + 0.03);
      oscHarmonic.stop(now + durationSec + 0.03);
    }

    function playSoftTap() {
      if (!enabled) return;
      const audioCtx = getContext();
      if (!audioCtx) return;
      unlock();
      scheduleChimeNote(audioCtx, 587.33, 0, 0.16, 0.06);
    }

    function playTick() {
      if (!enabled) return;
      const audioCtx = getContext();
      if (!audioCtx) return;
      unlock();
      scheduleChimeNote(audioCtx, 880, 0, 0.08, 0.045);
    }

    function playTransitionToRest() {
      if (!enabled) return;
      const audioCtx = getContext();
      if (!audioCtx) return;
      unlock();
      // Calm descending chime (G5 -> D5)
      scheduleChimeNote(audioCtx, 783.99, 0, 0.32, 0.12);
      scheduleChimeNote(audioCtx, 587.33, 0.15, 0.55, 0.13);
    }

    function playTransitionToWork() {
      if (!enabled) return;
      const audioCtx = getContext();
      if (!audioCtx) return;
      unlock();
      // Crisp ascending chime (D5 -> A5)
      scheduleChimeNote(audioCtx, 587.33, 0, 0.24, 0.11);
      scheduleChimeNote(audioCtx, 880.0, 0.13, 0.48, 0.13);
    }

    function playComplete() {
      if (!enabled) return;
      const audioCtx = getContext();
      if (!audioCtx) return;
      unlock();
      // Warm resonant C-major triad + octave chime
      scheduleChimeNote(audioCtx, 523.25, 0, 0.45, 0.12);
      scheduleChimeNote(audioCtx, 659.25, 0.14, 0.5, 0.12);
      scheduleChimeNote(audioCtx, 783.99, 0.28, 0.58, 0.12);
      scheduleChimeNote(audioCtx, 1046.5, 0.44, 0.95, 0.14);
    }

    return {
      unlock,
      isEnabled,
      setEnabled,
      playSoftTap,
      playTick,
      playTransitionToRest,
      playTransitionToWork,
      playComplete
    };
  })();

  /* ========================================================================
     Screen Wake Lock Manager
     ======================================================================== */

  const WakeLockManager = (() => {
    let sentinel = null;
    let onStatusChange = () => {};

    function setListener(fn) {
      onStatusChange = fn;
    }

    async function acquire() {
      if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') {
        onStatusChange(false);
        return false;
      }
      if (sentinel && !sentinel.released) {
        onStatusChange(true);
        return true;
      }
      try {
        sentinel = await navigator.wakeLock.request('screen');
        onStatusChange(true);
        sentinel.addEventListener('release', () => {
          sentinel = null;
          onStatusChange(false);
        });
        return true;
      } catch {
        sentinel = null;
        onStatusChange(false);
        return false;
      }
    }

    async function release() {
      if (!sentinel) {
        onStatusChange(false);
        return;
      }
      try {
        await sentinel.release();
      } catch {
        // Ignore release errors
      } finally {
        sentinel = null;
        onStatusChange(false);
      }
    }

    return { acquire, release, setListener };
  })();

  /* ========================================================================
     DOM References
     ======================================================================== */

  const dom = {
    body: document.body,
    wakeBadge: document.getElementById('wake-badge'),
    soundToggleBtn: document.getElementById('sound-toggle-btn'),
    soundOnIcon: document.getElementById('sound-on-icon'),
    soundOffIcon: document.getElementById('sound-off-icon'),

    // Tabs & views
    tabTimer: document.getElementById('tab-timer'),
    tabHistory: document.getElementById('tab-history'),
    viewTimer: document.getElementById('view-timer'),
    viewHistory: document.getElementById('view-history'),

    // Timer elements
    presetList: document.getElementById('preset-list'),
    addPresetBtn: document.getElementById('add-preset-btn'),
    ringTicks: document.getElementById('ring-ticks'),
    ringProgress: document.getElementById('ring-progress'),
    phaseLabel: document.getElementById('phase-label'),
    timeDisplay: document.getElementById('time-display'),
    phaseMeta: document.getElementById('phase-meta'),
    roundDots: document.getElementById('round-dots'),
    presetDetail: document.getElementById('preset-detail'),
    deletePresetBtn: document.getElementById('delete-preset-btn'),

    // Controls
    resetBtn: document.getElementById('reset-btn'),
    playPauseBtn: document.getElementById('play-pause-btn'),
    playIcon: document.getElementById('play-icon'),
    pauseIcon: document.getElementById('pause-icon'),
    auxBtn: document.getElementById('aux-btn'),
    auxPlusIcon: document.getElementById('aux-plus-icon'),
    auxSkipIcon: document.getElementById('aux-skip-icon'),
    auxLabel: document.getElementById('aux-label'),

    // History elements
    clearHistoryBtn: document.getElementById('clear-history-btn'),
    statTotalSessions: document.getElementById('stat-total-sessions'),
    statTotalTime: document.getElementById('stat-total-time'),
    statStreak: document.getElementById('stat-streak'),
    statStreakNote: document.getElementById('stat-streak-note'),
    chartSelectedSummary: document.getElementById('chart-selected-summary'),
    chartWeekTotal: document.getElementById('chart-week-total'),
    activityChart: document.getElementById('activity-chart'),
    historyList: document.getElementById('history-list'),
    historyEmpty: document.getElementById('history-empty'),

    // Custom Preset Modal
    customModal: document.getElementById('custom-modal'),
    closeModalBtn: document.getElementById('close-modal-btn'),
    customPresetForm: document.getElementById('custom-preset-form'),
    modeFocusBtn: document.getElementById('mode-focus-btn'),
    modeIntervalBtn: document.getElementById('mode-interval-btn'),
    presetNameInput: document.getElementById('preset-name-input'),
    focusFields: document.getElementById('focus-fields'),
    intervalFields: document.getElementById('interval-fields'),
    focusMinutesInput: document.getElementById('focus-minutes-input'),
    focusSecondsInput: document.getElementById('focus-seconds-input'),
    intervalWorkInput: document.getElementById('interval-work-input'),
    intervalRestInput: document.getElementById('interval-rest-input'),
    intervalRoundsInput: document.getElementById('interval-rounds-input'),
    customTotalPreview: document.getElementById('custom-total-preview'),
    formError: document.getElementById('form-error'),

    // Toast
    toast: document.getElementById('toast')
  };

  /* ========================================================================
     Application State
     ======================================================================== */

  const state = {
    customPresets: loadCustomPresets(),
    history: loadHistory(),
    selectedPresetId: null,

    phases: [],
    phaseIndex: 0,
    phaseDurationMs: 0,
    phaseRemainingMs: 0,
    extraAddedMs: 0,

    isRunning: false,
    hasStarted: false,
    isCompleted: false,
    lastTickAt: 0,
    lastCueSec: null,
    rafId: null,
    intervalId: null,

    activeTab: 'timer',
    modalMode: 'focus',
    selectedChartDayKey: null,
    clearConfirmTimer: null,
    toastTimer: null
  };

  function loadCustomPresets() {
    const saved = readStorage(STORAGE_KEYS.CUSTOM_PRESETS, []);
    if (!Array.isArray(saved)) return [];
    return saved.filter(
      (item) =>
        item &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        (item.type === 'focus' || item.type === 'interval') &&
        Number.isFinite(item.workSec) &&
        item.workSec > 0
    );
  }

  function loadHistory() {
    const saved = readStorage(STORAGE_KEYS.HISTORY, []);
    if (!Array.isArray(saved)) return [];
    return saved.filter(
      (item) =>
        item &&
        typeof item.completedAt === 'string' &&
        typeof item.presetName === 'string' &&
        Number.isFinite(item.durationSec)
    );
  }

  function getAllPresets() {
    return [...BUILTIN_PRESETS, ...state.customPresets];
  }

  function getSelectedPreset() {
    const all = getAllPresets();
    return all.find((p) => p.id === state.selectedPresetId) || all[0];
  }

  /* ========================================================================
     Toast Notification
     ======================================================================== */

  function showToast(message) {
    dom.toast.textContent = message;
    dom.toast.hidden = false;
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      dom.toast.hidden = true;
      state.toastTimer = null;
    }, 2400);
  }

  /* ========================================================================
     SVG Chronograph Dial Setup
     ======================================================================== */

  function initDialGeometry() {
    dom.ringProgress.style.strokeDasharray = `${RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`;
    dom.ringProgress.style.strokeDashoffset = '0';

    const svgNS = 'http://www.w3.org/2000/svg';
    const frag = document.createDocumentFragment();
    const totalTicks = 60;
    const cx = 140;
    const cy = 140;

    for (let i = 0; i < totalTicks; i += 1) {
      const isMajor = i % 5 === 0;
      const angle = (i / totalTicks) * Math.PI * 2 - Math.PI / 2;
      const outerR = 134;
      const innerR = isMajor ? 127.5 : 130;

      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', (cx + Math.cos(angle) * innerR).toFixed(2));
      line.setAttribute('y1', (cy + Math.sin(angle) * innerR).toFixed(2));
      line.setAttribute('x2', (cx + Math.cos(angle) * outerR).toFixed(2));
      line.setAttribute('y2', (cy + Math.sin(angle) * outerR).toFixed(2));
      if (isMajor) line.classList.add('is-major');
      frag.appendChild(line);
    }

    dom.ringTicks.appendChild(frag);
  }

  /* ========================================================================
     Timer Engine
     ======================================================================== */

  function loadPreset(presetId, { silent = false } = {}) {
    stopLoops();
    WakeLockManager.release();

    const all = getAllPresets();
    const preset = all.find((p) => p.id === presetId) || all[0];
    state.selectedPresetId = preset.id;
    writeStorage(STORAGE_KEYS.SELECTED_PRESET, preset.id);

    state.phases = buildPhases(preset);
    state.phaseIndex = 0;
    state.phaseDurationMs = state.phases[0].durationMs;
    state.phaseRemainingMs = state.phases[0].durationMs;
    state.extraAddedMs = 0;

    state.isRunning = false;
    state.hasStarted = false;
    state.isCompleted = false;
    state.lastCueSec = null;

    renderPresetChips();
    renderTimerUI();
    updateDocumentTitle();

    if (!silent) {
      AudioEngine.unlock();
    }
  }

  function startTimer() {
    AudioEngine.unlock();

    if (state.isCompleted) {
      loadPreset(state.selectedPresetId, { silent: true });
    }

    if (state.isRunning) return;

    state.isRunning = true;
    state.hasStarted = true;
    state.lastTickAt = Date.now();
    AudioEngine.playSoftTap();
    WakeLockManager.acquire();

    startLoops();
    renderTimerUI();
    updateDocumentTitle();
  }

  function pauseTimer() {
    if (!state.isRunning) return;
    tick();
    state.isRunning = false;
    stopLoops();
    WakeLockManager.release();
    renderTimerUI();
    updateDocumentTitle();
  }

  function resetTimer() {
    loadPreset(state.selectedPresetId, { silent: true });
    AudioEngine.playSoftTap();
  }

  function handleAuxAction() {
    const preset = getSelectedPreset();
    AudioEngine.unlock();

    if (preset.type === 'interval') {
      if (state.isCompleted) return;
      advancePhase({ fromSkip: true });
      renderTimerUI();
      updateDocumentTitle();
      return;
    }

    // Focus session: +1 minute
    if (state.isCompleted) {
      loadPreset(state.selectedPresetId, { silent: true });
    }
    const bonusMs = 60 * 1000;
    state.phaseRemainingMs += bonusMs;
    state.phaseDurationMs += bonusMs;
    state.extraAddedMs += bonusMs;
    AudioEngine.playSoftTap();
    renderTimerUI();
    updateDocumentTitle();
    showToast('+1 minute added');
  }

  function startLoops() {
    stopLoops();

    const step = () => {
      if (!state.isRunning) return;
      tick();
      state.rafId = requestAnimationFrame(step);
    };
    state.rafId = requestAnimationFrame(step);

    // Background fallback when rAF is throttled
    state.intervalId = setInterval(() => {
      if (state.isRunning) tick();
    }, 250);
  }

  function stopLoops() {
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    if (state.intervalId !== null) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }
  }

  function tick() {
    const now = Date.now();
    const delta = Math.max(0, now - state.lastTickAt);
    state.lastTickAt = now;

    if (delta === 0) return;

    let remainingDelta = delta;
    const preset = getSelectedPreset();

    while (remainingDelta > 0 && state.isRunning) {
      if (remainingDelta < state.phaseRemainingMs) {
        state.phaseRemainingMs -= remainingDelta;
        remainingDelta = 0;

        // Subtle 3-2-1 cue during interval timers
        if (preset.type === 'interval') {
          const secLeft = Math.ceil(state.phaseRemainingMs / 1000);
          if (secLeft >= 1 && secLeft <= 3 && secLeft !== state.lastCueSec) {
            state.lastCueSec = secLeft;
            AudioEngine.playTick();
          }
        }
      } else {
        remainingDelta -= state.phaseRemainingMs;
        state.phaseRemainingMs = 0;
        const finishedAll = advancePhase({ fromSkip: false });
        if (finishedAll) {
          remainingDelta = 0;
        }
      }
    }

    renderTimerUI();
    updateDocumentTitle();
  }

  function advancePhase({ fromSkip }) {
    state.lastCueSec = null;

    if (state.phaseIndex + 1 < state.phases.length) {
      state.phaseIndex += 1;
      const nextPhase = state.phases[state.phaseIndex];
      state.phaseDurationMs = nextPhase.durationMs;
      state.phaseRemainingMs = nextPhase.durationMs;
      state.lastTickAt = Date.now();

      if (nextPhase.kind === 'rest') {
        AudioEngine.playTransitionToRest();
      } else {
        AudioEngine.playTransitionToWork();
      }

      if (typeof navigator.vibrate === 'function') {
        navigator.vibrate(nextPhase.kind === 'work' ? [45, 40, 45] : 50);
      }

      return false;
    }

    completeSession({ fromSkip });
    return true;
  }

  function completeSession({ fromSkip }) {
    state.isRunning = false;
    state.isCompleted = true;
    state.phaseRemainingMs = 0;
    stopLoops();
    WakeLockManager.release();

    AudioEngine.playComplete();
    if (typeof navigator.vibrate === 'function') {
      navigator.vibrate([70, 50, 90, 50, 120]);
    }

    if (!fromSkip) {
      recordCompletedSession();
      showToast('Session complete · Saved to History');
    } else {
      showToast('Session ended');
    }

    renderTimerUI();
    renderHistoryView();
    updateDocumentTitle();
  }

  function recordCompletedSession() {
    const preset = getSelectedPreset();
    const now = new Date();
    const totalSec = presetTotalSeconds(preset) + Math.round(state.extraAddedMs / 1000);

    const entry = {
      id: `sess_${now.getTime()}_${Math.random().toString(36).slice(2, 7)}`,
      presetId: preset.id,
      presetName: preset.name,
      type: preset.type,
      durationSec: Math.max(1, totalSec),
      completedAt: now.toISOString(),
      dateKey: toLocalDateKey(now)
    };

    state.history.unshift(entry);
    writeStorage(STORAGE_KEYS.HISTORY, state.history);
  }

  /* ========================================================================
     Timer UI Rendering
     ======================================================================== */

  function renderPresetChips() {
    const presets = getAllPresets();
    dom.presetList.innerHTML = '';

    for (const preset of presets) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'preset-chip';
      btn.setAttribute('role', 'tab');
      btn.dataset.presetId = preset.id;
      btn.textContent = preset.name;

      const isSelected = preset.id === state.selectedPresetId;
      btn.classList.toggle('is-selected', isSelected);
      btn.setAttribute('aria-selected', String(isSelected));

      btn.addEventListener('click', () => {
        if (preset.id === state.selectedPresetId) return;
        loadPreset(preset.id);
      });

      dom.presetList.appendChild(btn);
    }
  }

  function renderRoundDots(preset, currentPhase) {
    if (preset.type !== 'interval' || preset.rounds <= 1 || preset.rounds > 20) {
      dom.roundDots.hidden = true;
      dom.roundDots.innerHTML = '';
      return;
    }

    dom.roundDots.hidden = false;
    if (dom.roundDots.childElementCount !== preset.rounds) {
      dom.roundDots.innerHTML = '';
      for (let i = 1; i <= preset.rounds; i += 1) {
        const dot = document.createElement('span');
        dot.className = 'round-dot';
        dom.roundDots.appendChild(dot);
      }
    }

    const dots = dom.roundDots.children;
    for (let i = 0; i < dots.length; i += 1) {
      const roundNum = i + 1;
      dots[i].classList.toggle(
        'is-done',
        state.isCompleted || roundNum < currentPhase.round
      );
      dots[i].classList.toggle(
        'is-current',
        !state.isCompleted && roundNum === currentPhase.round && state.hasStarted
      );
    }
  }

  function renderTimerUI() {
    const preset = getSelectedPreset();
    const phase = state.phases[state.phaseIndex] || state.phases[0];

    // Visual theme phase attribute
    let visualPhase = 'idle';
    if (state.isCompleted) {
      visualPhase = 'complete';
    } else if (state.hasStarted) {
      visualPhase = phase.kind;
    }
    dom.body.setAttribute('data-phase', visualPhase);

    // Countdown digits
    const displaySec = state.isCompleted ? 0 : state.phaseRemainingMs / 1000;
    dom.timeDisplay.textContent = formatClock(displaySec);

    // SVG progress ring offset
    let progressFraction = 1;
    if (state.isCompleted) {
      progressFraction = 1;
    } else if (state.phaseDurationMs > 0) {
      progressFraction = Math.max(0, Math.min(1, state.phaseRemainingMs / state.phaseDurationMs));
    }
    const dashOffset = RING_CIRCUMFERENCE * (1 - progressFraction);
    dom.ringProgress.style.strokeDashoffset = dashOffset.toFixed(2);

    // Labels inside dial
    if (state.isCompleted) {
      dom.phaseLabel.textContent = 'COMPLETE';
      dom.phaseMeta.textContent = `${preset.name} finished`;
    } else if (!state.hasStarted) {
      dom.phaseLabel.textContent = preset.type === 'interval' ? 'INTERVALS' : 'READY';
      dom.phaseMeta.textContent = preset.name;
    } else if (preset.type === 'interval') {
      dom.phaseLabel.textContent = state.isRunning ? phase.label : `${phase.label} · PAUSED`;
      const nextPhase = state.phases[state.phaseIndex + 1];
      const nextHint = nextPhase
        ? ` · Next ${nextPhase.kind === 'rest' ? 'Rest' : 'Work'}`
        : ' · Final phase';
      dom.phaseMeta.textContent = `Round ${phase.round} of ${phase.totalRounds}${nextHint}`;
    } else {
      dom.phaseLabel.textContent = state.isRunning ? 'FOCUS' : 'PAUSED';
      dom.phaseMeta.textContent = preset.name;
    }

    renderRoundDots(preset, phase);

    // Preset caption & custom delete visibility
    dom.presetDetail.textContent = describePreset(preset);
    dom.deletePresetBtn.hidden = Boolean(preset.builtin);

    // Play / Pause button state
    dom.playPauseBtn.classList.toggle('is-running', state.isRunning);
    dom.playIcon.hidden = state.isRunning;
    dom.pauseIcon.hidden = !state.isRunning;
    dom.playPauseBtn.setAttribute(
      'aria-label',
      state.isRunning ? 'Pause timer' : state.isCompleted ? 'Restart timer' : 'Start timer'
    );

    // Reset button
    dom.resetBtn.disabled = !state.hasStarted && state.extraAddedMs === 0;

    // Aux button (+1 min for focus, Skip for intervals)
    const isInterval = preset.type === 'interval';
    dom.auxPlusIcon.hidden = isInterval;
    dom.auxSkipIcon.hidden = !isInterval;
    dom.auxLabel.textContent = isInterval ? 'Skip' : '+1 min';
    dom.auxBtn.setAttribute('aria-label', isInterval ? 'Skip current interval' : 'Add one minute');
    dom.auxBtn.disabled = isInterval && (state.isCompleted || !state.hasStarted);
  }

  function updateDocumentTitle() {
    if (state.isRunning) {
      const phase = state.phases[state.phaseIndex];
      const clock = formatClock(state.phaseRemainingMs / 1000);
      document.title = `${clock} · ${phase.label} — Pulse`;
    } else {
      document.title = 'Pulse — Focus & Interval Timer';
    }
  }

  /* ========================================================================
     History, Streak & 7-Day Bar Chart
     ======================================================================== */

  function computeCurrentStreak(history) {
    if (!history.length) return { streak: 0, activeToday: false };

    const activeDays = new Set(
      history.map((item) => item.dateKey || toLocalDateKey(new Date(item.completedAt)))
    );

    const cursor = new Date();
    cursor.setHours(12, 0, 0, 0);

    const todayKey = toLocalDateKey(cursor);
    const activeToday = activeDays.has(todayKey);

    if (!activeToday) {
      cursor.setDate(cursor.getDate() - 1);
      if (!activeDays.has(toLocalDateKey(cursor))) {
        return { streak: 0, activeToday: false };
      }
    }

    let streak = 0;
    while (activeDays.has(toLocalDateKey(cursor))) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }

    return { streak, activeToday };
  }

  function buildLast7Days(history) {
    const countsByDay = new Map();
    for (const item of history) {
      const key = item.dateKey || toLocalDateKey(new Date(item.completedAt));
      const existing = countsByDay.get(key) || { sessions: 0, totalSec: 0 };
      existing.sessions += 1;
      existing.totalSec += item.durationSec || 0;
      countsByDay.set(key, existing);
    }

    const days = [];
    const today = new Date();
    today.setHours(12, 0, 0, 0);

    for (let offset = 6; offset >= 0; offset -= 1) {
      const d = new Date(today);
      d.setDate(today.getDate() - offset);
      const key = toLocalDateKey(d);
      const bucket = countsByDay.get(key) || { sessions: 0, totalSec: 0 };
      days.push({
        key,
        shortDay: d.toLocaleDateString([], { weekday: 'short' }).slice(0, 3),
        fullLabel: offset === 0 ? 'Today' : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
        isToday: offset === 0,
        sessions: bucket.sessions,
        totalSec: bucket.totalSec
      });
    }

    return days;
  }

  function renderHistoryView() {
    const totalSessions = state.history.length;
    const totalSec = state.history.reduce((sum, item) => sum + (item.durationSec || 0), 0);
    const { streak, activeToday } = computeCurrentStreak(state.history);

    dom.statTotalSessions.textContent = String(totalSessions);
    dom.statTotalTime.textContent = formatCompactTotalMinutes(totalSec);

    dom.statStreak.innerHTML = `${streak} <span class="stat-unit">${streak === 1 ? 'day' : 'days'}</span>`;
    if (streak === 0) {
      dom.statStreakNote.textContent = 'Start today';
    } else if (activeToday) {
      dom.statStreakNote.textContent = 'Active today';
    } else {
      dom.statStreakNote.textContent = 'Complete 1 today to extend';
    }

    dom.clearHistoryBtn.hidden = totalSessions === 0;
    if (totalSessions === 0) {
      resetClearConfirm();
    }

    // 7-Day Activity Bar Chart
    const days = buildLast7Days(state.history);
    const weekSessions = days.reduce((sum, d) => sum + d.sessions, 0);
    const maxSessions = Math.max(1, ...days.map((d) => d.sessions));

    dom.chartWeekTotal.textContent = `${weekSessions} this week`;
    dom.activityChart.innerHTML = '';

    for (const day of days) {
      const col = document.createElement('button');
      col.type = 'button';
      col.className = 'chart-col';
      if (day.sessions > 0) col.classList.add('has-activity');
      if (day.isToday) col.classList.add('is-today');
      if (state.selectedChartDayKey === day.key) col.classList.add('is-selected');
      col.setAttribute(
        'aria-label',
        `${day.fullLabel}: ${day.sessions} ${day.sessions === 1 ? 'session' : 'sessions'}`
      );

      const countEl = document.createElement('span');
      countEl.className = 'chart-count';
      countEl.textContent = day.sessions > 0 ? String(day.sessions) : '';

      const track = document.createElement('span');
      track.className = 'chart-bar-track';

      const fill = document.createElement('span');
      fill.className = 'chart-bar-fill';
      const heightPct = day.sessions > 0 ? Math.max(14, Math.round((day.sessions / maxSessions) * 100)) : 5;
      fill.style.height = `${heightPct}%`;

      const labelEl = document.createElement('span');
      labelEl.className = 'chart-day';
      labelEl.textContent = day.shortDay;

      track.appendChild(fill);
      col.appendChild(countEl);
      col.appendChild(track);
      col.appendChild(labelEl);

      col.addEventListener('click', () => {
        state.selectedChartDayKey = state.selectedChartDayKey === day.key ? null : day.key;
        renderHistoryView();
      });

      dom.activityChart.appendChild(col);
    }

    const selectedDay = days.find((d) => d.key === state.selectedChartDayKey);
    if (selectedDay) {
      const sessTxt = `${selectedDay.sessions} ${selectedDay.sessions === 1 ? 'session' : 'sessions'}`;
      const timeTxt = selectedDay.totalSec > 0 ? ` · ${formatDurationLabel(selectedDay.totalSec)}` : '';
      dom.chartSelectedSummary.textContent = `${selectedDay.fullLabel}: ${sessTxt}${timeTxt}`;
    } else {
      dom.chartSelectedSummary.textContent = 'Sessions completed per day';
    }

    // Recent Sessions List
    dom.historyList.innerHTML = '';
    dom.historyEmpty.hidden = totalSessions > 0;

    const recent = state.history.slice(0, 30);
    for (const item of recent) {
      const li = document.createElement('li');
      li.className = 'history-item';

      const left = document.createElement('div');
      left.className = 'history-item-left';

      const dot = document.createElement('span');
      dot.className = `history-dot${item.type === 'interval' ? ' is-interval' : ''}`;

      const textWrap = document.createElement('div');
      textWrap.className = 'history-text';

      const nameEl = document.createElement('span');
      nameEl.className = 'history-name';
      nameEl.textContent = item.presetName;

      const dateEl = document.createElement('span');
      dateEl.className = 'history-date';
      dateEl.textContent = formatSessionTimestamp(item.completedAt);

      textWrap.appendChild(nameEl);
      textWrap.appendChild(dateEl);
      left.appendChild(dot);
      left.appendChild(textWrap);

      const durEl = document.createElement('span');
      durEl.className = 'history-duration';
      durEl.textContent = formatDurationLabel(item.durationSec);

      li.appendChild(left);
      li.appendChild(durEl);
      dom.historyList.appendChild(li);
    }
  }

  function resetClearConfirm() {
    if (state.clearConfirmTimer) {
      clearTimeout(state.clearConfirmTimer);
      state.clearConfirmTimer = null;
    }
    dom.clearHistoryBtn.dataset.armed = 'false';
    dom.clearHistoryBtn.textContent = 'Clear';
  }

  function handleClearHistoryClick() {
    if (dom.clearHistoryBtn.dataset.armed !== 'true') {
      dom.clearHistoryBtn.dataset.armed = 'true';
      dom.clearHistoryBtn.textContent = 'Confirm Clear';
      state.clearConfirmTimer = setTimeout(resetClearConfirm, 4000);
      return;
    }

    state.history = [];
    state.selectedChartDayKey = null;
    writeStorage(STORAGE_KEYS.HISTORY, []);
    resetClearConfirm();
    renderHistoryView();
    showToast('History cleared');
  }

  /* ========================================================================
     Bottom Tabs
     ======================================================================== */

  function switchTab(target) {
    state.activeTab = target;
    const isTimer = target === 'timer';

    dom.viewTimer.hidden = !isTimer;
    dom.viewHistory.hidden = isTimer;

    dom.tabTimer.classList.toggle('is-active', isTimer);
    dom.tabTimer.setAttribute('aria-selected', String(isTimer));
    dom.tabHistory.classList.toggle('is-active', !isTimer);
    dom.tabHistory.setAttribute('aria-selected', String(!isTimer));

    if (!isTimer) {
      renderHistoryView();
    }
  }

  /* ========================================================================
     Custom Preset Sheet
     ======================================================================== */

  function setModalMode(mode) {
    state.modalMode = mode;
    const isFocus = mode === 'focus';

    dom.modeFocusBtn.classList.toggle('is-active', isFocus);
    dom.modeFocusBtn.setAttribute('aria-pressed', String(isFocus));
    dom.modeIntervalBtn.classList.toggle('is-active', !isFocus);
    dom.modeIntervalBtn.setAttribute('aria-pressed', String(!isFocus));

    dom.focusFields.hidden = !isFocus;
    dom.intervalFields.hidden = isFocus;

    updateCustomTotalPreview();
  }

  function parseModalPresetValues() {
    if (state.modalMode === 'focus') {
      const mins = Math.max(0, Math.min(180, parseInt(dom.focusMinutesInput.value, 10) || 0));
      const secs = Math.max(0, Math.min(59, parseInt(dom.focusSecondsInput.value, 10) || 0));
      const workSec = mins * 60 + secs;
      return { type: 'focus', workSec, restSec: 0, rounds: 1 };
    }

    const workSec = Math.max(0, Math.min(3600, parseInt(dom.intervalWorkInput.value, 10) || 0));
    const restSec = Math.max(0, Math.min(3600, parseInt(dom.intervalRestInput.value, 10) || 0));
    const rounds = Math.max(0, Math.min(50, parseInt(dom.intervalRoundsInput.value, 10) || 0));
    return { type: 'interval', workSec, restSec, rounds };
  }

  function updateCustomTotalPreview() {
    const vals = parseModalPresetValues();
    const totalSec = presetTotalSeconds(vals);
    dom.customTotalPreview.textContent = formatClock(totalSec);
  }

  function openCustomModal() {
    dom.formError.hidden = true;
    dom.formError.textContent = '';
    dom.presetNameInput.value = '';
    setModalMode('focus');
    dom.focusMinutesInput.value = '25';
    dom.focusSecondsInput.value = '0';
    dom.intervalWorkInput.value = '30';
    dom.intervalRestInput.value = '15';
    dom.intervalRoundsInput.value = '8';
    updateCustomTotalPreview();

    dom.customModal.hidden = false;
    setTimeout(() => dom.presetNameInput.focus(), 60);
  }

  function closeCustomModal() {
    dom.customModal.hidden = true;
  }

  function handleCustomPresetSubmit(event) {
    event.preventDefault();
    const rawName = dom.presetNameInput.value.trim();
    const vals = parseModalPresetValues();

    if (!rawName) {
      dom.formError.textContent = 'Please enter a name for your preset.';
      dom.formError.hidden = false;
      dom.presetNameInput.focus();
      return;
    }

    if (vals.type === 'focus' && vals.workSec < 5) {
      dom.formError.textContent = 'Focus duration must be at least 5 seconds.';
      dom.formError.hidden = false;
      return;
    }

    if (vals.type === 'interval' && (vals.workSec < 5 || vals.rounds < 1)) {
      dom.formError.textContent = 'Work interval must be at least 5 seconds with at least 1 round.';
      dom.formError.hidden = false;
      return;
    }

    const newPreset = {
      id: `custom_${Date.now()}`,
      name: rawName,
      type: vals.type,
      workSec: vals.workSec,
      restSec: vals.restSec,
      rounds: vals.rounds,
      builtin: false
    };

    state.customPresets.push(newPreset);
    writeStorage(STORAGE_KEYS.CUSTOM_PRESETS, state.customPresets);

    closeCustomModal();
    loadPreset(newPreset.id);
    showToast(`Added "${newPreset.name}"`);
  }

  function deleteSelectedCustomPreset() {
    const preset = getSelectedPreset();
    if (!preset || preset.builtin) return;

    state.customPresets = state.customPresets.filter((p) => p.id !== preset.id);
    writeStorage(STORAGE_KEYS.CUSTOM_PRESETS, state.customPresets);
    loadPreset(BUILTIN_PRESETS[0].id);
    showToast(`Removed "${preset.name}"`);
  }

  /* ========================================================================
     Sound & Wake Lock UI Sync
     ======================================================================== */

  function syncSoundButton() {
    const on = AudioEngine.isEnabled();
    dom.soundToggleBtn.setAttribute('aria-pressed', String(on));
    dom.soundOnIcon.hidden = !on;
    dom.soundOffIcon.hidden = on;
  }

  /* ========================================================================
     Event Binding & Initialization
     ======================================================================== */

  function bindEvents() {
    dom.soundToggleBtn.addEventListener('click', () => {
      AudioEngine.setEnabled(!AudioEngine.isEnabled());
      syncSoundButton();
      showToast(AudioEngine.isEnabled() ? 'Chimes enabled' : 'Chimes muted');
    });

    dom.playPauseBtn.addEventListener('click', () => {
      if (state.isRunning) {
        pauseTimer();
      } else {
        startTimer();
      }
    });

    dom.resetBtn.addEventListener('click', resetTimer);
    dom.auxBtn.addEventListener('click', handleAuxAction);
    dom.deletePresetBtn.addEventListener('click', deleteSelectedCustomPreset);

    // Tabs
    dom.tabTimer.addEventListener('click', () => switchTab('timer'));
    dom.tabHistory.addEventListener('click', () => switchTab('history'));
    dom.clearHistoryBtn.addEventListener('click', handleClearHistoryClick);

    // Custom Preset Modal
    dom.addPresetBtn.addEventListener('click', openCustomModal);
    dom.closeModalBtn.addEventListener('click', closeCustomModal);
    dom.customModal.addEventListener('click', (e) => {
      if (e.target === dom.customModal) closeCustomModal();
    });
    dom.modeFocusBtn.addEventListener('click', () => setModalMode('focus'));
    dom.modeIntervalBtn.addEventListener('click', () => setModalMode('interval'));
    dom.customPresetForm.addEventListener('submit', handleCustomPresetSubmit);

    [
      dom.focusMinutesInput,
      dom.focusSecondsInput,
      dom.intervalWorkInput,
      dom.intervalRestInput,
      dom.intervalRoundsInput
    ].forEach((input) => {
      input.addEventListener('input', updateCustomTotalPreview);
    });

    // Keyboard shortcuts (Space to toggle play/pause, Escape to close modal)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !dom.customModal.hidden) {
        closeCustomModal();
        return;
      }
      if (
        e.code === 'Space' &&
        dom.customModal.hidden &&
        state.activeTab === 'timer' &&
        document.activeElement.tagName !== 'INPUT' &&
        document.activeElement.tagName !== 'BUTTON'
      ) {
        e.preventDefault();
        if (state.isRunning) pauseTimer();
        else startTimer();
      }
    });

    // Re-acquire Screen Wake Lock and resync timer when returning to foreground
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.isRunning) {
        tick();
        WakeLockManager.acquire();
      }
    });

    WakeLockManager.setListener((active) => {
      dom.wakeBadge.hidden = !active;
    });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
        // Service worker registration may be unavailable in insecure contexts
      });
    });
  }

  function init() {
    initDialGeometry();
    syncSoundButton();
    bindEvents();

    const savedPresetId = readStorage(STORAGE_KEYS.SELECTED_PRESET, BUILTIN_PRESETS[0].id);
    loadPreset(savedPresetId, { silent: true });
    renderHistoryView();
    registerServiceWorker();
  }

  init();
})();
