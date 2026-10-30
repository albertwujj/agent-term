// When the handoff pill shows and goes (the pill itself is in renderer.js).
//
// How long a handoff takes varies with the machine, the moment and the target,
// so nothing here depends on it. The pill waits out a short delay that is about
// what a person notices: a handoff finished by then needs no pill and never gets
// one, and one still running gets it for as long as the wait lasts.
//
// Neither the OS nor the IDE reports progress, so "nearly done" has one signal:
// the IDE's answer when it has no more to say, with only its window left to come
// forward (linger). Before the pill shows, that cancels it. After, the pill waits
// for the window, briefly, instead of flashing off just ahead of it.
const HANDOFF_PILL_DELAY_MS = 250;
const HANDOFF_PILL_LINGER_MS = 1000;

function createHandoffPillTiming({
  show,
  hide,
  delayMs = HANDOFF_PILL_DELAY_MS,
  lingerMs = HANDOFF_PILL_LINGER_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let current = null;

  // Over now: the other app took focus, the handoff failed, a toast takes over.
  function dismiss() {
    if (!current) return;
    const { delay, reap, shown } = current;
    current = null;
    clearTimer(delay);
    clearTimer(reap);
    if (shown) hide();
  }

  // `timeoutMs` reaps a pill when nothing ever reports an end. Returns a handle
  // for finish and linger, which do nothing once a later handoff has replaced it.
  function begin(text, timeoutMs) {
    dismiss();
    const handoff = { shown: false, delay: null, reap: null };
    handoff.delay = setTimer(() => {
      handoff.shown = true;
      show(text);
    }, delayMs);
    handoff.reap = setTimer(dismiss, timeoutMs);
    current = handoff;
    return handoff;
  }

  function finish(handoff) {
    if (handoff === current) dismiss();
  }

  function linger(handoff) {
    if (handoff !== current) return;
    if (!handoff.shown) {
      dismiss();
      return;
    }
    clearTimer(handoff.reap);
    handoff.reap = setTimer(dismiss, lingerMs);
  }

  return { begin, finish, linger, dismiss };
}

module.exports = { HANDOFF_PILL_DELAY_MS, HANDOFF_PILL_LINGER_MS, createHandoffPillTiming };
