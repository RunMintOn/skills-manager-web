@echo off
setlocal
rem Skill Vault Manager: WSL service + Windows browser entry point.
rem The service is intentionally bound to 127.0.0.1:8787.
start "Skill Vault Manager" /b wsl.exe -- bash -lc "cd '/home/lee/11MyProjrct/44-skills-manager-web' && exec node src/server/server.ts"
ping 127.0.0.1 -n 3 >nul
start "" "http://localhost:8787/"
endlocal
