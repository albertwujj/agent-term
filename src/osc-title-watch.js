// Observe OSC 0/2 titles before the renderer can pause output for commenting.
// PTY chunks may split anywhere, including inside ESC/ST. Other control
// strings (DCS/APC/PM/SOS) must not expose their payload as terminal titles.
function createOscTitleWatcher(onTitle) {
  let state = 'text';
  let payload = '';
  let overflow = false;
  const start = (next) => { state = next; payload = ''; overflow = false; };
  const append = (ch) => {
    if (payload.length < 8192) payload += ch;
    else overflow = true;
  };
  const finish = () => {
    const match = /^[02];([\s\S]*)$/.exec(payload);
    if (match) onTitle(overflow ? null : match[1]);
    start('text');
  };
  const escape = (ch) => {
    if (ch === ']') start('osc');
    else if (ch === '[') start('csi');
    else if ('P_^X'.includes(ch)) start('string');
    else state = ch === '\x1b' ? 'escape' : 'text';
  };
  return (chunk) => {
    for (const ch of String(chunk)) {
      if (ch === '\x18' || ch === '\x1a') { start('text'); continue; }
      if (state === 'string') {
        if (ch === '\x1b') state = 'string-escape';
        else if (ch === '\x9c') start('text');
      } else if (state === 'string-escape') {
        state = ch === '\\' || ch === '\x9c' ? 'text' : ch === '\x1b' ? 'string-escape' : 'string';
      } else if (state === 'osc') {
        if (ch === '\x07' || ch === '\x9c') finish();
        else if (ch === '\x1b') state = 'osc-escape';
        else append(ch);
      } else if (state === 'osc-escape') {
        if (ch === '\\') finish();
        else escape(ch);
      } else if (state === 'escape') {
        escape(ch);
      } else if (state === 'csi') {
        if (ch === '\x1b') state = 'escape';
        else if (ch >= '@' && ch <= '~') {
          // A CLI restoring the shell's title withdraws its status evidence.
          if (ch === 't' && !overflow && /^23(?:;[012])?$/.test(payload)) onTitle(null);
          start('text');
        } else append(ch);
      } else if (ch === '\x1b') state = 'escape';
      else if (ch === '\x9d') start('osc');
      else if (ch === '\x9b') start('csi');
      else if ('\x90\x98\x9e\x9f'.includes(ch)) start('string');
    }
  };
}

module.exports = { createOscTitleWatcher };
