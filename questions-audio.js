let active = null;

function pauseNativePlayers(except) {
  for (const audio of document.querySelectorAll('.question-audio:not([hidden]) audio')) {
    if (audio !== except && !audio.paused) audio.pause();
  }
}

function preparePlayer(details, signal) {
  const audio = details.querySelector('audio');
  const label = details.dataset.playLabel;
  if (!audio || !label) throw new Error('Missing audio controls');
  // Closing a native player does not stop its audio.
  if (!audio.paused) return null;

  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.originalLabel = label;
  const buttonLabel = document.createElement('span');
  button.append(buttonLabel);
  const status = document.createElement('span');
  status.className = 'question-audio-status';
  status.setAttribute('role', 'status');
  const controls = document.createElement('div');
  controls.className = 'question-audio-controls';
  controls.append(button, status);

  let attempt = 0;
  const setState = (playing, action = label, error = '') => {
    button.setAttribute('aria-pressed', String(playing));
    button.setAttribute('aria-label', action === label ? label : `${action} — ${label.slice('Слушать '.length)}`);
    buttonLabel.textContent = action;
    status.textContent = error;
  };
  const reset = () => {
    attempt++;
    audio.pause();
    if (audio.currentTime !== 0) audio.currentTime = 0;
    setState(false);
  };
  const player = {reset};
  const showError = () => {
    if (active !== player) return;
    active = null;
    reset();
    setState(false, label, 'Не удалось воспроизвести аудио');
  };

  setState(false);
  audio.addEventListener('playing', () => {
    if (active === player && !audio.paused) setState(true, 'Пауза');
  }, {signal});
  audio.addEventListener('pause', () => {
    if (active === player && audio.paused && !audio.ended) setState(false, 'Продолжить');
  }, {signal});
  audio.addEventListener('error', showError, {signal});
  audio.addEventListener('ended', () => {
    if (active !== player) return;
    active = null;
    reset();
  }, {signal});
  button.addEventListener('click', async () => {
    if (active === player && !audio.paused) {
      attempt++;
      audio.pause();
      setState(false, 'Продолжить');
      return;
    }
    if (active !== player) {
      const previous = active;
      active = player;
      previous?.reset();
    }
    const currentAttempt = ++attempt;
    setState(false, buttonLabel.textContent);
    try {
      pauseNativePlayers();
      await audio.play();
    } catch {
      if (currentAttempt === attempt) showError();
    }
  }, {signal});
  return controls;
}

// Keep a fallback player the reader already opened while the module was loading.
const nativePlayers = [...document.querySelectorAll('.question-audio:not([open])')];
const listeners = new AbortController();
const controls = [];
try {
  for (const details of nativePlayers) controls.push(preparePlayer(details, listeners.signal));
  nativePlayers.forEach((details, index) => {
    if (!controls[index]) return;
    details.before(controls[index]);
    details.hidden = true;
  });
  document.addEventListener('play', ({target}) => {
    if (!(target instanceof HTMLAudioElement) || target.paused ||
        !target.closest('.question-audio:not([hidden])')) return;
    active?.reset();
    active = null;
    pauseNativePlayers(target);
  }, {capture: true, signal: listeners.signal});
} catch {
  listeners.abort();
  for (const control of controls) control?.remove();
  for (const details of nativePlayers) details.hidden = false;
}
