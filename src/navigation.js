function buildFileRequest({ filePath, line, column, matchText }) {
  const request = { type: 'file', path: filePath };
  if (line != null) request.line = line;
  if (column != null) request.column = column;
  if (matchText != null) request.matchText = matchText;
  return request;
}

function buildSymbolRequest({ symbolName, fileHint }) {
  const request = { type: 'symbol', name: symbolName };
  if (fileHint) request.fileHint = fileHint;
  return request;
}

function buildScrollRequest(result) {
  const request = { action: 'scroll', file: result.file, line: result.line };
  if (result.column != null) request.column = result.column;
  return request;
}

function buildCaretRequest() {
  return { action: 'caret' };
}

function buildCaretDiagnosticsRequest() {
  return { action: 'caret_diagnostics' };
}

function buildResolveFileRequest(filePath, { matchText, matchTextCandidates } = {}) {
  const request = { type: 'resolve_file', path: filePath };
  if (matchText != null) request.matchText = matchText;
  if (Array.isArray(matchTextCandidates) && matchTextCandidates.length > 0) {
    request.matchTextCandidates = matchTextCandidates;
  }
  return request;
}

function isAbsoluteFilePath(filePath) {
  return filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath);
}

function shouldQueryBackendForCaretPath(filePath) {
  return typeof filePath === 'string' && filePath.length > 0 && !filePath.startsWith('~/');
}

function shouldScrollFileResult(result) {
  return (result.status === 'ok' || result.status === 'text_moved') && result.line != null;
}

function shouldScrollSymbolResult(result) {
  return result.status === 'ok' && result.line != null;
}

async function navigateToFile({ filePath, line, column, matchText, sendNavigationRequest, frontendPort }) {
  const request = buildFileRequest({ filePath, line, column, matchText });
  const result = await sendNavigationRequest(request);
  if (shouldScrollFileResult(result)) {
    const scrollRequest = buildScrollRequest(result);
    result.scrollRequest = scrollRequest;
    result.scrollResponse = await sendNavigationRequest(scrollRequest, frontendPort);
  }
  return result;
}

async function navigateToSymbol({ symbolName, fileHint, sendNavigationRequest, frontendPort }) {
  const request = buildSymbolRequest({ symbolName, fileHint });
  const result = await sendNavigationRequest(request);
  if (shouldScrollSymbolResult(result)) {
    const scrollRequest = buildScrollRequest(result);
    result.scrollRequest = scrollRequest;
    result.scrollResponse = await sendNavigationRequest(scrollRequest, frontendPort);
  }
  return result;
}

async function getCaretPosition({ sendNavigationRequest, frontendPort, backendPort }) {
  const result = await sendNavigationRequest(buildCaretRequest(), frontendPort);
  if (!result || result.status !== 'ok' || !shouldQueryBackendForCaretPath(result.file)) {
    return result;
  }

  const resolved = await sendNavigationRequest(
    buildResolveFileRequest(result.file, {
      matchText: result.matchText,
      matchTextCandidates: result.matchTextCandidates,
    }),
    backendPort,
  );
  if (!resolved || resolved.status !== 'ok' || !resolved.file) {
    if (isAbsoluteFilePath(result.file)) {
      return result;
    }
    return resolved;
  }

  return {
    ...result,
    file: resolved.relativePath || resolved.file,
    line: resolved.line != null ? resolved.line : result.line,
    column: resolved.column != null ? resolved.column : result.column,
  };
}

async function getCaretDiagnostics({ sendNavigationRequest, frontendPort }) {
  return sendNavigationRequest(buildCaretDiagnosticsRequest(), frontendPort);
}

module.exports = {
  buildCaretDiagnosticsRequest,
  buildCaretRequest,
  buildFileRequest,
  buildResolveFileRequest,
  buildScrollRequest,
  buildSymbolRequest,
  getCaretDiagnostics,
  getCaretPosition,
  isAbsoluteFilePath,
  shouldQueryBackendForCaretPath,
  navigateToFile,
  navigateToSymbol,
  shouldScrollFileResult,
  shouldScrollSymbolResult,
};
