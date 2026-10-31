const byId = (id) => document.getElementById(id);
const toggles = [...document.querySelectorAll('[data-toggle]')];
const labels = {
  'question-ru': 'перевод вопроса',
  'answer-ro': 'ответ',
  'answer-ru': 'перевод ответа',
  'speaking-answer-ru': 'перевод короткого ответа',
  vocabulary: 'словарь',
};
let cards = [];
let index = 0;
let mode = 'study';
let answerOptions = new Map();
let optionsUnavailable = false;
let choiceSession = null;
let choiceNotice = '';
const memorySessions = new Map();
const optionIds = ['correct', 'wrong_1', 'wrong_2'];
let chapters = [];
let selectedChapterId = null;
let selectedBlockId = null;
let initialRender = true;
// Screen transitions manage scrolling; reload should not restore an old offset.
history.scrollRestoration = 'manual';
let availableCards = new Map();
let speechGeneration = 0;
let currentAudio = null;
let activeAudioButton = null;
const synth = window.speechSynthesis;
const speechSupported = Boolean(synth && window.SpeechSynthesisUtterance);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

// Retain the original strings, including whitespace and diacritics.
export function joinCards(originals, translations) {
  if (!Array.isArray(originals) || !Array.isArray(translations)) {
    throw new Error('Ожидались массивы записей в обоих JSON-файлах.');
  }
  const translated = new Map();
  for (const entry of translations) {
    if (entry && nonempty(entry.id) && !translated.has(entry.id)) translated.set(entry.id, entry);
  }
  const seen = new Set();
  return originals.flatMap((original) => {
    if (!original || !nonempty(original.id) || seen.has(original.id)
      || !nonempty(original.question) || !nonempty(original.source_answer)) return [];
    const translation = translated.get(original.id);
    if (!translation || !nonempty(translation.question_ru) || !nonempty(translation.answer_ru)
      || !Array.isArray(translation.vocabulary) || !translation.vocabulary.length
      || !translation.vocabulary.every((word) => word && nonempty(word.ro) && nonempty(word.ru))) return [];
    seen.add(original.id);
    return [{ ...original, question_ru: translation.question_ru, answer_ru: translation.answer_ru,
      vocabulary: translation.vocabulary }];
  });
}

function showScreen(screenId, headingId) {
  stopRecognition(true);
  stopSpeech();
  setAudioStatus();
  for (const id of ['chapters-screen', 'stages-screen', 'trainer']) {
    byId(id).hidden = id !== screenId;
  }
  if (headingId) byId(headingId).focus();
}

function blockReady(block) {
  return Boolean(block) && Array.isArray(block.card_ids) && block.card_ids.length > 0
    && block.card_ids.some((id) => availableCards.has(id));
}

function selectedBlock() {
  return chapters.find((chapter) => chapter.id === selectedChapterId)?.blocks
    .find((block) => block.id === selectedBlockId);
}

function choiceReady(block) {
  return blockReady(block) && block.card_ids.every((id) => availableCards.has(id) && answerOptions.has(id));
}

function shuffle(values) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Completed results are separate from resumable exercise sessions.
const progressKey = 'romanian-oath-progress';
const exerciseModes = ['study', 'choice', 'listening', 'speaking'];
let progress = { version: 1, blocks: {} };
let progressRaw;
let progressWritable = true;
let progressDirty = false;
let progressCorrupt = false;
let studyAttempt = null;
const newAttemptId = () => crypto.randomUUID();
function progressNotice(message = '') {
  byId('progress-status').textContent = message;
  byId('progress-status').hidden = !message;
}
function validateProgress(value) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const exactKeys = (obj, keys) => Object.keys(obj).length === keys.length && keys.every(key => Object.hasOwn(obj, key));
  if (!object(value) || !exactKeys(value, ['version', 'blocks']) || value.version !== 1 || !object(value.blocks)) throw Error('format');
  const knownIds = new Set(chapters.flatMap(chapter => chapter.blocks.map(block => block.id)));
  for (const [blockId, results] of Object.entries(value.blocks)) {
    if (!knownIds.has(blockId) || !object(results)) throw Error('block');
    for (const [exercise, result] of Object.entries(results)) {
      const scored = exercise === 'choice' || exercise === 'listening';
      const fields = ['completedAt', 'completedAttempts', 'lastCompletionId', ...(scored ? ['correct', 'incorrect'] : [])];
      if (!exerciseModes.includes(exercise) || !object(result) || !exactKeys(result, fields)
        || !Number.isSafeInteger(result.completedAttempts) || result.completedAttempts < 1
        || !nonempty(result.lastCompletionId) || result.lastCompletionId.length > 200
        || typeof result.completedAt !== 'string' || !Number.isFinite(Date.parse(result.completedAt))
        || new Date(result.completedAt).toISOString() !== result.completedAt) throw Error('result');
      if (scored && (![result.correct, result.incorrect].every(n => Number.isSafeInteger(n) && n >= 0)
        || !Number.isSafeInteger(result.correct + result.incorrect) || result.correct + result.incorrect < 1)) throw Error('score');
    }
  }
  return value;
}
function loadProgress() {
  if (restoreStorageBlocked) { progressWritable = false; return; }
  let raw;
  try { raw = localStorage.getItem(progressKey); }
  catch {
    progressWritable = false;
    progressNotice('Не удаётся прочитать или сохранить прогресс в браузере. Результаты доступны только до закрытия страницы.');
    return;
  }
  if (raw === progressRaw && !progressCorrupt) {
    progressWritable = true;
    if (!progressDirty) progressNotice();
    return;
  }
  try {
    const loaded = raw === null ? { version: 1, blocks: {} } : validateProgress(JSON.parse(raw));
    // Preserve unsaved in-memory completions if storage has not changed since a failed write.
    if (raw !== progressRaw || progressCorrupt) { progress = loaded; progressDirty = false; }
    progressRaw = raw;
    progressCorrupt = false;
    progressWritable = true;
    progressNotice();
  } catch {
    progressWritable = false;
    progressCorrupt = true;
    progressNotice('Сохранённый прогресс повреждён или имеет неподдерживаемую версию. Он не перезаписан. Новые результаты доступны только до закрытия страницы.');
  }
}
function recordCompletion(exercise, attemptId) {
  if (!attemptId) return;
  const block = selectedBlock();
  if (exercise === 'study' && (!studyAttempt || studyAttempt.id !== attemptId
    || !block.card_ids.every(id => availableCards.has(id) && studyAttempt.visited.has(id)))) return;
  let score = {};
  if (exercise === 'choice' || exercise === 'listening') {
    const answers = block.card_ids.map(id => choiceSession?.answers[id]);
    if (!answers.every(answer => optionIds.includes(answer))) return;
    const correct = answers.filter(answer => answer === 'correct').length;
    score = { correct, incorrect: answers.length - correct };
  }
  loadProgress();
  const previous = progress.blocks[block.id]?.[exercise];
  if (previous?.lastCompletionId === attemptId) {
    if (progressDirty) saveProgress();
    return;
  }
  const completedAttempts = (previous?.completedAttempts || 0) + 1;
  if (!Number.isSafeInteger(completedAttempts)) {
    progressNotice('Не удалось сохранить прогресс: счётчик завершений слишком велик.');
    return;
  }
  progress.blocks[block.id] ??= {};
  progress.blocks[block.id][exercise] = { completedAt: new Date().toISOString(), completedAttempts,
    lastCompletionId: attemptId, ...score };
  progressDirty = true;
  saveProgress();
}
function saveProgress() {
  if (!progressWritable) return;
  try {
    const raw = JSON.stringify(progress);
    localStorage.setItem(progressKey, raw);
    progressRaw = raw;
    progressDirty = false;
    progressNotice();
  } catch {
    progressWritable = false;
    progressNotice('Не удалось сохранить прогресс в браузере. Новый результат доступен только до закрытия страницы.');
  }
}
function blockProgress(blockId) {
  return exerciseModes.filter(exercise => progress.blocks[blockId]?.[exercise]).length;
}
function renderStageProgress() {
  const results = progress.blocks[selectedBlockId] || {};
  byId('block-progress').textContent = `Пройдено ${blockProgress(selectedBlockId)} из 4 упражнений`;
  for (const exercise of exerciseModes) {
    const result = results[exercise];
    const icon = byId(`open-${exercise}`).querySelector('.stage-icon');
    icon.textContent = result ? '✓' : '○';
    icon.classList.toggle('completed', Boolean(result));
    const element = byId(`${exercise}-progress`);
    element.replaceChildren();
    const summary = document.createElement('span');
    const scored = result && (exercise === 'choice' || exercise === 'listening');
    summary.textContent = !result ? 'Не завершено' : scored
      ? `${result.correct} из ${result.correct + result.incorrect} верно` : 'Завершено';
    summary.classList.toggle('sr-only', !scored);
    if (scored) {
      const status = document.createElement('span');
      status.className = 'sr-only';
      status.textContent = 'Упражнение завершено. ';
      element.append(status);
    }
    element.append(summary);
  }
}
window.addEventListener('storage', event => {
  if (event.key !== progressKey && event.key !== null) return;
  loadProgress();
  if (!byId('stages-screen').hidden) renderStageProgress();
  if (!byId('chapters-screen').hidden) renderChapters(false, location.hash.startsWith('#chapter/') ? selectedChapterId : null);
});

// Backups contain only result metadata and resumable option IDs, never material text.
const backupFormat = 'romanian-oath-trainer-backup';
const restoreJournalKey = 'romanian-oath-restore-journal';
const backupLimit = 2 * 1024 * 1024;
let restoreStorageBlocked = false;
let pendingBackup = null;
let backupFileGeneration = 0;
const managedStorageKey = key => key === progressKey || /^romanian-oath-(choice|listening|speaking):[^:]+:[^:]+$/.test(key);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasKeys = (value, keys) => plainObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const permutationOf = (values, expected) => Array.isArray(values) && values.length === expected.length && new Set(values).size === expected.length && values.every(value => expected.includes(value));
function backupNotice(message) { byId('backup-status').textContent = message; }
function storedExerciseKey(exercise, chapterId, blockId) { return `romanian-oath-${exercise}:${chapterId}:${blockId}`; }
function materialSignature(block) {
  // Translation display does not change the assessed material or invalidate existing attempts/backups.
  return JSON.stringify(block.card_ids.map(id => {
    const entry = answerOptions.get(id);
    return [id, entry && { card_id: entry.card_id, short_answer_ro: entry.short_answer_ro, wrong_answers_ro: entry.wrong_answers_ro }];
  }));
}
async function materialHash(block) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(materialSignature(block)));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
function compatibleSession(session, exercise, block, strict = true) {
  const scored = exercise !== 'speaking';
  const fields = ['version', 'attemptId', 'order', 'position', ...(scored ? ['options', 'answers'] : []), ...(exercise === 'listening' ? ['unlocked'] : [])];
  if (!plainObject(session) || (strict && !hasKeys(session, fields))
    || session.version !== (scored ? 2 : 1) || !nonempty(session.attemptId) || session.attemptId.length > 200
    || !permutationOf(session.order, block.card_ids) || !Number.isInteger(session.position)
    || session.position < 0 || session.position >= block.card_ids.length) throw Error('Некорректная незавершённая попытка.');
  if (scored && (!Array.isArray(session.options) || session.options.length !== block.card_ids.length
    || !session.options.every(order => permutationOf(order, optionIds)) || !plainObject(session.answers)
    || !permutationOf(Object.keys(session.answers), block.card_ids)
    || !Object.values(session.answers).every(answer => answer === null || optionIds.includes(answer))
    || !session.order.slice(0, session.position).every(id => optionIds.includes(session.answers[id])))) throw Error('Некорректные ответы незавершённой попытки.');
  if (exercise === 'listening' && (!plainObject(session.unlocked) || !permutationOf(Object.keys(session.unlocked), block.card_ids)
    || !Object.values(session.unlocked).every(value => typeof value === 'boolean')
    || !block.card_ids.every(id => session.answers[id] === null || session.unlocked[id]))) throw Error('Некорректное состояние аудирования.');
  return Object.fromEntries(fields.map(field => [field, session[field]]));
}
function storageSnapshot() {
  const snapshot = new Map([[progressKey, localStorage.getItem(progressKey)]]);
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (managedStorageKey(key)) snapshot.set(key, localStorage.getItem(key));
  }
  return snapshot;
}
function writeSnapshot(snapshot) {
  // Remove surplus keys first to free quota. Try every rollback operation even if one fails.
  let failed = false;
  const current = storageSnapshot();
  for (const key of current.keys()) {
    if (!snapshot.has(key) || snapshot.get(key) === null) {
      try { if (localStorage.getItem(key) !== null) localStorage.removeItem(key); } catch { failed = true; }
    }
  }
  for (const [key, value] of snapshot) {
    if (value === null) continue;
    try { if (localStorage.getItem(key) !== value) localStorage.setItem(key, value); } catch { failed = true; }
  }
  if (failed) throw Error('Не удалось записать данные браузера.');
}
function recoverRestore() {
  let raw;
  try { raw = localStorage.getItem(restoreJournalKey); }
  catch {
    restoreStorageBlocked = true;
    progressNotice('Не удалось проверить хранилище браузера. Занятия доступны, но сохранение временно отключено. Перезагрузите страницу после восстановления доступа к localStorage.');
    return;
  }
  if (raw === null) return;
  try {
    const journal = JSON.parse(raw);
    if (!hasKeys(journal, ['version', 'before']) || journal.version !== 1 || !Array.isArray(journal.before)
      || !journal.before.every(pair => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string'
        && managedStorageKey(pair[0]) && (pair[1] === null || typeof pair[1] === 'string'))
      || new Set(journal.before.map(pair => pair[0])).size !== journal.before.length
      || !journal.before.some(pair => pair[0] === progressKey)) throw Error('journal');
    writeSnapshot(new Map(journal.before));
    localStorage.removeItem(restoreJournalKey);
    restoreStorageBlocked = false;
    backupNotice('Предыдущее восстановление было прервано. Прежние данные возвращены.');
  } catch {
    restoreStorageBlocked = true;
    progressNotice('Не удалось завершить откат восстановления. Сохранение временно недоступно; занятия можно продолжать. Сохраните исходный файл резервной копии и перезагрузите страницу после восстановления доступа к данным браузера.');
  }
}
async function createBackup() {
  if (restoreStorageBlocked) throw Error('Сначала необходимо завершить откат предыдущего восстановления.');
  loadProgress();
  if (progressCorrupt) throw Error('Сохранённый прогресс повреждён. Экспорт отменён, исходные данные не изменены.');
  const result = JSON.parse(JSON.stringify(validateProgress(progress)));
  // Read all disk entries first; a read failure must not produce a silently incomplete backup.
  const snapshots = storageSnapshot();
  for (const [key, session] of memorySessions) snapshots.set(key, JSON.stringify(session));
  const attempts = [];
  let skipped = 0;
  for (const [key, raw] of snapshots) {
    if (key === progressKey || raw === null) continue;
    const [, exercise, chapterId, blockId] = key.match(/^romanian-oath-(choice|listening|speaking):([^:]+):([^:]+)$/) || [];
    const chapter = chapters.find(chapter => chapter.id === chapterId);
    const block = chapter?.blocks.find(block => block.id === blockId);
    let session;
    try {
      if (!block || !choiceReady(block)) throw Error('unavailable');
      const saved = JSON.parse(raw);
      if (saved.signature !== materialSignature(block)) throw Error('materials');
      session = compatibleSession({ ...saved, attemptId: saved.attemptId || newAttemptId() }, exercise, block, false);
    } catch { skipped++; continue; }
    attempts.push({ chapterId, blockId, exercise, materialHash: await materialHash(block), session });
  }
  return { data: { format: backupFormat, version: 1, exportedAt: new Date().toISOString(), progress: result, attempts }, skipped };
}
async function validateBackup(value) {
  if (!hasKeys(value, ['format', 'version', 'exportedAt', 'progress', 'attempts']) || value.format !== backupFormat) throw Error('Это не резервная копия Romanian Oath Trainer.');
  if (value.version !== 1) throw Error('Версия резервной копии не поддерживается.');
  if (!validDate(value.exportedAt)) throw Error('Некорректная дата резервной копии.');
  let checkedProgress;
  try { checkedProgress = validateProgress(value.progress); }
  catch { throw Error('Некорректные результаты, даты или счётчики прогресса.'); }
  const maxAttempts = chapters.reduce((sum, chapter) => sum + chapter.blocks.length * 3, 0);
  if (!Array.isArray(value.attempts) || value.attempts.length > maxAttempts) throw Error('Некорректный список незавершённых попыток.');
  const entries = new Map([[progressKey, JSON.stringify(checkedProgress)]]);
  for (const attempt of value.attempts) {
    if (!hasKeys(attempt, ['chapterId', 'blockId', 'exercise', 'materialHash', 'session'])
      || !['choice', 'listening', 'speaking'].includes(attempt.exercise)) throw Error('Некорректный тип незавершённого упражнения.');
    const chapter = chapters.find(chapter => chapter.id === attempt.chapterId);
    const block = chapter?.blocks.find(block => block.id === attempt.blockId);
    if (!block || !choiceReady(block) || attempt.materialHash !== await materialHash(block)) throw Error('Незавершённая попытка несовместима с текущими учебными материалами. Восстановление отменено.');
    const session = compatibleSession(attempt.session, attempt.exercise, block);
    const key = storedExerciseKey(attempt.exercise, chapter.id, block.id);
    if (entries.has(key)) throw Error('В файле повторяется незавершённая попытка.');
    // Rebuild the app's existing signature locally; it is not stored as material text in the file.
    entries.set(key, JSON.stringify({ ...session, signature: materialSignature(block) }));
  }
  return { exportedAt: value.exportedAt, progress: checkedProgress, entries, attempts: value.attempts.length };
}
function applyBackup(backup) {
  if (restoreStorageBlocked) throw Error('Сначала необходимо завершить откат предыдущего восстановления.');
  const before = storageSnapshot();
  if (localStorage.getItem(restoreJournalKey) !== null) throw Error('Обнаружено незавершённое восстановление. Перезагрузите страницу.');
  // A durable rollback journal is written before touching any result or attempt.
  localStorage.setItem(restoreJournalKey, JSON.stringify({ version: 1, before: [...before] }));
  try {
    writeSnapshot(backup.entries);
    localStorage.removeItem(restoreJournalKey); // Commit only after all keys have been written.
  } catch {
    try {
      writeSnapshot(before);
      localStorage.removeItem(restoreJournalKey);
    } catch {
      restoreStorageBlocked = true;
      progressNotice('Не удалось полностью вернуть прежние данные. Журнал отката сохранён; перезагрузите страницу после восстановления доступа к localStorage.');
      throw Error('Сбой записи и отката. Сохраните резервную копию отдельно; журнал позволит повторить откат при следующем открытии.');
    }
    throw Error('Не удалось восстановить прогресс. Прежние результаты и попытки возвращены.');
  }
  // Do not replace live memory until the complete storage transaction succeeds.
  progress = JSON.parse(JSON.stringify(backup.progress));
  progressRaw = backup.entries.get(progressKey);
  progressWritable = true;
  progressDirty = false;
  progressCorrupt = false;
  memorySessions.clear();
  choiceSession = null;
  studyAttempt = null;
  progressNotice();
  renderRoute();
}
byId('export-progress').addEventListener('click', async () => {
  try {
    const { data, skipped } = await createBackup();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `romanian-oath-progress-${data.exportedAt.slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    backupNotice(`Резервная копия подготовлена. Незавершённых попыток: ${data.attempts.length}.${skipped ? ` Несовместимых или повреждённых попыток пропущено: ${skipped}.` : ''}`);
  } catch (error) { backupNotice(`Не удалось сохранить резервную копию. ${error.message}`); }
});
byId('import-progress').addEventListener('click', () => byId('backup-file').click());
byId('backup-file').addEventListener('change', async () => {
  const file = byId('backup-file').files[0];
  byId('backup-file').value = ''; // The same file can be selected again.
  if (!file) return;
  const generation = ++backupFileGeneration;
  pendingBackup = null;
  try {
    if (file.size > backupLimit) throw Error('Файл слишком большой (максимум 2 МБ).');
    const backup = await validateBackup(JSON.parse(await file.text()));
    if (generation !== backupFileGeneration || byId('chapters-screen').hidden) return;
    pendingBackup = backup;
    const results = Object.values(backup.progress.blocks).reduce((sum, block) => sum + Object.keys(block).length, 0);
    byId('backup-preview').textContent = `Копия от ${new Date(backup.exportedAt).toLocaleString('ru-RU')}. Завершённых упражнений: ${results}. Незавершённых попыток: ${backup.attempts}. Текущие результаты и незавершённые попытки будут заменены целиком.`;
    byId('restore-dialog').showModal();
    byId('cancel-restore').focus();
  } catch (error) {
    if (generation === backupFileGeneration) backupNotice(`Файл не восстановлен. ${error instanceof SyntaxError ? 'Некорректный JSON.' : error.message}`);
  }
});
function cancelRestore() {
  pendingBackup = null;
  backupFileGeneration++;
  byId('restore-dialog').close();
  backupNotice('Восстановление отменено. Данные не изменены.');
  byId('import-progress').focus();
}
byId('cancel-restore').addEventListener('click', cancelRestore);
byId('restore-dialog').addEventListener('cancel', event => { event.preventDefault(); cancelRestore(); });
byId('confirm-restore').addEventListener('click', () => {
  if (!pendingBackup) return;
  const backup = pendingBackup;
  pendingBackup = null;
  byId('restore-dialog').close();
  try { applyBackup(backup); backupNotice('Прогресс и незавершённые попытки восстановлены.'); }
  catch (error) { backupNotice(`Восстановление не выполнено. ${error.message}`); }
  byId('import-progress').focus();
});

function sessionKey() { return `romanian-oath-${mode === 'speaking' ? 'speaking' : mode === 'listening' ? 'listening' : 'choice'}:${selectedChapterId}:${selectedBlockId}`; }
function sessionSignature() {
  return materialSignature(selectedBlock());
}
function storageNotice() {
  byId('choice-storage-status').textContent = choiceNotice;
  byId('choice-storage-status').hidden = !choiceNotice;
}
function storageFailed() {
  choiceNotice = 'Сохранение в браузере недоступно. После закрытия страницы продолжить попытку не получится.';
  storageNotice();
}
function saveChoice(remove = false) {
  const key = sessionKey();
  if (remove) memorySessions.delete(key);
  else memorySessions.set(key, choiceSession);
  if (restoreStorageBlocked) { storageFailed(); return; }
  try {
    if (remove) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(choiceSession));
  } catch { storageFailed(); }
}
function readChoice() {
  let saved = memorySessions.get(sessionKey());
  try {
    const raw = restoreStorageBlocked ? null : localStorage.getItem(sessionKey());
    if (raw && !saved) {
      try { saved = JSON.parse(raw); }
      catch { saved = { version: 0 }; }
      if (!saved || typeof saved !== 'object') saved = { version: 0 };
    }
  } catch { storageFailed(); }
  if (!saved) return null;
  const ids = selectedBlock().card_ids;
  const permutation = (actual, expected) => Array.isArray(actual) && actual.length === expected.length
    && new Set(actual).size === expected.length && actual.every((id) => expected.includes(id));
  if (mode === 'speaking') {
    if (saved.version === 1 && saved.signature === sessionSignature()
      && permutation(saved.order, ids) && Number.isInteger(saved.position)
      && saved.position >= 0 && saved.position < ids.length) {
      return { version: 1, attemptId: saved.attemptId, signature: saved.signature, order: saved.order, position: saved.position };
    }
    saveChoice(true);
    choiceNotice = 'Сохранённая попытка устарела или повреждена. Начата новая попытка.';
    return null;
  }
  if (saved.version !== 2 || saved.signature !== sessionSignature()
    || !permutation(saved.order, ids) || !Number.isInteger(saved.position)
    || saved.position < 0 || saved.position >= ids.length
    || !Array.isArray(saved.options) || saved.options.length !== ids.length
    || !saved.options.every((order) => permutation(order, optionIds))
    || !saved.answers || typeof saved.answers !== 'object' || Array.isArray(saved.answers)
    || !permutation(Object.keys(saved.answers), ids)
    || !Object.values(saved.answers).every((answer) => answer === null || optionIds.includes(answer))
    || (mode === 'listening' && (!saved.unlocked || !permutation(Object.keys(saved.unlocked), ids)
      || !Object.values(saved.unlocked).every((value) => typeof value === 'boolean')))) {
    saveChoice(true);
    choiceNotice = 'Сохранённая попытка устарела или повреждена. Начата новая попытка.';
    return null;
  }
  return saved;
}
function nextExercise() {
  if (!choiceReady(selectedBlock())) return null;
  return ({ choice: 'listening', listening: 'speaking' })[mode] || null;
}
function choiceView(view) {
  for (const id of ['card', 'card-progress', 'progress']) byId(id).hidden = view !== 'card';
  document.querySelector('#trainer .navigation').hidden = view !== 'card';
  byId('choice-resume').hidden = view !== 'resume';
  byId('choice-complete').hidden = view !== 'complete';
  byId('back-to-stages').hidden = view !== 'resume';
  byId('study-title').hidden = view === 'complete';
  if (view === 'complete') {
    const name = { choice: 'Выбери ответ', listening: 'Аудирование', speaking: 'Говорение' }[mode];
    byId('choice-complete-title').textContent = `${name} — упражнение завершено`;
    byId('choice-complete-description').textContent = `Все ${cards.length} вопросов упражнения пройдены.`;
    const next = nextExercise();
    byId('next-exercise').hidden = !next;
    byId('next-exercise').textContent = next === 'listening' ? 'Далее: Аудирование →' : 'Далее: Говорение →';
    byId('choice-to-stages').classList.toggle('primary', !next);
  }
  storageNotice();
}
function startChoice() {
  if (mode === 'speaking') {
    choiceSession = { version: 1, attemptId: newAttemptId(), signature: sessionSignature(), order: shuffle(selectedBlock().card_ids), position: 0 };
    saveChoice();
    showChoiceCard();
    return;
  }
  choiceSession = { version: 2, attemptId: newAttemptId(), signature: sessionSignature(), order: shuffle(selectedBlock().card_ids),
    options: selectedBlock().card_ids.map(() => shuffle(optionIds)), position: 0, answers: Object.fromEntries(selectedBlock().card_ids.map((id) => [id, null])) };
  if (mode === 'listening') choiceSession.unlocked = Object.fromEntries(selectedBlock().card_ids.map((id) => [id, false]));
  saveChoice();
  showChoiceCard();
}
function showChoiceCard() {
  cards = choiceSession.order.map((id) => availableCards.get(id));
  index = choiceSession.position;
  choiceView('card');
  renderCard(true);
}
function currentChoice() {
  return choiceSession.answers[choiceSession.order[choiceSession.position]];
}
function renderChoiceOptions() {
  const container = byId('choice-options');
  container.replaceChildren();
  const entry = answerOptions.get(cards[index].id);
  const texts = { correct: entry.short_answer_ro, wrong_1: entry.wrong_answers_ro[0], wrong_2: entry.wrong_answers_ro[1] };
  const selected = currentChoice();
  for (const id of choiceSession.options[index]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.lang = 'ro';
    button.dataset.optionId = id;
    button.textContent = texts[id];
    button.disabled = selected !== null;
    if (selected !== null && id === 'correct') {
      button.classList.add('choice-correct');
      button.setAttribute('aria-label', `${texts[id]} — правильный ответ`);
    } else if (selected === id) {
      button.classList.add('choice-wrong');
      button.setAttribute('aria-label', `${texts[id]} — выбранный неверный ответ`);
    }
    container.append(button);
  }
  byId('choice-result').textContent = selected === null ? '' : selected === 'correct' ? 'Верно' : 'Неверно. Правильный ответ отмечен.';
  // Only normalize Unicode and whitespace; punctuation and wording remain significant.
  const normalizeAnswer = (text) => text.normalize('NFC').replace(/\s+/gu, ' ').trim();
  document.querySelector('[data-toggle="answer-ro"]').hidden = selected === null
    || normalizeAnswer(entry.short_answer_ro) === normalizeAnswer(cards[index].source_answer);
  byId('next').disabled = selected === null;
  byId('choice-area').hidden = mode === 'listening' && !listeningUnlocked();
}
byId('choice-options').addEventListener('click', (event) => {
  const button = event.target.closest('[data-option-id]');
  if (!['choice', 'listening'].includes(mode) || (mode === 'listening' && !listeningUnlocked()) || !button || button.disabled || !choiceSession || currentChoice() !== null) return;
  choiceSession.answers[cards[index].id] = button.dataset.optionId;
  saveChoice();
  renderChoiceOptions();
  byId('next').focus();
});
byId('continue-choice').addEventListener('click', showChoiceCard);
byId('restart-choice').addEventListener('click', startChoice);
byId('retry-choice').addEventListener('click', startChoice);
byId('next-exercise').addEventListener('click', () => {
  const next = nextExercise();
  navigate(next ? `${next}/${selectedChapterId}/${selectedBlockId}` : `stages/${selectedChapterId}/${selectedBlockId}`);
});
byId('choice-to-stages').addEventListener('click', () => navigate(`stages/${selectedChapterId}/${selectedBlockId}`));
byId('open-choice').addEventListener('click', () => navigate(`choice/${selectedChapterId}/${selectedBlockId}`));
byId('open-speaking').addEventListener('click', () => navigate(`speaking/${selectedChapterId}/${selectedBlockId}`));
byId('open-listening').addEventListener('click', () => navigate(`listening/${selectedChapterId}/${selectedBlockId}`));

// Recognition is ephemeral: only the card order and position enter the saved session.
let activeRecognition = null;
let recognitionTimer = null;
let recognitionStopReason = '';
let recognitionError = '';
const recognitionAPI = () => window.SpeechRecognition || window.webkitSpeechRecognition;
const normalizeAnswer = (text) => text.normalize('NFC').replace(/\s+/gu, ' ').trim();
function speakingFullAnswer() {
  return normalizeAnswer(answerOptions.get(cards[index].id).short_answer_ro) !== normalizeAnswer(cards[index].source_answer);
}
const speakingHelp = byId('speaking-help');
const speakingHelpToggle = speakingHelp.querySelector('summary');
function setSpeakingHelpOpen(open) {
  speakingHelp.open = open;
  speakingHelpToggle.setAttribute('aria-expanded', String(open));
}
speakingHelpToggle.addEventListener('click', (event) => {
  event.preventDefault();
  setSpeakingHelpOpen(!speakingHelp.open);
});
speakingHelp.addEventListener('toggle', () => {
  speakingHelpToggle.setAttribute('aria-expanded', String(speakingHelp.open));
});
document.addEventListener('click', (event) => {
  if (speakingHelp.open && !speakingHelp.contains(event.target)) setSpeakingHelpOpen(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !speakingHelp.open) return;
  event.preventDefault();
  setSpeakingHelpOpen(false);
  if (speakingHelp.contains(document.activeElement)) speakingHelpToggle.focus();
});
function renderSpeaking() {
  setSpeakingHelpOpen(false);
  byId('speaking-status').classList.remove('sr-only');
  byId('choice-area').hidden = true;
  byId('next').disabled = false;
  byId('spoken-area').hidden = true;
  byId('spoken-text').textContent = '';
  byId('speaking-interim').textContent = '';
  byId('copy-status').textContent = '';
  byId('copy-spoken').disabled = true;
  byId('speaking-answer').hidden = true;
  byId('speaking-answer-text').textContent = answerOptions.get(cards[index].id).short_answer_ro;
  const translation = answerOptions.get(cards[index].id).short_answer_ru;
  byId('speaking-answer-ru-text').textContent = nonempty(translation) ? translation : '';
  const translationButton = document.querySelector('[data-toggle="speaking-answer-ru"]');
  translationButton.hidden = !nonempty(translation);
  byId('speaking-answer-ru').hidden = true;
  updateRevealButton(translationButton, false);
  byId('show-speaking-answer').setAttribute('aria-expanded', 'false');
  byId('show-speaking-answer').textContent = 'Показать правильный ответ';
  document.querySelector('[data-toggle="answer-ro"]').hidden = true;
  byId('start-speaking').disabled = !recognitionAPI() || !window.isSecureContext;
  byId('stop-speaking').disabled = true;
  byId('speaking-status').textContent = byId('start-speaking').disabled
    ? 'Микрофон недоступен для распознавания в этом браузере. Можно ответить самостоятельно и посмотреть правильный ответ.'
    : '';
}
function stopRecognition(discard = false, reason = 'manual') {
  clearTimeout(recognitionTimer);
  recognitionTimer = null;
  const current = activeRecognition;
  if (!current) return;
  if (discard) {
    // Ignore late events from a card that is no longer visible.
    activeRecognition = null;
    try { current.abort(); } catch { /* Already ended. */ }
    return;
  }
  if (recognitionStopReason) return;
  recognitionStopReason = reason;
  byId('stop-speaking').disabled = true;
  byId('speaking-status').textContent = reason === 'limit'
    ? 'Достигнут лимит 120 секунд. Остановка…' : 'Остановка…';
  try { current.stop(); }
  catch {
    try { current.abort(); } catch { /* The browser may have already ended. */ }
    current.onend();
  }
}
byId('show-speaking-answer').addEventListener('click', () => {
  const visible = byId('speaking-answer').hidden;
  byId('speaking-answer').hidden = !visible;
  byId('show-speaking-answer').setAttribute('aria-expanded', String(visible));
  byId('show-speaking-answer').textContent = visible ? 'Скрыть правильный ответ' : 'Показать правильный ответ';
  document.querySelector('[data-toggle="answer-ro"]').hidden = !visible || !speakingFullAnswer();
  if (!visible) {
    byId('speaking-answer-ru').hidden = true;
    updateRevealButton(document.querySelector('[data-toggle="speaking-answer-ru"]'), false);
    byId('answer-ro').hidden = true;
    updateRevealButton(document.querySelector('[data-toggle="answer-ro"]'), false);
    stopSpeech();
  }
});
byId('copy-spoken').addEventListener('click', async () => {
  const text = byId('spoken-text').textContent;
  const cardId = cards[index]?.id;
  const session = choiceSession;
  let message;
  try {
    await navigator.clipboard.writeText(text);
    message = 'Текст скопирован.';
  } catch { message = 'Не удалось скопировать. Выделите текст и скопируйте вручную.'; }
  if (mode === 'speaking' && cards[index]?.id === cardId && choiceSession === session
    && byId('spoken-text').textContent === text) byId('copy-status').textContent = message;
});
byId('stop-speaking').addEventListener('click', () => stopRecognition());
byId('start-speaking').addEventListener('click', () => {
  if (mode !== 'speaking' || activeRecognition || !recognitionAPI()) return;
  stopSpeech();
  setAudioStatus();
  byId('spoken-text').textContent = '';
  byId('spoken-area').hidden = true;
  byId('speaking-interim').textContent = '';
  byId('copy-status').textContent = '';
  byId('copy-spoken').disabled = true;
  recognitionStopReason = '';
  recognitionError = '';
  byId('speaking-status').classList.remove('sr-only');
  let current;
  try {
    current = new (recognitionAPI())();
    activeRecognition = current;
    current.lang = 'ro-RO';
    current.continuous = true;
    current.interimResults = true;
    current.maxAlternatives = 1;
    byId('start-speaking').disabled = true;
    byId('stop-speaking').disabled = false;
    byId('speaking-status').textContent = 'Запуск… Разрешите микрофон для распознавания речи.';
    current.onstart = () => {
      if (activeRecognition !== current) return;
      if (recognitionStopReason) { current.stop(); return; }
      byId('speaking-status').textContent = 'Запись · до 120 секунд. Говорите по-румынски.';
    };
    current.onresult = (event) => {
      if (activeRecognition !== current) return;
      const final = [], interim = [];
      // The event contains the entire session; do not append previously final results again.
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        (result.isFinal ? final : interim).push(result[0].transcript);
      }
      byId('spoken-text').textContent = final.join(' ');
      byId('spoken-area').hidden = !final.length;
      byId('copy-spoken').disabled = !final.length;
      byId('speaking-interim').textContent = interim.join(' ');
    };
    current.onnomatch = () => {
      if (activeRecognition === current) byId('speaking-status').textContent = 'Не удалось распознать фразу. Можно остановить запись и попробовать снова.';
    };
    current.onerror = (event) => {
      if (activeRecognition !== current) return;
      const messages = {
        'not-allowed': 'Микрофон недоступен: доступ запрещён. Разрешите его в настройках сайта или отвечайте самостоятельно.',
        'service-not-allowed': 'Сервис распознавания запрещён браузером. Можно отвечать самостоятельно.',
        'audio-capture': 'Микрофон недоступен. Проверьте его подключение.',
        'no-speech': 'Речь не обнаружена. Попробуйте снова.',
        'network': 'Ошибка сети или сервиса распознавания. Попробуйте снова.',
        'language-not-supported': 'Сервис браузера не поддерживает румынский язык.',
        'aborted': 'Распознавание прервано. Можно повторить попытку.'
      };
      recognitionError = messages[event.error] || `Ошибка распознавания (${event.error}). Можно повторить попытку.`;
      byId('speaking-status').textContent = recognitionError;
    };
    current.onend = () => {
      if (activeRecognition !== current) return;
      clearTimeout(recognitionTimer);
      recognitionTimer = null;
      activeRecognition = null;
      byId('start-speaking').disabled = false;
      byId('stop-speaking').disabled = true;
      byId('speaking-interim').textContent = '';
      byId('spoken-area').hidden = false;
      // Keep the manual-stop announcement available to screen readers without a persistent visual notice.
      byId('speaking-status').classList.toggle('sr-only', !recognitionError && recognitionStopReason === 'manual');
      byId('speaking-status').textContent = recognitionError || (recognitionStopReason === 'limit'
        ? 'Остановлено: достигнут лимит 120 секунд. Можно повторить попытку.'
        : recognitionStopReason ? 'Остановлено. Можно повторить попытку.'
        : 'Остановлено: браузер завершил распознавание. Можно повторить попытку.');
    };
    // Bound the entire activation, including time spent starting the service.
    recognitionTimer = setTimeout(() => stopRecognition(false, 'limit'), 120000);
    current.start();
  } catch {
    stopRecognition(true);
    byId('start-speaking').disabled = false;
    byId('stop-speaking').disabled = true;
    byId('speaking-status').textContent = 'Микрофон недоступен: не удалось запустить распознавание. Можно повторить попытку или отвечать самостоятельно.';
  }
});

function listeningUnlocked() {
  return currentChoice() !== null || choiceSession.unlocked[cards[index].id];
}
function revealListeningQuestion(visible) {
  byId('question-content').hidden = !visible;
  byId('question').hidden = !visible;
  document.querySelector('[data-toggle="question-ru"]').hidden = !visible;
  byId('show-listening-question').textContent = visible ? 'Скрыть текст' : 'Показать текст';
  byId('show-listening-question').setAttribute('aria-expanded', String(visible));
  if (visible) {
    byId('card').setAttribute('aria-labelledby', 'question');
    byId('card').removeAttribute('aria-label');
  } else {
    byId('card').removeAttribute('aria-labelledby');
    byId('card').setAttribute('aria-label', 'Прослушайте вопрос на румынском языке');
    byId('question-ru').hidden = true;
    updateRevealButton(document.querySelector('[data-toggle="question-ru"]'), false);
  }
}
function unlockListening() {
  choiceSession.unlocked[cards[index].id] = true;
  saveChoice();
  renderChoiceOptions();
  byId('listening-status').textContent = '';
  byId('listening-status').hidden = true;
  byId('listening-text-fallback').hidden = true;
}
byId('show-listening-question').addEventListener('click', () => revealListeningQuestion(byId('question').hidden));
byId('listening-text-fallback').addEventListener('click', () => {
  if (mode !== 'listening' || !choiceSession) return;
  stopSpeech();
  setAudioStatus();
  revealListeningQuestion(true);
  unlockListening();
});

// These callbacks belong to one question and one attempt; audio also guards its generation.
function listeningAudioCallbacks(button) {
  if (mode !== 'listening' || button?.dataset.speak !== 'question') return {};
  const session = choiceSession;
  const cardId = cards[index].id;
  const current = () => mode === 'listening' && choiceSession === session && cards[index]?.id === cardId;
  return {
    ended: () => { if (current()) unlockListening(); },
    blocked: () => {
      if (current() && !listeningUnlocked()) {
        byId('listening-status').hidden = false;
        byId('listening-status').textContent = 'Нажмите кнопку воспроизведения, чтобы прослушать вопрос. Варианты появятся после окончания записи.';
      }
    },
    unavailable: () => {
      if (!current() || listeningUnlocked()) return;
      byId('listening-status').hidden = false;
      byId('listening-status').textContent = 'Звук недоступен или загрузка задерживается. Попробуйте ещё раз или перейдите к тексту вопроса и вариантам.';
      byId('listening-text-fallback').hidden = false;
    },
  };
}

function renderBlockList(chapter, list) {
  for (const [blockIndex, block] of chapter.blocks.entries()) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.blockId = block.id;
    button.textContent = `Блок ${blockIndex + 1}`;
    button.disabled = !blockReady(block);
    const readyCount = block.card_ids.filter((id) => availableCards.has(id)).length;
    if (readyCount > 0 && readyCount < block.card_ids.length) {
      const status = document.createElement('small');
      status.textContent = ` · Готово ${readyCount} из ${block.card_ids.length}`;
      button.append(status);
    }
    item.append(button);
    if (button.disabled) {
      const lock = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      lock.setAttribute('class', 'block-lock');
      lock.setAttribute('viewBox', '0 0 24 24');
      lock.setAttribute('fill', 'none');
      lock.setAttribute('stroke', 'currentColor');
      lock.setAttribute('stroke-width', '1.8');
      lock.setAttribute('stroke-linecap', 'round');
      lock.setAttribute('stroke-linejoin', 'round');
      lock.setAttribute('focusable', 'false');
      lock.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M8 10V7a4 4 0 0 1 8 0v3M5 10h14v11H5zM12 14v3');
      lock.append(path);
      button.append(lock);
      const status = document.createElement('small');
      status.className = 'block-availability';
      status.textContent = 'Материалы готовятся';
      button.append(status);
      button.setAttribute('aria-label', `Блок ${blockIndex + 1} — Материалы готовятся`);
    }
    if (blockProgress(block.id) === 4) {
      const check = document.createElement('span');
      check.className = 'block-complete';
      check.textContent = '✓';
      check.setAttribute('aria-hidden', 'true');
      button.append(check);
      button.setAttribute('aria-label', `Блок ${blockIndex + 1} — все четыре упражнения завершены`);
    }
    list.append(item);
  }
}
function renderChapters(moveFocus = false, openChapterId = null) {
  const list = byId('chapter-list');
  list.replaceChildren();
  for (const chapter of chapters) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.chapterId = chapter.id;
    button.lang = 'ro';
    button.setAttribute('aria-label', chapter.title);
    const open = chapter.id === openChapterId;
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-controls', `chapter-panel-${chapter.id}`);
    const parts = chapter.title.match(/^CAPITOLUL\s+([IVXLCDM]+)\s*[-–—]\s*(.+)$/);
    const number = document.createElement('span');
    number.className = 'chapter-number';
    number.setAttribute('aria-hidden', 'true');
    number.textContent = parts ? parts[1] : '';
    const name = document.createElement('span');
    name.className = 'chapter-name';
    name.textContent = parts ? parts[2] : chapter.title;
    const arrow = document.createElement('span');
    arrow.className = 'chapter-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = open ? '⌄' : '›';
    button.append(number, name, arrow);
    const panel = document.createElement('div');
    panel.id = `chapter-panel-${chapter.id}`;
    panel.hidden = !open;
    if (open) {
      const blocks = document.createElement('ul');
      blocks.className = 'block-list';
      blocks.id = 'block-list';
      blocks.dataset.blockChapter = chapter.id;
      blocks.setAttribute('aria-label', `Блоки: ${chapter.title}`);
      renderBlockList(chapter, blocks);
      panel.append(blocks);
    }
    item.append(button, panel);
    list.append(item);
  }
  showScreen('chapters-screen');
  if (moveFocus) {
    const heading = openChapterId ? document.querySelector(`button[data-chapter-id="${openChapterId}"]`) : byId('chapters-title');
    heading.focus();
  }
}
function renderBlocks() {
  renderChapters(true, selectedChapterId);
}

// Small hash routes keep browser Back/Forward native, without a router.
function navigate(route, replace = false) {
  if (replace) {
    history.replaceState({ route, parent: history.state?.route === route ? history.state.parent : null }, '', `#${route}`);
  } else if (location.hash !== `#${route}`) {
    history.pushState({ route, parent: location.hash.slice(1) }, '', `#${route}`);
  }
  renderRoute();
}

function renderRoute() {
  if (byId('restore-dialog').open) cancelRestore();
  stopRecognition(true);
  if (!chapters.length) return;
  loadProgress();
  const [screen, chapterId, blockId, extra] = location.hash.slice(1).split('/');
  const chapter = chapters.find((entry) => entry.id === chapterId);
  if (screen === 'chapters' && !chapterId) {
    renderChapters(!initialRender);
    return;
  }
  if (chapter && !extra) {
    selectedChapterId = chapter.id;
    if (screen === 'chapter' && !blockId) {
      renderBlocks();
      return;
    }
    const blockIndex = chapter.blocks.findIndex((entry) => entry.id === blockId);
    const block = chapter.blocks[blockIndex];
    if ((screen === 'stages' || screen === 'study' || screen === 'choice' || screen === 'listening' || screen === 'speaking') && block && blockReady(block)) {
      selectedBlockId = block.id;
      if (screen === 'stages') {
        byId('stages-chapter').textContent = chapter.title;
        byId('stages-title').textContent = `Блок ${blockIndex + 1} · Этапы обучения`;
        byId('open-choice').disabled = !choiceReady(block);
        byId('choice-stage-status').textContent = choiceReady(block) ? '›'
          : optionsUnavailable ? 'Варианты недоступны' : 'Материалы готовятся';
        byId('open-listening').disabled = !choiceReady(block);
        byId('listening-stage-status').textContent = byId('choice-stage-status').textContent;
        byId('open-speaking').disabled = !choiceReady(block);
        byId('speaking-stage-status').textContent = byId('choice-stage-status').textContent;
        renderStageProgress();
        showScreen('stages-screen', 'stages-title');
        return;
      }
      mode = screen;
      choiceNotice = '';
      if (mode === 'choice' || mode === 'listening' || mode === 'speaking') {
        if (!choiceReady(block)) { navigate(`stages/${chapter.id}/${block.id}`, true); return; }
        byId('study-title').textContent = `Блок ${blockIndex + 1} · ${mode === 'speaking' ? 'Говорение' : mode === 'listening' ? 'Аудирование' : 'Выбери ответ'}`;
        showScreen('trainer');
        choiceSession = readChoice();
        if (choiceSession) {
          if (!nonempty(choiceSession.attemptId) || choiceSession.attemptId.length > 200) { choiceSession.attemptId = newAttemptId(); saveChoice(); }
          byId('choice-resume-title').textContent = 'Продолжить упражнение?';
          choiceView('resume');
          byId('choice-resume-title').focus();
        } else startChoice();
        return;
      }
      choiceView('card');
      cards = block.card_ids.filter((id) => availableCards.has(id)).map((id) => availableCards.get(id));
      index = 0;
      studyAttempt = { id: newAttemptId(), visited: new Set() };
      byId('study-title').textContent = `Блок ${blockIndex + 1}`;
      showScreen('trainer');
      renderCard(true);
      return;
    }
    // A direct link must not bypass material readiness.
    navigate(`chapter/${chapter.id}`, true);
    return;
  }
  navigate('chapters', true);
}

function backTo(route) {
  stopRecognition(true);
  stopSpeech();
  if (history.state?.parent === route) history.back();
  else navigate(route);
}

window.addEventListener('popstate', renderRoute);

byId('chapter-list').addEventListener('click', (event) => {
  const blockButton = event.target.closest('button[data-block-id]');
  if (blockButton && !blockButton.disabled) {
    const chapterId = blockButton.closest('[data-block-chapter]').dataset.blockChapter;
    const block = chapters.find(chapter => chapter.id === chapterId)?.blocks.find(block => block.id === blockButton.dataset.blockId);
    if (blockReady(block)) navigate(`stages/${chapterId}/${block.id}`);
    return;
  }
  const button = event.target.closest('button[data-chapter-id]');
  if (button) navigate(button.getAttribute('aria-expanded') === 'true' ? 'chapters' : `chapter/${button.dataset.chapterId}`);
});

byId('open-study').addEventListener('click', () => navigate(`study/${selectedChapterId}/${selectedBlockId}`));
byId('back-to-stages').addEventListener('click', () => backTo(`stages/${selectedChapterId}/${selectedBlockId}`));

byId('back-to-blocks').addEventListener('click', () => backTo(`chapter/${selectedChapterId}`));

function updateAudioButton(button, playing) {
  if (!button) return;
  const context = button.dataset.speechText !== undefined
    ? `на румынском: ${button.dataset.speechText}`
    : `${button.dataset.speak === 'question' ? 'вопрос' : 'ответ'} на румынском`;
  const label = `${playing ? 'Остановить' : 'Воспроизвести'} ${context}`;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-pressed', String(playing));
  button.title = label;
  if (button.dataset.speak === 'question' && (mode === 'listening' || mode === 'speaking')) {
    if (playing) button.dataset.listened = 'true';
    byId('question-play-label').textContent = playing ? 'Остановить' : button.dataset.listened === 'true' ? 'Прослушать ещё раз' : 'Прослушать вопрос';
  }
  button.querySelector('[role="tooltip"]').textContent = label;
  const svg = button.querySelector('svg');
  svg.dataset.icon = playing ? 'volume-x' : 'volume-2';
  const speaker = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  speaker.setAttribute('d', 'M11 5 6 9H3v6h3l5 4V5Z');
  const sound = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  sound.setAttribute('d', playing ? 'm16 9 6 6m0-6-6 6' : 'M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14');
  svg.replaceChildren(speaker, sound);
}

function stopSpeech() {
  speechGeneration += 1;
  updateAudioButton(activeAudioButton, false);
  activeAudioButton = null;
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
  if (speechSupported) synth.cancel();
}

function romanianVoice() {
  return synth.getVoices().find((voice) => /^ro[-_]RO$/i.test(voice.lang))
    || synth.getVoices().find((voice) => /^ro(?:[-_]|$)/i.test(voice.lang));
}

function setAudioStatus(message = '') {
  byId('audio-status').textContent = message;
  byId('audio-status').hidden = !message;
}

function updateRevealButton(button, expanded) {
  button.setAttribute('aria-expanded', String(expanded));
  const target = button.dataset.toggle;
  if (target === 'answer-ro' && mode === 'speaking') {
    const icon = document.createElement('span');
    icon.className = 'disclosure-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '▸';
    button.replaceChildren(icon, document.createTextNode('Полный ответ и пояснения'));
    return;
  }
  const name = target === 'answer-ro' && mode !== 'study' ? 'полный ответ' : labels[target];
  const label = `${expanded ? 'Скрыть' : 'Показать'} ${name}`;
  if (button.classList.contains('translation-toggle')) {
    button.setAttribute('aria-label', label);
    button.title = label;
    button.querySelector('[role="tooltip"]').textContent = label;
  } else if (target !== 'vocabulary') {
    button.textContent = label;
  }
}

// PDF's private-use Wingdings bullet has no portable browser glyph.
// Change only this verified marker and its adjacent horizontal spacing for display.
export function formatFullAnswer(text) {
  return text.replace(/[ \t]*\uF0A7[ \t]*/gu, '\n• ');
}

function renderCard(moveFocus = false) {
  stopRecognition(true);
  stopSpeech();
  const fullAnswerToggle = document.querySelector('[data-toggle="answer-ro"]');
  fullAnswerToggle.classList.toggle('speaking-full-toggle', mode === 'speaking');
  fullAnswerToggle.classList.toggle('primary', mode !== 'speaking');
  fullAnswerToggle.parentElement.classList.toggle('speaking-full-area', mode === 'speaking');
  const card = cards[index];
  if (mode === 'study') studyAttempt?.visited.add(card.id);
  byId('topic').textContent = nonempty(card.topic) ? card.topic : 'Întrebări de studiu';
  byId('question').textContent = card.question;
  byId('question-ru-text').textContent = card.question_ru;
  byId('answer-ro-text').textContent = formatFullAnswer(card.source_answer);
  byId('answer-ru-text').textContent = card.answer_ru;
  const vocabulary = byId('vocabulary-list');
  vocabulary.replaceChildren();
  for (const [wordIndex, word] of (mode === 'study' ? card.vocabulary : []).entries()) {
    const ro = document.createElement('dt');
    ro.lang = 'ro';
    const term = document.createElement('span');
    term.textContent = word.ro;
    const speaker = document.createElement('button');
    speaker.type = 'button';
    speaker.className = 'audio vocabulary-audio';
    speaker.dataset.speechText = word.ro;
    speaker.dataset.audioPart = `vocab_${String(wordIndex + 1).padStart(2, '0')}`;
    const label = `Прослушать на румынском: ${word.ro}`;
    speaker.setAttribute('aria-label', label);
    speaker.title = label;
    speaker.append(document.querySelector('[data-speak="question"] svg').cloneNode(true));
    const tooltip = document.createElement('span');
    tooltip.className = 'audio-tooltip';
    tooltip.id = `vocabulary-audio-tip-${vocabulary.children.length}`;
    tooltip.setAttribute('role', 'tooltip');
    tooltip.textContent = label;
    speaker.setAttribute('aria-describedby', tooltip.id);
    speaker.append(tooltip);
    ro.append(term, speaker);
    const ru = document.createElement('dd');
    ru.lang = 'ru';
    ru.textContent = word.ru;
    vocabulary.append(ro, ru);
  }
  if (!card.vocabulary.length) {
    const message = document.createElement('dd');
    message.textContent = 'Словарь для этой карточки пока недоступен.';
    vocabulary.append(message);
  }
  for (const button of toggles) {
    const target = button.dataset.toggle;
    byId(target).hidden = true;
    updateRevealButton(button, false);
  }
  byId('position').textContent = `${index + 1} / ${cards.length}`;
  byId('progress').max = cards.length;
  byId('progress').value = index + 1;
  byId('previous').disabled = false;
  byId('previous').textContent = index === 0 ? '← К этапам' : '← Назад';
  const toChoice = mode === 'study' && index === cards.length - 1 && choiceReady(selectedBlock());
  byId('next').disabled = false;
  byId('next').textContent = toChoice ? 'Далее: Выбери ответ →' : index === cards.length - 1
    ? mode === 'study' ? 'К этапам обучения' : 'Завершить' : 'Далее →';
  byId('previous').hidden = false;
  document.querySelector('#trainer .navigation span').hidden = mode !== 'study';
  document.querySelector('.vocabulary-area').hidden = mode !== 'study';
  byId('choice-area').hidden = mode === 'study';
  document.querySelector('[data-toggle="answer-ro"]').hidden = false;
  if (mode === 'choice' || mode === 'listening') renderChoiceOptions();
  byId('speaking-area').hidden = mode !== 'speaking';
  if (mode === 'speaking') renderSpeaking();
  const questionSpeaker = document.querySelector('[data-speak="question"]');
  const listening = mode === 'listening' || mode === 'speaking';
  if (listening) {
    byId('listening-actions').prepend(questionSpeaker);
    byId('listening-question-slot').append(byId('question-content'));
  } else {
    document.querySelector('.question-heading').append(questionSpeaker);
    byId('standard-question-slot').append(byId('question-content'));
    byId('question-content').hidden = false;
  }
  questionSpeaker.classList.toggle('listening-play', listening);
  questionSpeaker.classList.toggle('primary', listening);
  delete questionSpeaker.dataset.listened;
  byId('question-play-label').hidden = !listening;
  byId('listening-answer-heading').hidden = !listening;
  document.querySelector('#card > .language-label').hidden = listening;
  byId('listening-controls').hidden = !listening;
  byId('listening-text-fallback').hidden = true;
  if (mode === 'listening') {
    revealListeningQuestion(false);
    byId('listening-status').textContent = listeningUnlocked()
      ? ''
      : 'Варианты появятся после окончания записи.';
    byId('listening-status').hidden = listeningUnlocked();
  } else if (mode === 'speaking') {
    revealListeningQuestion(false);
    byId('listening-status').hidden = true;
    byId('listening-answer-heading').hidden = true;
  } else {
    byId('question').hidden = false;
    document.querySelector('[data-toggle="question-ru"]').hidden = false;
    byId('card').setAttribute('aria-labelledby', 'question');
    byId('card').removeAttribute('aria-label');
  }
  setAudioStatus();
  if (moveFocus) {
    byId('card').focus({ preventScroll: true });
    byId('card').scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  for (const button of document.querySelectorAll('[data-speak], [data-speech-text]')) updateAudioButton(button, false);
  playMp3(`audio/${encodeURIComponent(card.id)}_question.mp3`, card.question, true, document.querySelector('[data-speak="question"]'), listeningAudioCallbacks(document.querySelector('[data-speak="question"]')));
}

for (const button of toggles) {
  button.addEventListener('click', () => {
    const target = button.dataset.toggle;
    const section = byId(target);
    section.hidden = !section.hidden;
    updateRevealButton(button, !section.hidden);
    if (target === 'answer-ro') {
      if (section.hidden) {
        stopSpeech();
        setAudioStatus();
      }
    }
  });
}

for (const [id, delta] of [['previous', -1], ['next', 1]]) {
  byId(id).addEventListener('click', () => {
    if (delta === -1 && index === 0) {
      backTo(`stages/${selectedChapterId}/${selectedBlockId}`);
      return;
    }
    if (mode === 'choice' || mode === 'listening' || mode === 'speaking') {
      if (!choiceSession || (delta === 1 && mode !== 'speaking' && currentChoice() === null)
        || (delta === -1 && index === 0)) return;
      if (delta === 1 && index === cards.length - 1) {
        stopRecognition(true);
        stopSpeech();
        recordCompletion(mode, choiceSession.attemptId);
        saveChoice(true);
        choiceSession = null;
        choiceView('complete');
        byId('choice-complete-title').focus();
      } else {
        choiceSession.position += delta;
        saveChoice();
        showChoiceCard();
      }
      return;
    }
    if (delta === 1 && index === cards.length - 1) {
      recordCompletion('study', studyAttempt?.id);
      navigate(`${choiceReady(selectedBlock()) ? 'choice' : 'stages'}/${selectedChapterId}/${selectedBlockId}`);
      return;
    }
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= cards.length) return;
    index = nextIndex;
    renderCard(true);
  });
}

// Optional fallback when a local MP3 cannot be played.
function speakRomanian(text, button = null, callbacks = {}) {
  stopSpeech();
  const voice = speechSupported && romanianVoice();
  if (!voice) {
    callbacks.unavailable?.();
    setAudioStatus();
    return;
  }
  setAudioStatus();
  const generation = speechGeneration;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ro-RO';
  utterance.voice = voice;
  utterance.rate = 0.9;
  activeAudioButton = button;
  utterance.onstart = () => {
    if (generation === speechGeneration) updateAudioButton(button, true);
  };
  utterance.onend = () => {
    if (generation === speechGeneration) { stopSpeech(); setAudioStatus(); callbacks.ended?.(); }
  };
  utterance.onerror = () => {
    if (generation === speechGeneration) {
      stopSpeech();
      callbacks.unavailable?.();
      setAudioStatus('Не удалось воспроизвести речь. Проверьте румынский голос в настройках системы и попробуйте снова.');
    }
  };
  try { synth.speak(utterance); } catch { utterance.onerror(); }
}

async function playMp3(path, text, automatic = false, button = null, callbacks = {}) {
  stopSpeech();
  setAudioStatus();
  const generation = speechGeneration;
  const audio = new Audio(path);
  currentAudio = audio;
  activeAudioButton = button;
  let failed = false;
  const showError = () => {
    if (generation !== speechGeneration || failed) return;
    failed = true;
    const message = `Не удалось загрузить или воспроизвести MP3 (${path}).`;
    if (speechSupported && romanianVoice()) {
      speakRomanian(text, button, callbacks);
      setAudioStatus(`${message} Используется встроенная румынская озвучка.`);
    } else {
      stopSpeech();
      setAudioStatus(`${message} Проверьте наличие файла и попробуйте снова.`);
      callbacks.unavailable?.();
    }
  };
  const showPlaying = () => {
    if (generation !== speechGeneration || failed) return;
    activeAudioButton = button;
    updateAudioButton(button, true);
  };
  audio.addEventListener('playing', showPlaying);
  audio.addEventListener('pause', () => {
    if (generation !== speechGeneration) return;
    updateAudioButton(button, false);
    activeAudioButton = null;
  });
  audio.addEventListener('ended', () => {
    if (generation === speechGeneration && !failed) { stopSpeech(); callbacks.ended?.(); }
  });
  audio.addEventListener('stalled', () => {
    if (generation === speechGeneration && !failed) callbacks.unavailable?.();
  });
  audio.addEventListener('error', showError);
  try {
    await audio.play();
    showPlaying();
  } catch (error) {
    if (automatic && error.name === 'NotAllowedError') {
      failed = true;
      if (generation === speechGeneration) { stopSpeech(); callbacks.blocked?.(); }
      return;
    }
    showError();
  }
}

byId('card').addEventListener('click', (event) => {
  const button = event.target.closest('[data-speak], [data-speech-text]');
  if (!button || button.disabled) return;
  if (button === activeAudioButton) {
    stopSpeech();
    setAudioStatus();
    return;
  }
  stopRecognition();
  const card = cards[index];
  const part = button.dataset.audioPart
    ?? (button.dataset.speak === 'question' ? 'question' : 'answer');
  const text = button.dataset.speechText ?? card[button.dataset.speak];
  playMp3(`audio/${encodeURIComponent(card.id)}_${part}.mp3`, text, false, button, listeningAudioCallbacks(button));
});
window.addEventListener('pagehide', () => { stopRecognition(true); stopSpeech(); });

async function loadJson(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(`Не удалось загрузить ${path} (HTTP ${response.status}).`);
  return response.json();
}

async function initialize() {
  try {
    optionsUnavailable = false;
    const [originals, translations, structure, options] = await Promise.all([
      loadJson('../data/processed/qa_cards.json'),
      loadJson('../data/processed/qa_translations.json'),
      loadJson('../data/processed/learning_blocks.json'),
      // Review data can change independently of the app; revalidate cached responses.
      loadJson('../data/processed/qa_answer_options.json', { cache: 'no-cache' })
        .catch(() => { optionsUnavailable = true; return []; }),
    ]);
    availableCards = new Map(joinCards(originals, translations).map((card) => [card.id, card]));
    if (!Array.isArray(structure.chapters) || !structure.chapters.length) {
      throw new Error('Нет учебных глав в learning_blocks.json.');
    }
    answerOptions = new Map();
    if (Array.isArray(options)) {
      const seen = new Set();
      for (const entry of options) {
        if (!entry || !nonempty(entry.card_id)) continue;
        if (seen.has(entry.card_id)) { answerOptions.delete(entry.card_id); continue; }
        seen.add(entry.card_id);
        const values = [entry.short_answer_ro, ...(Array.isArray(entry.wrong_answers_ro) ? entry.wrong_answers_ro : [])];
        if (values.length === 3 && values.every(nonempty)
          && new Set(values.map((text) => text.trim().normalize('NFC').toLocaleLowerCase('ro'))).size === 3) {
          answerOptions.set(entry.card_id, entry);
        }
      }
    } else optionsUnavailable = true;
    chapters = structure.chapters;
    recoverRestore();
    loadProgress();
    navigate(location.hash.slice(1) || 'chapters', true);
    initialRender = false;
    if (!byId('chapters-screen').hidden) window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    byId('load-status').hidden = true;
  } catch (error) {
    byId('load-status').textContent = `Не удалось открыть карточки. ${error.message} Запустите локальный HTTP-сервер из корня проекта и откройте /web/.`;
  }
}
initialize();
