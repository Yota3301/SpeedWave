(() => {
    'use strict';
    const KEY = 'speedsync.settings.v1';
    const ID = 'speedsync-controls';
    const scriptNode = document.currentScript;
    const previous = window.__speedSync;
    if (previous && typeof previous.dispose === 'function') previous.dispose();

    const defaults = { rate: 1, preservePitch: false };
    let settings = { ...defaults };
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
        if (Number.isFinite(saved.rate)) settings.rate = Math.max(0.5, Math.min(2, saved.rate));
        if (typeof saved.preservePitch === 'boolean') settings.preservePitch = saved.preservePitch;
    } catch (_) { /* storage may be unavailable */ }
    const touched = new Map();
    const subscriptions = new Map();
    const audioEvents = ['ratechange', 'seeking', 'seeked', 'playing', 'loadedmetadata'];
    let rescanScheduled = false;
    let applying = false;
    let hookedApi = null;
    let originalSetPlayer = null;
    let wrappedSetPlayer = null;
    let disposed = false;
    let timer;
    let queued = false;
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (_) {} };
    const formatRate = n => String(Number(n.toFixed(2))).replace('.', ',') + '×';

    function findAudioElements() {
        const found = new Set();
        const add = item => { if (item instanceof HTMLAudioElement) found.add(item); };
        try {
            const state = window.pulsesyncApi?.playerInstance?.state;
            const players = state?.mediaPlayersStore?.value;
            // Restrict changes to the app's audio players, not video/animations.
            for (const key of ['audio', 'downloadedAudio', 'hls']) {
                const player = players?.[key];
                add(player?.currentAudioElement?.value);
                if (Array.isArray(player?.audioElementsStore)) player.audioElementsStore.forEach(add);
                add(player?.core?.source);
            }
            const current = state?.currentMediaPlayer?.value;
            add(current?.currentAudioElement?.value);
            if (Array.isArray(current?.audioElementsStore)) current.audioElementsStore.forEach(add);
        } catch (_) { /* player may not be ready yet */ }
        document.querySelectorAll('audio').forEach(add);
        return found;
    }

    function applyOne(audio) {
        if (disposed) return;
        try {
            if (audio.preservesPitch !== settings.preservePitch) audio.preservesPitch = settings.preservePitch;
            if (audio.defaultPlaybackRate !== settings.rate) audio.defaultPlaybackRate = settings.rate;
            if (audio.playbackRate !== settings.rate) audio.playbackRate = settings.rate;
        } catch (error) { console.warn('[SpeedWave] Не удалось изменить скорость аудио:', error); }
    }
    function scheduleAudioScan() {
        if (disposed || rescanScheduled) return;
        rescanScheduled = true;
        queueMicrotask(() => { rescanScheduled = false; applyAudio(); });
    }
    function installRateGuard(audio, key) {
        // Limit the interception to the actual audio elements, never the global prototype.
        const own = Object.getOwnPropertyDescriptor(audio, key);
        if (own && !own.configurable) return null;
        let descriptor = own;
        for (let proto = Object.getPrototypeOf(audio); !descriptor && proto; proto = Object.getPrototypeOf(proto)) {
            descriptor = Object.getOwnPropertyDescriptor(proto, key);
        }
        if (!descriptor || typeof descriptor.get !== 'function' || typeof descriptor.set !== 'function') return null;
        const get = descriptor.get;
        const set = descriptor.set;
        const guardedGet = function () { return get.call(this); };
        const guardedSet = function (requested) { return set.call(this, disposed ? requested : settings.rate); };
        try {
            Object.defineProperty(audio, key, { configurable: true, enumerable: descriptor.enumerable, get: guardedGet, set: guardedSet });
            return { own, guardedGet, guardedSet };
        } catch (_) { return null; }
    }
    function removeRateGuard(audio, key, guard) {
        if (!guard) return;
        try {
            const current = Object.getOwnPropertyDescriptor(audio, key);
            // Do not overwrite a different addon's later descriptor.
            if (current?.get !== guard.guardedGet || current?.set !== guard.guardedSet) return;
            if (guard.own) Object.defineProperty(audio, key, guard.own);
            else delete audio[key];
        } catch (_) {}
    }
    function watchAudio(audio) {
        if (touched.has(audio)) return;
        const original = { rate: audio.playbackRate, defaultRate: audio.defaultPlaybackRate, pitch: audio.preservesPitch };
        const onEvent = () => applyOne(audio);
        const guards = { rate: installRateGuard(audio, 'playbackRate'), defaultRate: installRateGuard(audio, 'defaultPlaybackRate') };
        touched.set(audio, { ...original, onEvent, guards });
        for (const event of audioEvents) audio.addEventListener(event, onEvent);
    }
    function unwatchAudio(audio, original) {
        for (const event of audioEvents) audio.removeEventListener(event, original.onEvent);
        removeRateGuard(audio, 'playbackRate', original.guards.rate);
        removeRateGuard(audio, 'defaultPlaybackRate', original.guards.defaultRate);
    }
    function syncSubscriptions() {
        const wanted = new Set();
        const add = observable => { if (observable && typeof observable.onChange === 'function') wanted.add(observable); };
        try {
            const state = window.pulsesyncApi?.playerInstance?.state;
            add(state?.mediaPlayersStore);
            add(state?.currentMediaPlayer);
            const players = state?.mediaPlayersStore?.value;
            for (const key of ['audio', 'downloadedAudio', 'hls']) add(players?.[key]?.currentAudioElement);
            add(state?.currentMediaPlayer?.value?.currentAudioElement);
        } catch (_) { /* player may not be ready yet */ }
        for (const [observable, unsubscribe] of subscriptions) {
            if (!wanted.has(observable)) { try { unsubscribe(); } catch (_) {} subscriptions.delete(observable); }
        }
        for (const observable of wanted) {
            if (subscriptions.has(observable)) continue;
            try {
                // Reserve before calling onChange in case it calls the callback synchronously.
                subscriptions.set(observable, () => {});
                const unsubscribe = observable.onChange(() => { if (applying) scheduleAudioScan(); else applyAudio(); }, { skipFirstChange: true });
                if (typeof unsubscribe === 'function') subscriptions.set(observable, unsubscribe);
            } catch (_) { subscriptions.delete(observable); }
        }
    }
    function syncPlayerHook() {
        const api = window.pulsesyncApi;
        if (!api || api === hookedApi || typeof api.setPlayerInstance !== 'function') return;
        removePlayerHook();
        hookedApi = api;
        originalSetPlayer = api.setPlayerInstance;
        const delegate = originalSetPlayer;
        wrappedSetPlayer = function (...args) {
            const result = delegate.apply(this, args);
            if (!disposed) applyAudio();
            return result;
        };
        try { api.setPlayerInstance = wrappedSetPlayer; } catch (_) { hookedApi = null; }
    }
    function removePlayerHook() {
        try { if (hookedApi && hookedApi.setPlayerInstance === wrappedSetPlayer) hookedApi.setPlayerInstance = originalSetPlayer; } catch (_) {}
        hookedApi = null;
        originalSetPlayer = null;
        wrappedSetPlayer = null;
    }
    function applyAudio() {
        if (disposed) return;
        if (applying) { scheduleAudioScan(); return; }
        applying = true;
        try {
            syncPlayerHook();
            syncSubscriptions();
            const current = findAudioElements();
            for (const audio of current) { watchAudio(audio); applyOne(audio); }
            // Avoid retaining old players indefinitely, including their event listeners.
            if (touched.size > 32) {
                for (const [el, original] of touched) {
                    if (!current.has(el)) { unwatchAudio(el, original); touched.delete(el); }
                }
            }
        } finally { applying = false; }
    }
    function updateUI() {
        const root = document.getElementById(ID);
        if (!root) return;
        root.querySelector('output').textContent = formatRate(settings.rate);
        const range = root.querySelector('input[type=range]');
        range.value = String(settings.rate);
        range.setAttribute('aria-valuetext', formatRate(settings.rate));
        range.style.setProperty('--ss-progress', `${(settings.rate - .5) / 1.5 * 100}%`);
        root.querySelectorAll('[data-rate]').forEach(button => {
            const selected = Math.abs(Number(button.dataset.rate) - settings.rate) < .001;
            button.classList.toggle('ss-selected', selected);
            button.setAttribute('aria-pressed', String(selected));
        });
        root.querySelector('[role=switch]').setAttribute('aria-checked', String(settings.preservePitch));
    }
    function setRate(value) {
        const rate = Number(value);
        if (!Number.isFinite(rate)) return;
        settings.rate = Math.round(Math.max(.5, Math.min(2, rate)) * 100) / 100;
        save(); updateUI(); applyAudio();
    }
    function attachUI() {
        if (disposed) return;
        // QUALITY_SETTINGS_CONTEXT_MENU is a documented test id in the shipped UI.
        const dialogs = document.querySelectorAll('[data-test-id="QUALITY_SETTINGS_CONTEXT_MENU"]');
        for (const dialog of dialogs) {
            if (dialog.querySelector('#' + ID)) continue;
            const header = dialog.querySelector('[class*="QualitySettings_headerWithCloseButton"]');
            if (!header || !header.parentElement) continue;
            const root = document.createElement('section');
            root.id = ID;
            root.setAttribute('aria-label', 'Скорость воспроизведения');
            root.innerHTML = `<div class="ss-heading"><label for="ss-range">Скорость</label><output for="ss-range">1×</output></div>
              <input id="ss-range" class="ss-slider" type="range" min="0.5" max="2" step="0.01" value="1" aria-label="Скорость воспроизведения">
              <div class="ss-presets" aria-label="Готовые скорости">
                <button type="button" data-rate="0.75">0,75×</button><button type="button" data-rate="0.85">0,85×</button><button type="button" data-rate="1">1×</button><button type="button" data-rate="1.15">1,15×</button><button type="button" data-rate="1.25">1,25×</button><button type="button" data-rate="1.5">1,5×</button>
              </div>
              <div class="ss-pitch"><div><div class="ss-pitch-title">Сохранять тон</div><div class="ss-hint">Если выключить — эффект slowed / speed up: голос станет ниже или выше</div></div><button type="button" class="ss-switch" role="switch" aria-label="Сохранять тон" aria-checked="false"><span></span></button></div>`;
            root.querySelector('input').addEventListener('input', event => setRate(event.target.value));
            root.querySelectorAll('[data-rate]').forEach(button => button.addEventListener('click', () => setRate(button.dataset.rate)));
            root.querySelector('[role=switch]').addEventListener('click', () => { settings.preservePitch = !settings.preservePitch; save(); updateUI(); applyAudio(); });
            header.insertAdjacentElement('afterend', root);
            updateUI();
        }
    }
    function scheduleUI() {
        if (queued || disposed) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; attachUI(); });
    }
    const observer = new MutationObserver(() => {
        if (scriptNode && !scriptNode.isConnected) { dispose(); return; }
        if (window.pulsesyncApi !== hookedApi) scheduleAudioScan();
        scheduleUI();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    function dispose() {
        if (disposed) return;
        disposed = true; clearInterval(timer); observer.disconnect(); removePlayerHook();
        document.querySelectorAll('#' + ID).forEach(el => el.remove());
        for (const unsubscribe of subscriptions.values()) { try { unsubscribe(); } catch (_) {} }
        subscriptions.clear();
        for (const [audio, original] of touched) {
            unwatchAudio(audio, original);
            try {
                if (audio.playbackRate === settings.rate) audio.playbackRate = original.rate;
                if (audio.defaultPlaybackRate === settings.rate) audio.defaultPlaybackRate = original.defaultRate;
                if (audio.preservesPitch === settings.preservePitch) audio.preservesPitch = original.pitch;
            } catch (_) {}
        }
        touched.clear();
        if (window.__speedSync?.dispose === dispose) delete window.__speedSync;
    }
    window.__speedSync = { dispose };
    attachUI(); applyAudio();
    timer = setInterval(applyAudio, 500);
    console.info('[SpeedWave] Загружен');
})();
