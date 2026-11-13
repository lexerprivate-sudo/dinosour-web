@echo off
setlocal
cd /d "%~dp0android"
call gradlew.bat assembleRelease
if errorlevel 1 goto fail
if not exist "..\public\download" mkdir "..\public\download"
copy /Y "app\build\outputs\apk\release\app-release.apk" "..\public\download\Dinosour.apk" >nul
copy /Y "app\build\outputs\apk\release\app-release.apk" "%USERPROFILE%\Desktop\Dinosour.apk" >nul
echo.
echo Built: %USERPROFILE%\Desktop\Dinosour.apk
echo This APK is also served at /download/Dinosour.apk for in-app updates.
pause
exit /b 0
:fail
echo.
echo The APK build failed. Read the Gradle output above.
pause
exit /b 1
