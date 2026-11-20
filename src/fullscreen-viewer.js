function createFullscreenViewer() {
  let current = null;

  function close(restoreFocus = true) {
    if (!current) return;
    const session = current;
    if (!restoreFocus) session.restoreFocus = false;
    if (session.closing) return;
    session.closing = true;
    const { panel, listeners, focus, onClose } = session;
    listeners.abort();
    const finish = () => {
      current = null;
      panel.remove();
      if (session.restoreFocus) {
        if (focus?.isConnected) focus.focus({ preventScroll: true });
        onClose();
      }
    };
    if (document.fullscreenElement === panel) {
      document.exitFullscreen().then(finish, finish);
    } else {
      finish();
    }
  }

  function open(panel, { label, initialFocus, onClose, onKeydown }) {
    if (current) return null;
    ensureStyles();
    const closeButton = panel.querySelector('[data-close]');
    const focus = document.activeElement;
    const listeners = new window.AbortController();
    const { signal } = listeners;
    current = { panel, listeners, focus, onClose, restoreFocus: true, closing: false };
    panel.classList.add('at-fullscreen-viewer', 'at-modal-overlay');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', label);
    closeButton.addEventListener('click', () => close(), { signal });
    document.body.appendChild(panel);
    (initialFocus || closeButton).focus({ preventScroll: true });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        close();
      } else if (event.key === 'Tab') {
        const controls = Array.from(panel.querySelectorAll('button, a[href], [tabindex="0"]'));
        const index = controls.indexOf(document.activeElement);
        const next = event.shiftKey ? Math.max(0, index) - 1 : index + 1;
        controls[(next + controls.length) % controls.length].focus();
      } else if (!onKeydown?.(event)) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { signal, capture: true });
    let enteredFullscreen = false;
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement === panel) enteredFullscreen = true;
      else if (enteredFullscreen) close();
    }, { signal });
    panel.requestFullscreen?.().catch(() => {});
    return signal;
  }

  return { open, close, isOpen: () => !!current };
}

function ensureStyles() {
  if (document.getElementById('at-fullscreen-viewer-style')) return;
  const style = document.createElement('style');
  style.id = 'at-fullscreen-viewer-style';
  style.textContent = `
    .at-fullscreen-viewer {
      position: fixed; inset: 0; z-index: 10001; display: flex;
      flex-direction: column; background: #15181d; color: #f0f2f5;
      font: 13px system-ui, sans-serif;
    }
    .at-fullscreen-toolbar {
      display: flex; align-items: center; justify-content: flex-end;
      flex-wrap: wrap; flex: 0 0 auto; gap: 6px; padding: 7px 10px; background: #30343c;
    }
    .at-fullscreen-toolbar button {
      padding: 4px 9px; border: 1px solid #696f79; border-radius: 4px;
      background: #454b55; color: inherit; cursor: pointer; font: inherit;
    }
    .at-fullscreen-toolbar button:hover { background: #565e6a; }
  `;
  document.head.appendChild(style);
}

module.exports = { createFullscreenViewer };
