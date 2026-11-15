@echo off
setlocal
cd /d "%~dp0android"
call gradlew.bat assembleRelease
if errorlevel 1 goto fail
if not exist "..\public\download" mkdir "..\public\download"
if not exist "..\releases" mkdir "..\releases"
copy /Y "app\build\outputs\apk\release\app-release.apk" "..\public\download\DinosourWeb.apk" >nul
for /f "tokens=2 delims=:" %%a in ('findstr /c:"versionName" "app\build.gradle"') do set V=%%~a
set V=%V:'=%
set V=%V: =%
copy /Y "app\build\outputs\apk\release\app-release.apk" "..\releases\DinosourWeb-%V%.apk" >nul
echo.
echo Built: %~dp0releases\DinosourWeb-%V%.apk
echo This APK is also served at /download/DinosourWeb.apk for in-app updates.
exit /b 0
:fail
echo.
echo The APK build failed. Read the Gradle output above.
exit /b 1
