// Every E2E launch goes through this helper, including individually run tests.
// AppKit aborts before app JS runs if an inherited macOS sandbox denies its
// GUI services. Check from the Node test runner, without starting Electron or
// relying on agent environment variables (which may survive an approved run).
import { createRequire } from 'node:module';
import { _electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const GUI_SERVICES = [
  'com.apple.coreservices.launchservicesd',
  'com.apple.windowserver.active',
];

function readBlockedMacGuiServices() {
  const koffi = require('koffi');
  const sandbox = koffi.load('/usr/lib/libsandbox.dylib');
  // macOS SPI, also declared by WebKit:
  // https://github.com/WebKit/WebKit/blob/main/Source/WTF/wtf/spi/darwin/SandboxSPI.h
  const check = sandbox.func('int sandbox_check(int pid, const char *operation, int type, ...)');
  const noReport = koffi.decode(sandbox.symbol('SANDBOX_CHECK_NO_REPORT', 'int'), 'int');
  const globalName = 2; // SANDBOX_FILTER_GLOBAL_NAME
  return GUI_SERVICES.filter(service => {
    // This is a variadic C call: its final argument must use the varargs ABI
    // on Apple Silicon, even though we always pass exactly one service name.
    const result = check(process.pid, 'mach-lookup', globalName | noReport, 'str', service);
    if (result < 0) throw new Error(`sandbox_check failed for ${service}: ${result}`);
    return result !== 0;
  });
}

export function createElectronLauncher({
  platform = process.platform,
  readBlockedServices = readBlockedMacGuiServices,
  launch = options => _electron.launch(options),
} = {}) {
  return async function launchElectron(options) {
    if (platform === 'darwin') {
      let blocked;
      try {
        blocked = readBlockedServices();
      } catch (cause) {
        const error = new Error(
          `[agent-term e2e EGUIACCESSCHECK] Could not check macOS GUI permissions: ${cause.message}\n`
          + 'Electron was not launched. Check the native koffi dependency and macOS sandbox probe.',
          { cause },
        );
        error.code = 'EGUIACCESSCHECK';
        throw error;
      }
      if (blocked.length) {
        const error = new Error(
          '[agent-term e2e EMACOSSANDBOX] E2E launch blocked: the macOS sandbox denies GUI access.\n'
          + `Denied mach-lookup: ${blocked.join(', ')}\n`
          + 'Electron was not launched; no UI assertions ran.\n'
          + 'Rerun the same test command from a normal desktop terminal or an approved unsandboxed execution.\n'
          + "Electron's --no-sandbox flag does not remove the parent macOS sandbox.",
        );
        error.code = 'EMACOSSANDBOX';
        throw error;
      }
    }
    return launch(options);
  };
}

export const launchElectron = createElectronLauncher();
