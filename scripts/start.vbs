Option Explicit
Dim shell
Set shell = CreateObject("WScript.Shell")
' Keep the WSL service in the background; it listens only on loopback port 8787.
shell.Run "wsl.exe -- bash -lc ""cd '/home/lee/11MyProjrct/44-skills-manager-web' && exec node src/server/server.ts""", 0, False
WScript.Sleep 1800
shell.Run "cmd /c start """" http://localhost:8787/", 0, False
Set shell = Nothing
