(() => {
  const content = document.getElementById('communication-phrases');
  const controls = document.querySelector('.communication .dictionary-controls');
  const input = controls.querySelector('input');
  const count = controls.querySelector('[data-count]');
  const foldCharacters = {ă: 'a', â: 'a', î: 'i', ș: 's', ş: 's', ț: 't', ţ: 't', ё: 'е'};
  const searchable = text => text.normalize('NFC').toLowerCase()
    .replace(/[ăâîșşțţё]/g, char => foldCharacters[char]).trim().replace(/\s+/g, ' ');
  const entries = [...content.children].map(row => ({
    row, terms: [...row.querySelectorAll('[lang]')].map(node => searchable(node.textContent)),
  }));
  const player = new Audio();
  player.preload = 'none';
  let active = null;
  let attempt = 0;

  function setPlaying(button, playing) {
    const action = playing ? 'Остановить' : 'Воспроизвести';
    const phrase = button.closest('[data-phrase-id]').querySelector('[lang="ro"]').textContent;
    button.setAttribute('aria-label', `${action} на румынском: ${phrase}`);
    button.setAttribute('aria-pressed', String(playing));
    button.toggleAttribute('data-playing', playing);
  }

  function stop() {
    attempt++;
    const previous = active;
    active = null;
    player.pause();
    if (player.currentTime > 0) player.currentTime = 0;
    if (previous) setPlaying(previous, false);
  }

  function statusFor(button) {
    return button.closest('[data-phrase-id]').querySelector('.dictionary-audio-error');
  }

  function showError() {
    if (!active) return;
    const status = statusFor(active);
    stop();
    status.textContent = 'Не удалось загрузить или воспроизвести запись. Проверьте соединение и попробуйте ещё раз.';
    status.hidden = false;
  }

  player.addEventListener('playing', () => {
    if (active && !player.paused) setPlaying(active, true);
  });
  player.addEventListener('ended', () => {
    if (player.ended) stop();
  });
  player.addEventListener('error', () => {
    if (player.error) showError();
  });
  function filterEntries() {
    const query = searchable(input.value);
    let found = 0;
    for (const {row, terms} of entries) {
      row.hidden = !terms.some(term => term.includes(query));
      if (!row.hidden) found++;
    }
    if (active?.closest('[data-phrase-id]').hidden) stop();
    content.hidden = found === 0;
    const message = query ? (found ? `Найдено: ${found}` : 'Ничего не найдено') : '';
    if (count.textContent !== message) count.textContent = message;
  }

  input.addEventListener('input', filterEntries);
  controls.querySelector('[data-clear]').addEventListener('click', () => {
    input.value = '';
    input.focus();
    filterEntries();
  });
  controls.hidden = false;
  filterEntries();

  window.addEventListener('pagehide', stop);
  content.addEventListener('click', async event => {
    const button = event.target.closest('button[data-audio]');
    if (!button) return;
    statusFor(button).hidden = true;
    const wasActive = active === button;
    stop();
    if (wasActive) return;
    active = button;
    player.src = button.dataset.audio;
    const open = attempt;
    try {
      await player.play();
    } catch {
      if (open === attempt) showError();
    }
  });
})();
