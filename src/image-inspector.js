function createImageInspector() {
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

  function open(source, onClose) {
    if (current) return;
    ensureStyles();
    const panel = document.createElement('div');
    panel.className = 'md-image-inspector at-modal-overlay';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Expanded image');
    panel.innerHTML = `
      <div class="md-image-stage"><img draggable="false"></div>
      <div class="md-image-toolbar">
        <span class="md-image-status" role="status"></span>
        <button type="button" data-fit>Fit</button>
        <button type="button" data-actual>Actual size</button>
        <button type="button" data-out aria-label="Zoom out">−</button>
        <output aria-label="Zoom level"></output>
        <button type="button" data-in aria-label="Zoom in">+</button>
        <button type="button" data-close title="Close image (Esc)">Close</button>
      </div>`;
    const stage = panel.querySelector('.md-image-stage');
    const image = stage.querySelector('img');
    const status = panel.querySelector('.md-image-status');
    const output = panel.querySelector('output');
    const buttons = Array.from(panel.querySelectorAll('button'));
    const closeButton = panel.querySelector('[data-close]');
    const focus = document.activeElement;
    const listeners = new window.AbortController();
    const { signal } = listeners;
    current = { panel, listeners, focus, onClose, restoreFocus: true, closing: false };
    image.alt = source.alt || '';
    image.src = source.currentSrc || source.src;
    document.body.appendChild(panel);
    closeButton.focus({ preventScroll: true });

    let scale = null;
    let x = 0;
    let y = 0;
    let drag = null;
    let enteredFullscreen = false;
    const width = () => image.naturalWidth || source.naturalWidth;
    const height = () => image.naturalHeight || source.naturalHeight;
    const fitScale = () => Math.min(stage.clientWidth / width(), stage.clientHeight / height());
    const zoomScale = () => scale ?? fitScale();
    const maxX = () => Math.max(0, (width() * zoomScale() - stage.clientWidth) / 2);
    const maxY = () => Math.max(0, (height() * zoomScale() - stage.clientHeight) / 2);
    const clamp = (value, extent) => Math.max(-extent, Math.min(value, extent));

    function paint() {
      if (!width() || !height()) return;
      const zoom = zoomScale();
      x = clamp(x, maxX());
      y = clamp(y, maxY());
      image.style.width = width() * zoom + 'px';
      image.style.height = height() * zoom + 'px';
      image.style.left = (stage.clientWidth - width() * zoom) / 2 + x + 'px';
      image.style.top = (stage.clientHeight - height() * zoom) / 2 + y + 'px';
      stage.classList.toggle('md-image-can-pan', maxX() > 0 || maxY() > 0);
      output.value = Math.round(zoom * 100) + '%';
    }

    function fit() {
      scale = null;
      x = 0;
      y = 0;
      paint();
    }

    function zoom(next, atX = stage.clientWidth / 2, atY = stage.clientHeight / 2) {
      if (!width() || !height()) return;
      const fitted = fitScale();
      const nextScale = Math.max(Math.min(fitted, 1), Math.min(next, Math.max(8, fitted * 4)));
      const ratio = nextScale / zoomScale();
      const dx = atX - stage.clientWidth / 2;
      const dy = atY - stage.clientHeight / 2;
      x = dx - (dx - x) * ratio;
      y = dy - (dy - y) * ratio;
      scale = nextScale;
      paint();
    }

    function zoomAtPointer(event, factor) {
      const rect = stage.getBoundingClientRect();
      zoom(zoomScale() * factor, event.clientX - rect.left, event.clientY - rect.top);
    }

    panel.querySelector('[data-fit]').addEventListener('click', fit);
    panel.querySelector('[data-actual]').addEventListener('click', () => zoom(1));
    panel.querySelector('[data-in]').addEventListener('click', () => zoom(zoomScale() * 1.25));
    panel.querySelector('[data-out]').addEventListener('click', () => zoom(zoomScale() / 1.25));
    closeButton.addEventListener('click', () => close());
    stage.addEventListener('dblclick', (event) => {
      const rect = image.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX >= rect.right
        || event.clientY < rect.top || event.clientY >= rect.bottom) return;
      event.preventDefault();
      zoomAtPointer(event, 2);
    });
    stage.addEventListener('wheel', (event) => {
      event.preventDefault();
      const factor = Math.exp(-clamp(event.deltaY * (event.deltaMode === 0 ? 0.003 : 0.08), 0.35));
      zoomAtPointer(event, factor);
    }, { passive: false });
    // Starting a browser drag cancels the pointer capture used for panning.
    stage.addEventListener('dragstart', (event) => event.preventDefault());
    stage.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !stage.classList.contains('md-image-can-pan')) return;
      stage.setPointerCapture(event.pointerId);
      drag = event;
      stage.classList.add('md-image-dragging');
    });
    stage.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      x += event.clientX - drag.clientX;
      y += event.clientY - drag.clientY;
      drag = event;
      paint();
    });
    stage.addEventListener('lostpointercapture', () => {
      drag = null;
      stage.classList.remove('md-image-dragging');
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
      else if (event.key === '+' || event.key === '=') zoom(zoomScale() * 1.25);
      else if (event.key === '-') zoom(zoomScale() / 1.25);
      else if (event.key === 'ArrowLeft') { x += 40; paint(); }
      else if (event.key === 'ArrowRight') { x -= 40; paint(); }
      else if (event.key === 'ArrowUp') { y += 40; paint(); }
      else if (event.key === 'ArrowDown') { y -= 40; paint(); }
      else if (event.key === 'Tab') {
        const index = buttons.indexOf(document.activeElement);
        const next = event.shiftKey ? Math.max(0, index) - 1 : index + 1;
        buttons[(next + buttons.length) % buttons.length].focus();
      } else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { signal, capture: true });
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement === panel) enteredFullscreen = true;
      else if (enteredFullscreen) close();
    }, { signal });
    window.addEventListener('resize', paint, { signal });
    image.addEventListener('load', paint);
    image.addEventListener('error', () => { status.textContent = 'Image unavailable'; });
    paint();
    panel.requestFullscreen?.().catch(() => {});
  }

  return { open, close, isOpen: () => !!current };
}

function ensureStyles() {
  if (document.getElementById('md-image-inspector-style')) return;
  const style = document.createElement('style');
  style.id = 'md-image-inspector-style';
  style.textContent = `
    .md-image-inspector {
      position: fixed; inset: 0; z-index: 10001; display: flex;
      flex-direction: column; background: #15181d; color: #f0f2f5;
      font: 13px system-ui, sans-serif;
    }
    .md-image-stage { flex: 1 1 auto; min-height: 0; position: relative; overflow: hidden; touch-action: none; }
    .md-image-stage img { position: absolute; max-width: none; pointer-events: none; user-select: none; }
    .md-image-stage.md-image-can-pan { cursor: grab; }
    .md-image-stage.md-image-dragging { cursor: grabbing; }
    .md-image-toolbar {
      display: flex; align-items: center; justify-content: flex-end;
      flex-wrap: wrap; flex: 0 0 auto; gap: 6px; padding: 7px 10px; background: #30343c;
    }
    .md-image-status { margin-inline-end: auto; }
    .md-image-toolbar output { min-width: 4ch; text-align: center; font-variant-numeric: tabular-nums; }
    .md-image-toolbar button {
      padding: 4px 9px; border: 1px solid #696f79; border-radius: 4px;
      background: #454b55; color: inherit; cursor: pointer; font: inherit;
    }
    .md-image-toolbar button:hover { background: #565e6a; }
  `;
  document.head.appendChild(style);
}

module.exports = { createImageInspector };
