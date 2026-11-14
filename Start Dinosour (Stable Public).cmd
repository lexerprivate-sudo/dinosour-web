@echo off
cd /d "%~dp0"
title Dinosour (Stable Public)
echo This mode uses Tailscale Funnel for a stable public address.
echo One-time setup: install Tailscale, run "tailscale up", then enable Funnel
echo for this computer in the Tailscale admin console.
echo.
node share.mjs --provider=tailscale
pause
