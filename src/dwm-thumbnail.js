// DWM iconic thumbnail wrapper — Windows-only.
//
// Replaces the scaled-down screenshot in the taskbar thumbnail popup (and the
// Aero Peek live preview) with a custom bitmap. We use Win32's "iconic
// representation" facility: tell DWM that our window has a custom iconic
// bitmap, then push that bitmap. DWM caches it and uses it whenever the
// thumbnail/live-preview is requested for our HWND.
//
// On non-Windows platforms (macOS dev environment, Linux), every exported
// function silently returns false. The whole module is a no-op there — no
// FFI is loaded, no koffi calls happen.
//
// Usage from main process (Windows path):
//   const dwm = require('./dwm-thumbnail');
//   const hwnd = mainWindow.getNativeWindowHandle();   // Buffer
//   dwm.enableIconicMode(hwnd);                         // once per window
//   dwm.pushThumbnailBitmap(hwnd, bgraBuf, w, h);       // when prompt captured
//   dwm.pushLivePreviewBitmap(hwnd, bgraBuf, w, h);     // optional, larger size
//
// bgra* buffers are top-down 32-bit BGRA pixel arrays of length w*h*4. Get
// them from Electron's nativeImage.toBitmap() on Windows.

const IS_WIN = process.platform === 'win32';

// ---- Constants ----
const DWMWA_HAS_ICONIC_BITMAP = 10;
const DWMWA_FORCE_ICONIC_REPRESENTATION = 7;
const DWMWA_DISALLOW_PEEK = 11;
// DWMWA_USE_IMMERSIVE_DARK_MODE = 20 (Win10 build 19041+). Without this,
// the Aero Peek transition backdrop reflects the Windows system theme
// (light = white flash before our bitmap arrives, since DWM doesn't
// cache live preview). Setting dark mode on the window typically makes
// the backdrop dark, so the brief gap between hover-in and our pushed
// bitmap is black-on-black instead of jarring white.
const DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
const BI_RGB = 0;
const DIB_RGB_COLORS = 0;

// ---- FFI bindings (lazy-loaded) ----
// Loading deferred so non-Windows platforms never touch koffi at all, and so
// a koffi-load failure (rare) doesn't block the whole app.
let bindings = null;
let bindingsAttempted = false;

function getBindings() {
  if (bindings || bindingsAttempted) return bindings;
  bindingsAttempted = true;
  if (!IS_WIN) return null;

  try {
    const koffi = require('koffi');

    const dwmapi = koffi.load('dwmapi.dll');
    const gdi32 = koffi.load('gdi32.dll');

    // BITMAPINFOHEADER struct (Win32, 40 bytes).
    const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
      biSize: 'uint32',
      biWidth: 'int32',
      biHeight: 'int32',
      biPlanes: 'uint16',
      biBitCount: 'uint16',
      biCompression: 'uint32',
      biSizeImage: 'uint32',
      biXPelsPerMeter: 'int32',
      biYPelsPerMeter: 'int32',
      biClrUsed: 'uint32',
      biClrImportant: 'uint32',
    });

    // BITMAPINFO is BITMAPINFOHEADER followed by a color table (unused for
    // 32bpp BI_RGB, but the field needs to exist so the struct has the right
    // size). We pass a pointer-to-BITMAPINFOHEADER cast to BITMAPINFO* — Win32
    // accepts that for 32bpp BI_RGB.

    // ---- dwmapi ----
    // HRESULT DwmSetWindowAttribute(HWND, DWORD, LPCVOID, DWORD)
    const DwmSetWindowAttribute = dwmapi.func(
      '__stdcall', 'DwmSetWindowAttribute', 'long',
      ['void *', 'uint32', 'void *', 'uint32']
    );
    // HRESULT DwmSetIconicThumbnail(HWND, HBITMAP, DWORD)
    const DwmSetIconicThumbnail = dwmapi.func(
      '__stdcall', 'DwmSetIconicThumbnail', 'long',
      ['void *', 'void *', 'uint32']
    );
    // HRESULT DwmSetIconicLivePreviewBitmap(HWND, HBITMAP, POINT*, DWORD)
    const DwmSetIconicLivePreviewBitmap = dwmapi.func(
      '__stdcall', 'DwmSetIconicLivePreviewBitmap', 'long',
      ['void *', 'void *', 'void *', 'uint32']
    );
    // HRESULT DwmInvalidateIconicBitmaps(HWND)
    const DwmInvalidateIconicBitmaps = dwmapi.func(
      '__stdcall', 'DwmInvalidateIconicBitmaps', 'long',
      ['void *']
    );

    // ---- gdi32 ----
    // HBITMAP CreateDIBSection(HDC, BITMAPINFO*, UINT, void**, HANDLE, DWORD)
    // Param 2 is a pointer-to-BITMAPINFO. koffi.pointer(BITMAPINFOHEADER)
    // tells koffi to marshal the JS struct object we pass into a heap
    // allocation and forward its address — declaring it as a plain
    // 'void *' makes koffi throw "Unexpected Object value, expected
    // void *" because it has no struct shape to serialize from. Win32
    // accepts a BITMAPINFOHEADER cast to BITMAPINFO* for 32bpp BI_RGB
    // (the color table after the header is unused).
    const CreateDIBSection = gdi32.func(
      '__stdcall', 'CreateDIBSection', 'void *',
      ['void *', koffi.pointer(BITMAPINFOHEADER), 'uint32', koffi.out('void **'), 'void *', 'uint32']
    );
    // BOOL DeleteObject(HGDIOBJ)
    const DeleteObject = gdi32.func(
      '__stdcall', 'DeleteObject', 'int', ['void *']
    );

    bindings = {
      koffi,
      BITMAPINFOHEADER,
      DwmSetWindowAttribute,
      DwmSetIconicThumbnail,
      DwmSetIconicLivePreviewBitmap,
      DwmInvalidateIconicBitmaps,
      CreateDIBSection,
      DeleteObject,
    };
  } catch (err) {
    console.warn('[dwm-thumbnail] FFI init failed:', err.message);
    bindings = null;
  }
  return bindings;
}

// ---- Helpers ----

// Electron's mainWindow.getNativeWindowHandle() returns a Node Buffer whose
// bytes ARE the HWND value. koffi treats a Buffer parameter as &buffer (a
// pointer to the buffer's contents), not the value itself, so passing the
// raw Buffer makes Win32 see a bogus handle and silently no-op the call.
// Extract the handle value as a BigInt and pass that — koffi accepts numbers
// and BigInts for `void *` params and uses them as the pointer value.
function hwndValue(hwnd) {
  if (hwnd === null || hwnd === undefined) return null;
  if (Buffer.isBuffer(hwnd)) {
    if (hwnd.length >= 8) return hwnd.readBigUInt64LE(0);
    if (hwnd.length >= 4) return BigInt(hwnd.readUInt32LE(0));
    return null;
  }
  if (typeof hwnd === 'bigint') return hwnd;
  if (typeof hwnd === 'number') return BigInt(hwnd);
  return null;
}

// Set a 32-bit DWORD attribute (BOOL) via DwmSetWindowAttribute.
function setBoolAttribute(b, hwnd, attr, value) {
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(value ? 1 : 0, 0);
  const hr = b.DwmSetWindowAttribute(hwnd, attr, buf, 4);
  return hr === 0;
}

// Create a top-down 32bpp HBITMAP and copy bgraBuf into its pixels. Returns
// the HBITMAP (Buffer pointer) on success, null on failure.
function createBitmap(b, width, height, bgraBuf) {
  const expected = width * height * 4;
  if (bgraBuf.length !== expected) {
    console.warn(`[dwm-thumbnail] pixel buffer size mismatch: got ${bgraBuf.length}, expected ${expected}`);
    return null;
  }

  // BITMAPINFOHEADER, top-down (negative biHeight) so memory layout is row-major from top.
  const header = {
    biSize: 40,
    biWidth: width,
    biHeight: -height,        // top-down DIB
    biPlanes: 1,
    biBitCount: 32,
    biCompression: BI_RGB,
    biSizeImage: 0,
    biXPelsPerMeter: 0,
    biYPelsPerMeter: 0,
    biClrUsed: 0,
    biClrImportant: 0,
  };

  // Out-pointer for ppvBits — koffi marks it `out` so we'll get back the
  // address of DIB pixel memory.
  const ppvBits = [null];
  const hbitmap = b.CreateDIBSection(null, header, DIB_RGB_COLORS, ppvBits, null, 0);
  if (!hbitmap) {
    console.warn('[dwm-thumbnail] CreateDIBSection returned null');
    return null;
  }

  // Copy our BGRA pixels into the DIB-allocated memory.
  const ptr = ppvBits[0];
  if (!ptr) {
    console.warn('[dwm-thumbnail] CreateDIBSection gave a null pixel pointer');
    b.DeleteObject(hbitmap);
    return null;
  }

  // koffi exposes raw memory at a pointer via decode/encode; for a flat
  // copy we pass the BGRA Buffer (a Uint8Array) directly — no JS array
  // conversion, just a memcpy into the DIB-allocated memory.
  b.koffi.encode(ptr, 'uint8', bgraBuf, bgraBuf.length);

  return hbitmap;
}

// ---- Public API ----

// One-time setup per window: tell DWM we'll provide our own iconic bitmaps
// and want it to use them instead of capturing the window.
//
// We also disable Aero Peek (DWMWA_DISALLOW_PEEK) for this window. Reason:
// FORCE_ICONIC_REPRESENTATION applies to BOTH surfaces (small thumbnail
// AND Aero Peek live preview); there's no per-surface flag. With FORCE on
// we get the activity card on the small thumbnail (good) but Aero Peek
// on hover-into-thumbnail tries to use the iconic-live-preview path,
// which requires responding to WM_DWMSENDICONICLIVEPREVIEWBITMAP from a
// subclassed WndProc — we don't, so it shows a "spinny → chip-on-grey"
// fallback. Disabling Peek for our window removes that broken full-screen
// hover behavior entirely. Small thumbnail keeps working as designed.
function enableIconicMode(hwnd) {
  if (!IS_WIN) return { ok: false, has: false, force: false, disallowPeek: false, darkMode: false };
  const b = getBindings();
  const h = hwndValue(hwnd);
  if (!b || h === null) {
    return { ok: false, has: false, force: false, disallowPeek: false, darkMode: false };
  }
  const has = setBoolAttribute(b, h, DWMWA_HAS_ICONIC_BITMAP, true);
  const force = setBoolAttribute(b, h, DWMWA_FORCE_ICONIC_REPRESENTATION, true);
  const disallowPeek = setBoolAttribute(b, h, DWMWA_DISALLOW_PEEK, true);
  const darkMode = setBoolAttribute(b, h, DWMWA_USE_IMMERSIVE_DARK_MODE, true);
  return { ok: has && force, has, force, disallowPeek, darkMode };
}

// Push a small (typically 280x158-ish) bitmap as the iconic thumbnail.
// Returns true on success.
function pushThumbnailBitmap(hwnd, bgraBuf, width, height) {
  if (!IS_WIN) return false;
  const b = getBindings();
  const h = hwndValue(hwnd);
  if (!b || h === null) return false;
  const hbitmap = createBitmap(b, width, height, bgraBuf);
  if (!hbitmap) return false;
  try {
    const hr = b.DwmSetIconicThumbnail(h, hbitmap, 0);
    return hr === 0;
  } finally {
    // DWM copies the bitmap; safe to delete ours.
    b.DeleteObject(hbitmap);
  }
}

// Push a larger (Aero Peek size) bitmap as the iconic live-preview. POINT*
// argument is null — DWM will center the preview at the window's client origin.
function pushLivePreviewBitmap(hwnd, bgraBuf, width, height) {
  if (!IS_WIN) return false;
  const b = getBindings();
  const h = hwndValue(hwnd);
  if (!b || h === null) return false;
  const hbitmap = createBitmap(b, width, height, bgraBuf);
  if (!hbitmap) return false;
  try {
    const hr = b.DwmSetIconicLivePreviewBitmap(h, hbitmap, null, 0);
    return hr === 0;
  } finally {
    b.DeleteObject(hbitmap);
  }
}

// Build a 32-bpp top-down DIB-section HBITMAP from a BGRA buffer and
// return the handle (a koffi pointer Buffer) without deleting it. The
// caller owns the lifetime — must pass the returned handle to
// deleteHBitmap() before replacing or on shutdown to avoid leaking the
// GDI object. Used to PRE-BUILD bitmaps outside the WM_DWMSEND* hooks
// so the hook callbacks themselves can push instantly (no CreateDIBSection
// or memcpy inside the hot path).
function buildHBitmap(bgraBuf, width, height) {
  if (!IS_WIN) return null;
  const b = getBindings();
  if (!b) return null;
  return createBitmap(b, width, height, bgraBuf);
}

// Free an HBITMAP previously returned by buildHBitmap.
function deleteHBitmap(hbitmap) {
  if (!IS_WIN || !hbitmap) return false;
  const b = getBindings();
  if (!b) return false;
  return b.DeleteObject(hbitmap) !== 0;
}

// Push a pre-built HBITMAP as the iconic thumbnail. Caller retains
// ownership — we do NOT DeleteObject. Use when calling from inside a
// WM_DWMSENDICONICTHUMBNAIL handler where the HBITMAP was prepared in
// advance.
function pushThumbnailHBitmap(hwnd, hbitmap) {
  if (!IS_WIN) return false;
  const b = getBindings();
  const h = hwndValue(hwnd);
  if (!b || h === null || !hbitmap) return false;
  return b.DwmSetIconicThumbnail(h, hbitmap, 0) === 0;
}

// Push a pre-built HBITMAP as the iconic live preview. Caller retains
// ownership. Companion to pushThumbnailHBitmap for the live-preview surface.
function pushLivePreviewHBitmap(hwnd, hbitmap) {
  if (!IS_WIN) return false;
  const b = getBindings();
  const h = hwndValue(hwnd);
  if (!b || h === null || !hbitmap) return false;
  return b.DwmSetIconicLivePreviewBitmap(h, hbitmap, null, 0) === 0;
}

// Tell DWM to discard cached iconic bitmaps (e.g., after the prompt changes).
function invalidate(hwnd) {
  if (!IS_WIN) return false;
  const b = getBindings();
  const h = hwndValue(hwnd);
  if (!b || h === null) return false;
  return b.DwmInvalidateIconicBitmaps(h) === 0;
}

module.exports = {
  isSupported: IS_WIN,
  enableIconicMode,
  pushThumbnailBitmap,
  pushLivePreviewBitmap,
  buildHBitmap,
  deleteHBitmap,
  pushThumbnailHBitmap,
  pushLivePreviewHBitmap,
  invalidate,
};
