@echo off
title XHS Skills Toolkit
chcp 65001 >nul 2>nul

set "TOOLKIT_DIR=%~dp0"
set "TOOLKIT_DIR=%TOOLKIT_DIR:~0,-1%"

REM === Kill stale processes from previous runs ===
echo [0] Cleaning up stale processes...
taskkill /F /FI "WINDOWTITLE eq XHS-Bridge" >nul 2>nul
taskkill /F /FI "WINDOWTITLE eq Cloudflared" >nul 2>nul

REM === Find xiaohongshu-skills (try multiple folder names) ===
set "SKILLS_DIR="
if exist "%TOOLKIT_DIR%\xiaohongshu-skills\scripts\cli.py" set "SKILLS_DIR=%TOOLKIT_DIR%\xiaohongshu-skills"
if not defined SKILLS_DIR if exist "%TOOLKIT_DIR%\xiaohongshu-skills-main\scripts\cli.py" set "SKILLS_DIR=%TOOLKIT_DIR%\xiaohongshu-skills-main"
REM Also try parent directory (in case bat is in scripts/ subfolder)
if not defined SKILLS_DIR if exist "%TOOLKIT_DIR%\..\xiaohongshu-skills\scripts\cli.py" set "SKILLS_DIR=%TOOLKIT_DIR%\..\xiaohongshu-skills"
if not defined SKILLS_DIR if exist "%TOOLKIT_DIR%\..\xiaohongshu-skills-main\scripts\cli.py" set "SKILLS_DIR=%TOOLKIT_DIR%\..\xiaohongshu-skills-main"
if not defined SKILLS_DIR (
    echo [ERROR] xiaohongshu-skills folder not found!
    echo Please put it in one of these locations:
    echo   %TOOLKIT_DIR%\xiaohongshu-skills\
    echo   %TOOLKIT_DIR%\xiaohongshu-skills-main\
    echo Make sure it contains scripts\cli.py
    pause
    exit /b 1
)
echo [OK] Skills dir: %SKILLS_DIR%

REM === Find xhs-bridge.mjs ===
set "BRIDGE=%TOOLKIT_DIR%\xhs-bridge.mjs"
if not exist "%BRIDGE%" (
    REM Try scripts/ subfolder (if bat is at project root)
    if exist "%TOOLKIT_DIR%\scripts\xhs-bridge.mjs" set "BRIDGE=%TOOLKIT_DIR%\scripts\xhs-bridge.mjs"
)
if not exist "%BRIDGE%" (
    echo [ERROR] xhs-bridge.mjs not found!
    echo Expected at: %TOOLKIT_DIR%\xhs-bridge.mjs
    pause
    exit /b 1
)

REM === Find cloudflared (try common names + subdirectory) ===
set "CLOUDFLARED="
if exist "%TOOLKIT_DIR%\cloudflared.exe" set "CLOUDFLARED=%TOOLKIT_DIR%\cloudflared.exe"
if not defined CLOUDFLARED if exist "%TOOLKIT_DIR%\cloudflared\cloudflared.exe" set "CLOUDFLARED=%TOOLKIT_DIR%\cloudflared\cloudflared.exe"
if not defined CLOUDFLARED if exist "%TOOLKIT_DIR%\cloudflared" if not exist "%TOOLKIT_DIR%\cloudflared\" set "CLOUDFLARED=%TOOLKIT_DIR%\cloudflared"
if not defined CLOUDFLARED if exist "%TOOLKIT_DIR%\cloudflared-windows-amd64.exe" set "CLOUDFLARED=%TOOLKIT_DIR%\cloudflared-windows-amd64.exe"
if not defined CLOUDFLARED if exist "%TOOLKIT_DIR%\cloudflared.exe.exe" set "CLOUDFLARED=%TOOLKIT_DIR%\cloudflared.exe.exe"

REM === Check and auto-install Node.js ===
where node >nul 2>nul
if errorlevel 1 (
    echo [SETUP] Node.js not found, trying to install via winget...
    winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements >nul 2>nul
    if errorlevel 1 (
        echo [WARN] winget install failed, trying direct download...
        powershell -NoProfile -ExecutionPolicy Bypass -Command ^
            "$url='https://nodejs.org/dist/v22.15.0/node-v22.15.0-x64.msi'; $out=\"$env:TEMP\node-install.msi\"; Invoke-WebRequest -Uri $url -OutFile $out; Start-Process msiexec.exe -ArgumentList '/i',$out,'/quiet','/norestart' -Wait -NoNewWindow; Remove-Item $out"
        if errorlevel 1 (
            echo [ERROR] Node.js auto-install failed!
            echo Please download manually from https://nodejs.org
            pause
            exit /b 1
        )
    )
    REM Refresh PATH for this session
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
    where node >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] Node.js installed but not found in PATH. Please restart this script.
        pause
        exit /b 1
    )
    echo [OK] Node.js installed successfully.
    echo.
)

REM === Check and auto-install uv ===
where uv >nul 2>nul
if errorlevel 1 (
    echo [SETUP] uv not found, installing...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
    if errorlevel 1 (
        echo [ERROR] uv install failed!
        echo Please manually run: powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
        pause
        exit /b 1
    )
    REM Refresh PATH so uv is available in this session
    set "PATH=%USERPROFILE%\.local\bin;%USERPROFILE%\.cargo\bin;%PATH%"
    where uv >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] uv installed but not found in PATH. Please restart this script.
        pause
        exit /b 1
    )
    echo [OK] uv installed successfully.
    echo.
)

REM === Check Python (via uv) ===
uv python find >nul 2>nul
if errorlevel 1 (
    echo [SETUP] Python not found, installing via uv...
    uv python install
    if errorlevel 1 (
        echo [ERROR] Python install failed!
        pause
        exit /b 1
    )
    echo [OK] Python installed successfully.
    echo.
)

REM === First run: install Python deps ===
if not exist "%SKILLS_DIR%\.venv" (
    echo [SETUP] Installing Python dependencies...
    pushd "%SKILLS_DIR%"
    uv sync
    popd
    if errorlevel 1 (
        echo [ERROR] Dependency install failed!
        pause
        exit /b 1
    )
    echo [OK] Dependencies installed.
    echo.
)

REM === Apply local patches to skills (idempotent, safe to re-run) ===
REM Patches publish tab selection and long-article content editor detection.
set "PATCH_SCRIPT=%TOOLKIT_DIR%\patch-xhs-publish.py"
if not exist "%PATCH_SCRIPT%" (
    if exist "%TOOLKIT_DIR%\scripts\patch-xhs-publish.py" set "PATCH_SCRIPT=%TOOLKIT_DIR%\scripts\patch-xhs-publish.py"
)
if exist "%PATCH_SCRIPT%" (
    echo [PATCH] Checking xiaohongshu-skills publish-tab patch...
    pushd "%SKILLS_DIR%"
    uv run python "%PATCH_SCRIPT%"
    popd
)

set "LONG_ARTICLE_PATCH=%TOOLKIT_DIR%\patch-xhs-long-article.py"
if not exist "%LONG_ARTICLE_PATCH%" (
    if exist "%TOOLKIT_DIR%\scripts\patch-xhs-long-article.py" set "LONG_ARTICLE_PATCH=%TOOLKIT_DIR%\scripts\patch-xhs-long-article.py"
)
if exist "%LONG_ARTICLE_PATCH%" (
    echo [PATCH] Checking xiaohongshu-skills long-article editor patch...
    pushd "%SKILLS_DIR%"
    uv run python "%LONG_ARTICLE_PATCH%"
    if errorlevel 1 (
        popd
        echo [ERROR] Long-article editor patch failed. Refusing to start an unsafe publisher.
        pause
        exit /b 1
    )
    popd
) else (
    echo [ERROR] patch-xhs-long-article.py not found.
    pause
    exit /b 1
)

REM === Detect skill version: OLD (CDP, needs --remote-debugging-port=9222) vs NEW (Extension Bridge) ===
set "CHROME_EXTRA_ARGS="
if exist "%SKILLS_DIR%\scripts\bridge_server.py" (
    echo [INFO] NEW version skills detected - Chrome will use default profile [extension mode]
) else (
    set "CHROME_EXTRA_ARGS=--remote-debugging-port=9222 --user-data-dir=%USERPROFILE%\.xhs\chrome-profile"
    echo [INFO] OLD version skills detected - Chrome will run with CDP port + isolated profile
    echo        Login session will be saved in: %USERPROFILE%\.xhs\chrome-profile\
)

REM === Open Chrome to xiaohongshu.com ===

REM Priority 1: CHROME_BIN environment variable (user can set this for portable Chrome)
set "CHROME_EXE="
if defined CHROME_BIN (
    if exist "%CHROME_BIN%" (
        set "CHROME_EXE=%CHROME_BIN%"
        echo [OK] Using CHROME_BIN: %CHROME_BIN%
    ) else (
        echo [WARN] CHROME_BIN is set but file not found: %CHROME_BIN%
    )
)

REM Priority 2: Try common Chrome and Edge locations
if not defined CHROME_EXE if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not defined CHROME_EXE if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not defined CHROME_EXE if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined CHROME_EXE if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" set "CHROME_EXE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not defined CHROME_EXE if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" set "CHROME_EXE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not defined CHROME_EXE if exist "%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe" set "CHROME_EXE=%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"
REM Try Chrome in toolkit directory (portable Chrome)
if not defined CHROME_EXE if exist "%TOOLKIT_DIR%\chrome\chrome.exe" set "CHROME_EXE=%TOOLKIT_DIR%\chrome\chrome.exe"
if not defined CHROME_EXE if exist "%TOOLKIT_DIR%\Chrome\Application\chrome.exe" set "CHROME_EXE=%TOOLKIT_DIR%\Chrome\Application\chrome.exe"

if not defined CHROME_EXE (
    echo [WARN] Chrome not found in common locations.
    echo        Set CHROME_BIN environment variable to your chrome.exe path.
    echo        Example: set CHROME_BIN=D:\Tools\Chrome\chrome.exe
    echo        cli.py will try to start Chrome automatically on first request.
) else (
    echo [1] Opening Chrome to xiaohongshu.com...
    echo     Path: "%CHROME_EXE%"
    start "" "%CHROME_EXE%" %CHROME_EXTRA_ARGS% --no-first-run --start-maximized https://www.xiaohongshu.com
    timeout /t 2 /nobreak >nul
)

REM === Create/read a persistent LAN access token ===
set "TOKEN_FILE=%TOOLKIT_DIR%\.xhs-bridge-token"
if not exist "%TOKEN_FILE%" (
    echo [SETUP] Generating Bridge access token...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$bytes=New-Object byte[] 32; $rng=New-Object Security.Cryptography.RNGCryptoServiceProvider; try{$rng.GetBytes($bytes)}finally{$rng.Dispose()}; $token=([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant(); [IO.File]::WriteAllText('%TOKEN_FILE%',$token)"
    if errorlevel 1 (
        echo [ERROR] Failed to generate Bridge access token.
        pause
        exit /b 1
    )
)
set /p XHS_BRIDGE_TOKEN=<"%TOKEN_FILE%"
if not defined XHS_BRIDGE_TOKEN (
    echo [ERROR] Bridge access token is empty: %TOKEN_FILE%
    pause
    exit /b 1
)

REM Detect the LAN IPv4 without PowerShell pipelines, which are fragile inside batch FOR /F.
set "LAN_IP="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$udp=New-Object Net.Sockets.UdpClient; try{$udp.Connect('1.1.1.1',53); $ip=($udp.Client.LocalEndPoint).Address.IPAddressToString; if($ip -and $ip -ne '0.0.0.0'){[Console]::WriteLine($ip)}}finally{$udp.Dispose()}"`) do set "LAN_IP=%%I"
REM Fallback: take the first private IPv4 printed by ipconfig.
if not defined LAN_IP for /f "tokens=2 delims=:" %%I in ('ipconfig ^| findstr /R /C:"IPv4.*: 192\.168\." /C:"IPv4.*: 10\." /C:"IPv4.*: 172\.1[6-9]\." /C:"IPv4.*: 172\.2[0-9]\." /C:"IPv4.*: 172\.3[0-1]\."') do if not defined LAN_IP for /f "tokens=*" %%J in ("%%I") do set "LAN_IP=%%J"
if not defined LAN_IP (
    echo [WARN] Could not detect the computer LAN IPv4 automatically.
    echo        Run ipconfig and replace YOUR-PC-IP on the phone with the active adapter IPv4.
    set "LAN_IP=YOUR-PC-IP"
)
REM === Step 2: Show connection info, then run Bridge in this window ===
echo.
echo  ============================================
echo   XHS BRIDGE - PHONE CONNECTION INFO
echo  ============================================
echo.
echo   Phone URL:    http://%LAN_IP%:18061/api
echo   Access Token: %XHS_BRIDGE_TOKEN%
echo.
echo   Copy both values into SullyOS:
echo   Settings - Realtime - Xiaohongshu Local.
echo   Keep this token private. Port 9333 stays local-only.
echo.
echo   Phone and computer must use the same Wi-Fi.
echo   Keep Edge open, keep XHS Bridge enabled, and stay logged in.
echo.
echo   Starting Bridge in this window...
echo   Request logs will appear below.
echo   Press Ctrl+C to stop the Bridge.
echo.

node "%BRIDGE%" --skills-dir "%SKILLS_DIR%" --host 0.0.0.0 --port 18061 --token "%XHS_BRIDGE_TOKEN%"
set "BRIDGE_EXIT=%ERRORLEVEL%"
echo.
echo [ERROR] Bridge stopped with exit code %BRIDGE_EXIT%.
echo Check the error above. This window will remain open.
pause
exit /b %BRIDGE_EXIT%
