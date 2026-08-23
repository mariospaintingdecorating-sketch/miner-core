!include "LogicLib.nsh"
!include "MUI2.nsh"
!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
  Var CoreMinerProfileChoice
  Var CoreMinerKeepProfileRadio
  Var CoreMinerCleanProfileRadio

  !macro customPageAfterChangeDir
    Page custom CoreMinerProfilePageCreate CoreMinerProfilePageLeave
  !macroend

  Function CoreMinerProfilePageCreate
    IfFileExists "$APPDATA\Miner Core\miner-core.sqlite" 0 CoreMinerProfilePageSkip

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "Dane Core Miner" "Wybierz sposób obsługi istniejących danych."

    ${NSD_CreateLabel} 0 0 100% 30u "Instalator wykrył istniejący profil Core Miner. Domyślnie portfele, zaszyfrowane poświadczenia, ustawienia i historia zostaną zachowane."
    Pop $0

    ${NSD_CreateRadioButton} 0 42u 100% 18u "Zachowaj istniejące portfele, klucze i historię (zalecane)"
    Pop $CoreMinerKeepProfileRadio
    ${NSD_Check} $CoreMinerKeepProfileRadio

    ${NSD_CreateRadioButton} 0 68u 100% 18u "Rozpocznij od zera i usuń istniejący profil instalacyjny"
    Pop $CoreMinerCleanProfileRadio

    ${NSD_CreateLabel} 14u 92u 86% 34u "Uwaga: druga opcja usuwa lokalne portfele, zaszyfrowane mining keys, ustawienia oraz historię z wersji instalacyjnej. Nie dotyczy profilu deweloperskiego."
    Pop $0

    StrCpy $CoreMinerProfileChoice "keep"
    nsDialogs::Show
    Return

    CoreMinerProfilePageSkip:
      StrCpy $CoreMinerProfileChoice "keep"
      Abort
  FunctionEnd

  Function CoreMinerProfilePageLeave
    ${NSD_GetState} $CoreMinerCleanProfileRadio $0
    ${If} $0 == ${BST_CHECKED}
      MessageBox MB_ICONEXCLAMATION|MB_YESNO|MB_DEFBUTTON2 \
        "Czy na pewno usunąć istniejące portfele, mining keys, ustawienia i historię wersji instalacyjnej?$\r$\n$\r$\nTej operacji nie można cofnąć bez wcześniejszego backupu." \
        IDYES CoreMinerProfileConfirmClean
      Abort

      CoreMinerProfileConfirmClean:
        StrCpy $CoreMinerProfileChoice "clean"
    ${Else}
      StrCpy $CoreMinerProfileChoice "keep"
    ${EndIf}
  FunctionEnd

  !macro customInstall
    ${If} $CoreMinerProfileChoice == "clean"
      RMDir /r "$APPDATA\Miner Core"
      IfFileExists "$APPDATA\Miner Core\*.*" 0 CoreMinerProfileCleanComplete
        MessageBox MB_ICONSTOP|MB_OK "Nie udało się bezpiecznie usunąć istniejącego profilu. Instalacja zostanie przerwana, a dane pozostaną zachowane."
        Abort
      CoreMinerProfileCleanComplete:
    ${EndIf}
  !macroend
!endif
