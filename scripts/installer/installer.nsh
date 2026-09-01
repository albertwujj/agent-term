; Frozen Windows installer support. See docs/maintainer/windows-installer.md for the v0.1.15
; recovery baseline and the validation required before publishing it again.

; ---------------------------------------------------------------------------
; customCheckAppRunning
;
; Do NOT kill running AgentTerm processes. Old versions continue running
; from their versioned subdirectory while the new version installs
; alongside them.
;
; Pre-remove the old uninstaller exe so uninstallOldVersion falls through.
; ---------------------------------------------------------------------------
!macro customCheckAppRunning
  ; Publish an install transaction marker before the flat app files replace the
  ; root launcher. The immutable relaunch stub waits for this to disappear, so
  ; a relaunch racing an update cannot read the previous `.current` value.
  CreateDirectory "$INSTDIR"
  FileOpen $0 "$INSTDIR\.installing" w
  FileWrite $0 "installing"
  FileClose $0
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
!macroend

; ---------------------------------------------------------------------------
; customUnInstallCheck / customUnInstallCheckCurrentUser
;
; No-op: do not nuke $INSTDIR.  Old app-* directories may still be in
; use by running processes.  Cleanup is handled in customInstall.
; ---------------------------------------------------------------------------
!macro customUnInstallCheck
!macroend

!macro customUnInstallCheckCurrentUser
!macroend

; ---------------------------------------------------------------------------
; customInstall
;
; After electron-builder writes files flat into $INSTDIR:
;   1. Pick a unique app-* subdirectory for this install
;   2. Move all installed files into it (skip app-*, uninstaller, .current)
;   3. Deploy the root stub + immutable relaunch stub
;   4. Atomically publish .current with the active app directory name
;   5. Try to remove old app-* directories (silently fails if locked)
; ---------------------------------------------------------------------------
!macro customInstall
  ; 1. Pick a unique directory so same-version refreshes don't try to
  ; overwrite a locked app-${VERSION} tree from a still-running process.
  StrCpy $3 "app-${VERSION}"
  StrCpy $4 1
  _findAppDir:
    IfFileExists "$INSTDIR\$3" _appDirExists _appDirReady
  _appDirExists:
    IntOp $4 $4 + 1
    StrCpy $3 "app-${VERSION}-$4"
    Goto _findAppDir
  _appDirReady:
    CreateDirectory "$INSTDIR\$3"

  ; 2. Move installed files into versioned subdir
  FindFirst $0 $1 "$INSTDIR\*.*"
  _moveLoop:
    StrCmp $1 "" _moveDone
    StrCmp $1 "." _moveNext
    StrCmp $1 ".." _moveNext

    ; Skip existing app-* directories
    StrCpy $2 $1 4
    StrCmp $2 "app-" _moveNext

    ; Skip uninstaller
    StrCmp $1 "${UNINSTALL_FILENAME}" _moveNext

    ; Skip .current version file
    StrCmp $1 ".current" _moveNext

    ; Keep the install transaction and immutable relaunch stub at the root.
    StrCmp $1 ".current.next" _moveNext
    StrCmp $1 ".installing" _moveNext
    StrCpy $2 $1 21
    StrCmp $2 ".agent-term-launcher-" _moveNext

    ; Skip uninstaller icon
    StrCmp $1 "uninstallerIcon.ico" _moveNext

    ; Move to the new app dir
    Rename "$INSTDIR\$1" "$INSTDIR\$3\$1"

  _moveNext:
    FindNext $0 $1
    Goto _moveLoop
  _moveDone:
    FindClose $0

  ; 3. Deploy root launcher (overwrites the AgentTerm.exe we just moved).
  SetOutPath "$INSTDIR"
  File "/oname=${APP_EXECUTABLE_FILENAME}" "${BUILD_RESOURCES_DIR}\launcher.exe"

  ; Preserve a separate launcher across future installs. Running app versions
  ; target this path for relaunch, so the installer's temporary replacement of
  ; the root AgentTerm.exe can never redirect a racing relaunch into flat files.
  IfFileExists "$INSTDIR\.agent-term-launcher-$3.exe" _stableLauncherReady
  File "/oname=.agent-term-launcher-$3.exe" "${BUILD_RESOURCES_DIR}\launcher.exe"
  _stableLauncherReady:

  ; 4. Write the next pointer, then atomically replace `.current`. The launcher
  ; waits on `.installing`, so after publication it can only observe this value.
  FileOpen $0 "$INSTDIR\.current.next" w
  FileWrite $0 "$3"
  FileClose $0
  System::Call 'Kernel32::MoveFileEx(t "$INSTDIR\.current.next", t "$INSTDIR\.current", i 1) i .r0'
  StrCmp $0 0 _publishCurrentFailed _publishCurrentDone
  _publishCurrentFailed:
    MessageBox MB_OK|MB_ICONSTOP "AgentTerm: could not publish the active app version."
    Abort
  _publishCurrentDone:

  ; 5. Clean up old versioned directories (best-effort)
  FindFirst $0 $1 "$INSTDIR\app-*"
  _cleanLoop:
    StrCmp $1 "" _cleanDone
    StrCmp $1 "$3" _cleanNext
    RMDir /r "$INSTDIR\$1"
    ; If the app directory is gone, no process can need its matching immutable
    ; relauncher anymore. A locked/running app leaves both in place.
    IfFileExists "$INSTDIR\$1" _cleanNext
    Delete "$INSTDIR\.agent-term-launcher-$1.exe"
  _cleanNext:
    FindNext $0 $1
    Goto _cleanLoop
  _cleanDone:
    FindClose $0
  ; The new pointer, launchers, and cleanup pass are now complete. Waiting
  ; relaunch stubs may proceed and are guaranteed to read the published target.
  Delete "$INSTDIR\.installing"
!macroend

; ---------------------------------------------------------------------------
; customRemoveFiles — uninstaller: remove all versioned dirs and the stub
; ---------------------------------------------------------------------------
!macro customRemoveFiles
  ; Remove all app-* directories
  FindFirst $0 $1 "$INSTDIR\app-*"
  _unLoop:
    StrCmp $1 "" _unDone
    RMDir /r "$INSTDIR\$1"
    FindNext $0 $1
    Goto _unLoop
  _unDone:
    FindClose $0

  ; Remove stub launcher and version file
  Delete "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  Delete "$INSTDIR\.agent-term-launcher-*.exe"
  Delete "$INSTDIR\.current"
  Delete "$INSTDIR\.current.next"
  Delete "$INSTDIR\.installing"
  Delete "$INSTDIR\uninstallerIcon.ico"

  ; Remove install dir (succeeds only if empty)
  SetOutPath $TEMP
  RMDir "$INSTDIR"
!macroend
