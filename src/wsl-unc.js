// A POSIX path inside the WSL distro, as the UNC path Windows opens it by.
// On Windows the Electron process runs on the host while the shell, the
// documents, the stores and the user's home all live inside WSL, so every fs
// call from main crosses that boundary: separators flip and the
// \\wsl.localhost\<distro> prefix goes on the front.
function uncFromPosix(posixPath, distro) {
  return `\\\\wsl.localhost\\${distro}${String(posixPath || '').replace(/\//g, '\\')}`;
}

module.exports = { uncFromPosix };
