let audio;
let current;
let attempt = 0;
const status = document.querySelector('.question-audio-status');

function setState(button, playing, label = button.dataset.playLabel) {
  button.setAttribute('aria-pressed', String(playing));
  button.textContent = label;
  button.setAttribute('aria-label', label === button.dataset.playLabel ? label : `${label} — ${button.dataset.playLabel}`);
}

function showError(button, token) {
  if (token !== attempt || button !== current) return;
  ++attempt;
  current = null;
  audio.pause();
  setState(button, false, 'Повторить');
  status.textContent = 'Не удалось воспроизвести аудио';
}

function createPlayer() {
  const player = new Audio();
  player.preload = 'none';
  player.hidden = true;
  document.body.append(player);
  player.addEventListener('ended', () => {
    if (current && player.ended) setState(current, false);
  });
  player.addEventListener('pause', () => {
    if (current && player.paused && !player.ended) setState(current, false, 'Продолжить');
  });
  player.addEventListener('error', () => {
    if (current && player.error) showError(current, attempt);
  });
  return player;
}

document.addEventListener('click', event => {
  const button = event.target.closest('.question-audio-controls > button');
  if (!button || event.defaultPrevented) return;

  audio ??= createPlayer();
  status.textContent = '';
  const token = ++attempt;
  if (button === current && !audio.paused) {
    audio.pause();
    setState(button, false, 'Продолжить');
    return;
  }
  if (button !== current) {
    audio.pause();
    if (current) setState(current, false);
    current = button;
    audio.src = button.previousElementSibling.href;
  }

  // Invoke play in the click handler, before yielding the user gesture.
  try {
    audio.play().then(() => {
      if (token === attempt && current === button && !audio.paused) setState(button, true, 'Пауза');
    }, () => showError(button, token));
  } catch {
    showError(button, token);
  }
});

window.addEventListener('pagehide', () => {
  if (!current || audio.paused) return;
  ++attempt;
  audio.pause();
  setState(current, false, 'Продолжить');
});
document.documentElement.classList.add('question-audio-ready');
