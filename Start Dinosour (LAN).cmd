@echo off
cd /d "%~dp0"
title Dinosour (LAN)
set HOST=0.0.0.0
node server.js
pause
