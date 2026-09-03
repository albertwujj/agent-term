// What the viewer band renders on its own, by extension. One table for the
// click rule (terminal-nav-destination), the click sites (renderer), the
// selector's disk walk and its row tags: a format added here reaches every
// surface at once.
//
// The web band is a Chromium webview, so "renders" means Chromium's own image,
// media and PDF pages. The media set is what Electron 43's bundled ffmpeg
// reported playable (canPlayType "probably") in the app itself, with an H.264
// mp4 decoded to confirm; mov, avi and Theora came back unsupported and stay
// OS handoffs, as do archives and office documents, where the band has nothing
// better to do with them than the OS does.
const BAND_VIEWABLE_KINDS = {
  md: ['md', 'markdown', 'mdown'],
  html: ['html', 'htm', 'xhtml'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'],
  video: ['mp4', 'webm', 'mkv'],
  audio: ['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac'],
  pdf: ['pdf'],
};

// The kinds the file route serves: a path resolved to a file:// URL and handed
// to the web band as-is. md has its own viewer and html the band's page route,
// so neither is in here.
const BAND_FILE_KINDS = ['image', 'video', 'audio', 'pdf'];
const BAND_FILE_EXTENSIONS = BAND_FILE_KINDS.flatMap((kind) => BAND_VIEWABLE_KINDS[kind]);

// Every extension the selector's disk walk lists, dotted for the walk script.
const DISK_SEARCH_EXTENSIONS = Object.values(BAND_VIEWABLE_KINDS).flat().map((ext) => '.' + ext);

const BAND_FILE_PATH_RE = new RegExp(`\\.(?:${BAND_FILE_EXTENSIONS.join('|')})$`, 'i');
// The click rule's boundary: end of text, or the punctuation a line reference
// or prose hangs on a path (shot.png:1, "see clip.mp4,"), so the test sees the
// extension through a qualifier.
const BAND_FILE_TARGET = new RegExp(`\\.(?:${BAND_FILE_EXTENSIONS.join('|')})(?=$|[\\s:(#,;)\\]}'"])`, 'i');

function isBandFilePath(text) {
  return BAND_FILE_PATH_RE.test(String(text || ''));
}

const KIND_BY_EXTENSION = new Map(
  Object.entries(BAND_VIEWABLE_KINDS).flatMap(([kind, exts]) => exts.map((ext) => [ext, kind]))
);

// The kind a path or file:// URL is, by its extension; null for anything the
// band does not render. A URL's query and fragment are dropped first; a bare
// path keeps its # and ?, which are legal in a file name.
function bandViewableKind(pathOrUrl) {
  let s = String(pathOrUrl || '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = s.replace(/[?#].*$/, '');
  const m = /\.([a-z0-9]+)$/i.exec(s);
  return m ? (KIND_BY_EXTENSION.get(m[1].toLowerCase()) || null) : null;
}

module.exports = {
  BAND_VIEWABLE_KINDS,
  BAND_FILE_KINDS,
  BAND_FILE_EXTENSIONS,
  BAND_FILE_TARGET,
  DISK_SEARCH_EXTENSIONS,
  bandViewableKind,
  isBandFilePath,
};
