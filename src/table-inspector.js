function openTableInspector(viewer, source, { onClose, onLinkClick }) {
  if (viewer.isOpen()) return;
  ensureStyles();
  const panel = document.createElement('div');
  panel.className = 'md-table-inspector';
  panel.innerHTML = `
    <div class="md-table-viewport" role="region" aria-label="Table contents" tabindex="0"></div>
    <div class="at-fullscreen-toolbar">
      <button type="button" data-close title="Close table (Esc)">Close</button>
    </div>`;
  const viewport = panel.querySelector('.md-table-viewport');
  // Copy the rendered rows without the outer table's viewer anchor or state.
  const table = document.createElement('table');
  for (const child of source.children) table.appendChild(child.cloneNode(true));
  table.style.setProperty('--table-columns', table.rows[0]?.cells.length || 1);
  table.querySelector('.md-edit-caret')?.remove();
  // The spread caches rendered image heights at its own column width.
  for (const image of table.querySelectorAll('img')) image.style.removeProperty('height');
  table.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href]');
    if (!link) return;
    event.preventDefault();
    onLinkClick(event, link);
  });
  viewport.appendChild(table);
  viewer.open(panel, { label: 'Expanded table', initialFocus: viewport, onClose });
}

function ensureStyles() {
  if (document.getElementById('md-table-inspector-style')) return;
  const style = document.createElement('style');
  style.id = 'md-table-inspector-style';
  style.textContent = `
    .md-table-viewport {
      box-sizing: border-box; flex: 1 1 auto; min-height: 0; min-width: 0;
      overflow: auto; padding: 0 16px 12px; color-scheme: light;
      scrollbar-width: thin; scrollbar-color: #aeb8c5 transparent;
      background: #eef1f5; color: #111827; font: 15px/1.5 system-ui, sans-serif;
    }
    .md-table-viewport:focus-visible { outline: 2px solid #6380a6; outline-offset: -2px; }
    .md-table-viewport table {
      width: 100%; min-width: calc(var(--table-columns) * 8rem);
      table-layout: fixed; border-collapse: separate; border-spacing: 0;
      border-top: 1px solid #d8dee6; border-left: 1px solid #d8dee6;
      background: #f9fafb;
    }
    .md-table-viewport :is(th, td) {
      padding: 8px 12px; vertical-align: top; overflow-wrap: anywhere;
      border-right: 1px solid #d8dee6; border-bottom: 1px solid #d8dee6;
    }
    .md-table-viewport thead { position: sticky; top: 0; z-index: 1; background: #e3e8ef; }
    .md-table-viewport th { font-weight: 600; text-align: start; }
    .md-table-viewport img { max-width: 100%; height: auto; }
    .md-table-viewport code { padding: 1px 3px; border-radius: 3px; background: #e2e8f0; }
    .md-table-viewport a { color: #1d4ed8; }
  `;
  document.head.appendChild(style);
}

module.exports = { openTableInspector };
