// Main-process native timing, read afresh for each delayed click so changes to
// accessibility/mouse settings apply without restarting AgentTerm.
// https://developer.apple.com/documentation/appkit/nsevent/doubleclickinterval
// https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getdoubleclicktime
function createDoubleClickIntervalReader({ platform = process.platform, loadKoffi = () => require('koffi') } = {}) {
  let read;
  return function doubleClickInterval() {
    try {
      if (!read) {
        if (platform === 'win32') {
          const user32 = loadKoffi().load('user32.dll');
          read = user32.func('uint32 __stdcall GetDoubleClickTime()');
        } else if (platform === 'darwin') {
          const koffi = loadKoffi();
          // AppKit is already loaded by Electron; explicitly load it for node
          // diagnostics as well. Keep the library handles alive with the reader.
          const appkit = koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
          const objc = koffi.load('/usr/lib/libobjc.A.dylib');
          const getClass = objc.func('void *objc_getClass(const char *name)');
          const getSelector = objc.func('void *sel_registerName(const char *name)');
          const sendDouble = objc.func('objc_msgSend', 'double', ['void *', 'void *']);
          const cls = getClass('NSEvent');
          const selector = getSelector('doubleClickInterval');
          if (!cls || !selector) return null;
          read = () => { void appkit; return sendDouble(cls, selector) * 1000; };
        } else {
          return null;
        }
      }
      const ms = read();
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    } catch {
      // Missing native support must not prevent startup or immediate links.
      // Without timing, the renderer retains Ctrl/Cmd-only external navigation.
      return null;
    }
  };
}

module.exports = { createDoubleClickIntervalReader };
