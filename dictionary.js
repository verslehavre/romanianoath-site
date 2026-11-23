const dictionary = document.querySelector('.dictionary');
const controls = dictionary.querySelector('.dictionary-controls');
const input = controls.querySelector('input');
const count = controls.querySelector('[data-count]');
const searchControls = controls.querySelector('.dictionary-search-controls');
const filterControls = controls.querySelector('.dictionary-filters');
const filters = [...controls.querySelectorAll('[data-filter]')];
const sections = [...dictionary.querySelectorAll('[data-dictionary-section]')];
const datesLink = dictionary.querySelector('a[href="#dictionary-dates"]');
const backTop = dictionary.querySelector('.dictionary-back-top');
const datesHash = '#dictionary-dates';
const foldCharacters = {ă: 'a', â: 'a', î: 'i', ș: 's', ş: 's', ț: 't', ţ: 't', ё: 'е'};
const searchable = text => text.normalize('NFC').toLowerCase()
  .replace(/[ăâîșşțţё]/g, char => foldCharacters[char])
  .replace(/(\d)\s*[-–—]\s*(?=\d)/g, '$1-').trim().replace(/\s+/g, ' ');
const entries = [...dictionary.querySelectorAll('.dictionary-row')].map(row => {
  const section = row.closest('[data-dictionary-section]').dataset.dictionarySection;
  const terms = [row.querySelector('h2'), ...row.querySelectorAll('[data-translation-text]')]
    .map(node => searchable(node.textContent));
  if (section === 'dates') {
    terms.push(...row.dataset.dateAliases.split('\n').map(searchable));
  }
  return {row, section, chapters: row.dataset.chapters.split(' '), terms};
});

let selectedFilter = '';
function filterEntries() {
  const query = searchable(input.value);
  const found = {words: 0, dates: 0};
  for (const {row, section, chapters, terms} of entries) {
    const inFilter = selectedFilter === 'dates' ? section === 'dates'
      : !selectedFilter || chapters.includes(selectedFilter);
    const visible = inFilter && terms.some(term => term.includes(query));
    row.hidden = !visible;
    if (visible) found[section]++;
  }
  const total = found.words + found.dates;
  for (const section of sections) section.hidden = !found[section.dataset.dictionarySection];
  const message = query || selectedFilter ? (total ? `Найдено: ${total}` : 'Ничего не найдено') : '';
  if (count.textContent !== message) count.textContent = message;
}

const player = new Audio();
player.preload = 'none';
const error = document.createElement('span');
error.className = 'dictionary-audio-error';
error.setAttribute('role', 'status');
let active;
let attempt = 0;

function setLabel(link, action) {
  link.toggleAttribute('data-playing', action === 'Пауза');
  link.title = action + ': ' + link.dataset.term;
  link.setAttribute('aria-label', link.title);
}

function resetPlayer() {
  attempt++;
  const previous = active;
  active = undefined;
  player.pause();
  if (player.currentTime > 0) player.currentTime = 0;
  if (previous) setLabel(previous, 'Слушать');
}

function audioError() {
  if (!active) return;
  active.after(error);
  error.textContent = 'Не удалось воспроизвести аудио';
  resetPlayer();
}

player.addEventListener('playing', () => {
  if (active && !player.paused) setLabel(active, 'Пауза');
});
player.addEventListener('pause', () => {
  if (active && player.paused && !player.ended) setLabel(active, 'Продолжить');
});
player.addEventListener('ended', resetPlayer);
player.addEventListener('error', () => {
  if (player.error) audioError();
});

async function toggleAudio(link) {
  error.remove();
  if (active === link && !player.paused) {
    attempt++;
    player.pause();
    setLabel(link, 'Продолжить');
    return;
  }
  if (active !== link) {
    resetPlayer();
    active = link;
    player.src = link.href;
  }
  const open = ++attempt;
  try {
    await player.play();
  } catch {
    if (open === attempt) audioError();
  }
}

function selectFilter(value) {
  selectedFilter = value;
  for (const button of filters) button.setAttribute('aria-pressed', String(button.dataset.filter === value));
  datesLink?.setAttribute('aria-pressed', String(value === 'dates'));
}

function keepControlsVisible() {
  const {top, bottom} = controls.getBoundingClientRect();
  if (top < 0 || bottom > window.innerHeight) {
    controls.scrollIntoView({block: 'start', behavior: 'instant'});
  }
}

function showDates() {
  input.value = '';
  selectFilter('dates');
  filterEntries();
  keepControlsVisible();
}

datesLink?.addEventListener('click', event => {
  if (event.defaultPrevented || event.button || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  event.preventDefault();
  showDates();
});
datesLink?.addEventListener('keydown', event => {
  if (event.key === ' ') {
    event.preventDefault();
    showDates();
  }
});

input.addEventListener('input', filterEntries);
dictionary.addEventListener('click', event => {
  const link = event.target.closest('a[data-audio]');
  if (link) {
    if (event.defaultPrevented || event.button || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    toggleAudio(link);
    return;
  }
  const filter = event.target.closest('[data-filter]');
  if (filter) {
    selectFilter(filter.dataset.filter);
  } else if (event.target.closest('[data-clear]')) {
    input.value = '';
    input.focus();
  } else {
    return;
  }
  filterEntries();
  if (filter) keepControlsVisible();
});

backTop.addEventListener('click', event => {
  if (event.defaultPrevented || event.button || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  event.preventDefault();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({top: 0, behavior: reducedMotion ? 'instant' : 'smooth'});
});

datesLink?.setAttribute('role', 'button');
selectFilter(datesLink && location.hash === datesHash ? 'dates' : '');
searchControls.hidden = false;
filterControls.hidden = false;
filterEntries();
if (selectedFilter === 'dates') {
  keepControlsVisible();
  window.addEventListener('load', () => {
    if (selectedFilter === 'dates') keepControlsVisible();
  }, {once: true});
}
