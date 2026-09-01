; Frozen Windows installer support. See docs/maintainer/windows-installer.md for the v0.1.15
; recovery baseline and the validation required before publishing it again.

; ---------------------------------------------------------------------------
; AgentTerm stub launcher
;
; Reads .current file for the active app-* directory, then launches
; that directory's AgentTerm.exe with forwarded command-line arguments.
; Compiled by makensis into a small (~30KB) exe with no console flash.
; ---------------------------------------------------------------------------

!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "TextFunc.nsh"

!ifndef APP_EXE_NAME
  !define APP_EXE_NAME "AgentTerm.exe"
!endif

Name "AgentTerm"
OutFile "launcher.exe"
SilentInstall silent
RequestExecutionLevel user

Section
  ; Get command-line parameters (excluding our own exe path)
  ${GetParameters} $R0

  ; A running app can relaunch while a side-by-side update is publishing its
  ; new version. The immutable relaunch copy survives the install and waits for
  ; its transaction marker to clear before consulting `.current`. Bound the wait
  ; so a crashed installer produces an explicit failure instead of a hung stub.
  StrCpy $R1 0
  _waitForInstall:
    IfFileExists "$EXEDIR\.installing" 0 _installReady
    IntOp $R1 $R1 + 1
    IntCmp $R1 1200 _installWaitTimedOut _installWaitMore _installWaitTimedOut
  _installWaitMore:
    Sleep 100
    Goto _waitForInstall
  _installWaitTimedOut:
    MessageBox MB_OK|MB_ICONSTOP "AgentTerm: an install is still incomplete; run the installer again."
    Quit
  _installReady:

  ; Read active app directory from .current file
  ClearErrors
  FileOpen $0 "$EXEDIR\.current" r
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "AgentTerm: could not read active app file (.current)."
    Quit
  ${EndIf}
  FileRead $0 $1
  FileClose $0

  ; Trim trailing CR/LF
  ${TrimNewLines} $1 $1

  ${If} $1 == ""
    MessageBox MB_OK|MB_ICONSTOP "AgentTerm: active app file (.current) is empty."
    Quit
  ${EndIf}

  ; Verify the target exe exists
  ${IfNot} ${FileExists} "$EXEDIR\$1\${APP_EXE_NAME}"
    MessageBox MB_OK|MB_ICONSTOP "AgentTerm: $1\${APP_EXE_NAME} not found."
    Quit
  ${EndIf}

  ; Launch the real application
  Exec '"$EXEDIR\$1\${APP_EXE_NAME}" $R0'
SectionEnd
