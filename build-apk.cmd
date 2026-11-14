@echo off
setlocal
cd /d "%~dp0android"
call gradlew.bat assembleRelease
if errorlevel 1 goto fail
if not exist "..\public\download" mkdir "..\public\download"
if not exist "..\releases" mkdir "..\releases"
copy /Y "app\build\outputs\apk\release\app-release.apk" "..\public\download\DinosourWeb.apk" >nul
copy /Y "app\build\outputs\apk\release\app-release.apk" "..\releases\DinosourWeb-latest.apk" >nul
echo.
echo Built: %~dp0releases\DinosourWeb-latest.apk
echo This APK is also served at /download/DinosourWeb.apk for in-app updates.
pause
exit /b 0
:fail
echo.
echo The APK build failed. Read the Gradle output above.
pause
exit /b 1
