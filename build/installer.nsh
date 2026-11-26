!macro customInstall
  DetailPrint "Registering StudyNext task activation protocol..."
  WriteRegStr HKCU "Software\Classes\studynext" "" "URL:StudyNext task activation"
  WriteRegStr HKCU "Software\Classes\studynext" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\studynext\DefaultIcon" "" "$INSTDIR\StudyNext.exe,0"
  WriteRegStr HKCU "Software\Classes\studynext\shell\open\command" "" '"$INSTDIR\StudyNext.exe" "%1"'

  DetailPrint "Registering StudyNext system reminder task..."
  ExecWait '"$INSTDIR\StudyNext.exe" --install-reminders' $0
  DetailPrint "StudyNext system reminder registration exit code: $0"
!macroend

!macro customUnInstall
  DetailPrint "Removing StudyNext system reminder task..."
  ExecWait '"$INSTDIR\StudyNext.exe" --uninstall-reminders' $0
  DetailPrint "StudyNext system reminder removal exit code: $0"

  DetailPrint "Removing StudyNext task activation protocol..."
  DeleteRegKey HKCU "Software\Classes\studynext"
!macroend
