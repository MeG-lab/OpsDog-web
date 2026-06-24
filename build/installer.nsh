!include LogicLib.nsh
!include MUI2.nsh
!include Sections.nsh

!ifndef BUILD_UNINSTALLER

Var OpsDogInstallNode
Var OpsDogInstallPython

Section /o "安装 Node.js LTS" OPSDOG_NODE_RUNTIME_SECTION
  StrCpy $OpsDogInstallNode "1"
SectionEnd

Section /o "安装 Python 3" OPSDOG_PYTHON_RUNTIME_SECTION
  StrCpy $OpsDogInstallPython "1"
SectionEnd

Function OpsDogInstallNodeRuntime
  ${If} ${FileExists} "$INSTDIR\resources\installers\node-lts-x64.msi"
    DetailPrint "Opening bundled Node.js LTS installer..."
    ExecWait 'msiexec.exe /i "$INSTDIR\resources\installers\node-lts-x64.msi"' $0
    ${If} $0 != 0
      MessageBox MB_ICONEXCLAMATION "Node.js 安装未完成，返回码：$0。"
    ${EndIf}
  ${Else}
    MessageBox MB_ICONEXCLAMATION "未找到随包携带的 Node.js 安装程序：$INSTDIR\resources\installers\node-lts-x64.msi"
  ${EndIf}
FunctionEnd

Function OpsDogInstallPythonRuntime
  ${If} ${FileExists} "$INSTDIR\resources\installers\python-x64.exe"
    DetailPrint "Opening bundled Python installer..."
    ExecWait '"$INSTDIR\resources\installers\python-x64.exe"' $0
    ${If} $0 != 0
      MessageBox MB_ICONEXCLAMATION "Python 安装未完成，返回码：$0。"
    ${EndIf}
  ${Else}
    MessageBox MB_ICONEXCLAMATION "未找到随包携带的 Python 安装程序：$INSTDIR\resources\installers\python-x64.exe"
  ${EndIf}
FunctionEnd

!macro customPageAfterChangeDir
  !define MUI_COMPONENTSPAGE_TEXT_TOP "可选安装运行脚本和扩展所需的基础运行时。"
  !insertmacro MUI_PAGE_COMPONENTS
!macroend

!macro customInstall
  ${If} $OpsDogInstallNode == "1"
    SetDetailsPrint both
    Call OpsDogInstallNodeRuntime
  ${EndIf}

  ${If} $OpsDogInstallPython == "1"
    SetDetailsPrint both
    Call OpsDogInstallPythonRuntime
  ${EndIf}
!macroend

!endif
