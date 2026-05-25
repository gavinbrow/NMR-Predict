@echo off
setlocal EnableExtensions

REM ===========================================================================
REM  NMR Predict - production launcher
REM
REM  Builds the React frontend, then serves the SPA *and* the API together from
REM  a single FastAPI/uvicorn process on 0.0.0.0:7999 so the app is reachable
REM  from other machines on your network (and the public internet, if the host
REM  is exposed). Differences from run-nmr.bat:
REM
REM    * Binds 0.0.0.0 (all interfaces) instead of 127.0.0.1.
REM    * No --reload / no debug - a stable single process.
REM    * NMR_ENV=production -> interactive API docs (/docs, /redoc,
REM      /openapi.json) are disabled so the deployment doesn't advertise its
REM      surface area.
REM    * Verifies the build actually produced frontend\dist\index.html before
REM      starting, and refuses to start on a port that's already in use.
REM
REM  This runs in the foreground: the logs print here and closing the window
REM  (or Ctrl+C) stops the server. It does not kill other processes or delete
REM  anything.
REM
REM  >> Read the SECURITY NOTES printed at startup before exposing this to the
REM     open internet. The service has no built-in authentication. <<
REM ===========================================================================

set "ROOT=%~dp0"
set "BIND_HOST=0.0.0.0"
set "PORT=7999"
REM Switches on the docs-disabling branch in backend\app\main.py.
set "NMR_ENV=production"

echo ============================================================
echo  NMR Predict - PRODUCTION
echo  Build frontend, then serve SPA + API on %BIND_HOST%:%PORT%
echo ============================================================
echo.

call :detect_backend_python
if errorlevel 1 exit /b %errorlevel%
call :ensure_backend_dependencies
if errorlevel 1 exit /b %errorlevel%
call :ensure_node_toolchain
if errorlevel 1 exit /b %errorlevel%
call :ensure_port_free %PORT% "the production server"
if errorlevel 1 exit /b %errorlevel%
call :ensure_java_runtime
if errorlevel 1 exit /b %errorlevel%
call :ensure_cdk_bundle
if errorlevel 1 exit /b %errorlevel%
call :build_frontend
if errorlevel 1 exit /b %errorlevel%

call :print_endpoints
call :print_security_notes

echo Using backend Python: %BACKEND_PY_CMD%
cd /d "%ROOT%backend"
echo Starting uvicorn - press Ctrl+C or close this window to stop.
echo.
%BACKEND_PY_CMD% -m uvicorn app.main:app --host %BIND_HOST% --port %PORT%
goto :eof


REM ---------------------------------------------------------------------------
REM  Helpers (invoked via CALL; each returns with GOTO :EOF)
REM ---------------------------------------------------------------------------

:detect_backend_python
set "BACKEND_PY_CMD="
if exist "%ROOT%backend\.venv\Scripts\python.exe" (
    set "BACKEND_PY_CMD=""%ROOT%backend\.venv\Scripts\python.exe"""
    goto :eof
)

where py >nul 2>nul
if not errorlevel 1 (
    py -3.12 -c "import sys" >nul 2>nul
    if not errorlevel 1 (
        set "BACKEND_PY_CMD=py -3.12"
        goto :eof
    )

    py -3.10 -c "import sys" >nul 2>nul
    if not errorlevel 1 (
        set "BACKEND_PY_CMD=py -3.10"
        goto :eof
    )
)

where python >nul 2>nul
if not errorlevel 1 (
    set "BACKEND_PY_CMD=python"
    goto :eof
)

where py >nul 2>nul
if not errorlevel 1 (
    set "BACKEND_PY_CMD=py -3"
    goto :eof
)

echo No usable Python runtime found for the backend.
echo Install Python 3.12, or create backend\.venv with the project dependencies.
exit /b 1
goto :eof

:ensure_backend_dependencies
%BACKEND_PY_CMD% -c "import uvicorn" >nul 2>nul
if errorlevel 1 (
    echo Backend dependencies are missing for %BACKEND_PY_CMD%.
    echo Install them with:
    echo   cd /d "%ROOT%backend"
    echo   %BACKEND_PY_CMD% -m pip install -r requirements.txt
    exit /b 1
)
goto :eof

:ensure_node_toolchain
where npm >nul 2>nul
if errorlevel 1 (
    echo Node.js / npm was not found on PATH.
    echo Install Node.js 18+ from https://nodejs.org/ and re-run this script.
    exit /b 1
)
if not exist "%ROOT%frontend\node_modules" (
    echo Frontend dependencies not installed yet. Running npm install...
    cd /d "%ROOT%frontend"
    call npm install
    if errorlevel 1 (
        echo npm install failed.
        exit /b 1
    )
)
goto :eof

:load_port_owner
set "TARGET_PORT=%~1"
set "PORT_OWNER_PID="
set "PORT_OWNER_NAME="
set "PORT_OWNER_CMDLINE="

for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$ownerPid = Get-NetTCPConnection -LocalPort %TARGET_PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess; if ($null -ne $ownerPid) { $ownerPid }"`) do (
    set "PORT_OWNER_PID=%%P"
)
if not defined PORT_OWNER_PID goto :eof

for /f "usebackq delims=" %%N in (`powershell -NoProfile -Command "$proc = Get-CimInstance Win32_Process -Filter 'ProcessId = %PORT_OWNER_PID%' -ErrorAction SilentlyContinue; if ($null -ne $proc) { $proc.Name }"`) do (
    set "PORT_OWNER_NAME=%%N"
)
goto :eof

:show_port_conflict
set "TARGET_PORT=%~1"
set "TARGET_LABEL=%~2"
echo Port %TARGET_PORT% is already in use.
if defined PORT_OWNER_NAME (
    echo   Process: %PORT_OWNER_NAME% ^(PID %PORT_OWNER_PID%^)
) else (
    echo   PID: %PORT_OWNER_PID%
)
echo Stop that process or free port %TARGET_PORT% before starting %TARGET_LABEL%.
goto :eof

:ensure_port_free
set "TARGET_PORT=%~1"
set "TARGET_LABEL=%~2"
call :load_port_owner %TARGET_PORT%
if not defined PORT_OWNER_PID goto :eof

call :show_port_conflict %TARGET_PORT% "%TARGET_LABEL%"
exit /b 1

:ensure_java_runtime
where java >nul 2>nul
if not errorlevel 1 goto :eof

dir /b /s "%ROOT%backend\vendor\java\jvm.dll" >nul 2>nul
if not errorlevel 1 goto :eof

echo No Java runtime found. Fetching portable Temurin 17...
%BACKEND_PY_CMD% "%ROOT%backend\scripts\fetch_java.py"
if errorlevel 1 exit /b %errorlevel%
goto :eof

:ensure_cdk_bundle
set "CDK_DIR=%ROOT%backend\vendor\cdk"
if not exist "%CDK_DIR%" mkdir "%CDK_DIR%" >nul 2>nul
if not exist "%CDK_DIR%\cdk-2.9.jar" (
    echo CDK bundle missing. Fetching CDK jars...
    %BACKEND_PY_CMD% "%ROOT%backend\scripts\fetch_cdk.py"
    if errorlevel 1 exit /b %errorlevel%
    goto :eof
)

if not exist "%CDK_DIR%\predictorc.jar" if not exist "%CDK_DIR%\nmrshiftdb2.jar" (
    echo CDK predictor jar missing. Fetching CDK jars...
    %BACKEND_PY_CMD% "%ROOT%backend\scripts\fetch_cdk.py"
    if errorlevel 1 exit /b %errorlevel%
    goto :eof
)

if not exist "%CDK_DIR%\predictorh.jar" (
    echo CDK proton predictor jar missing. Fetching CDK jars...
    %BACKEND_PY_CMD% "%ROOT%backend\scripts\fetch_cdk.py"
    if errorlevel 1 exit /b %errorlevel%
)
goto :eof

:build_frontend
echo Building the frontend ^(npm run build^)...
cd /d "%ROOT%frontend"
call npm run build
if errorlevel 1 (
    echo Frontend build failed. Not starting the server.
    exit /b 1
)
if not exist "%ROOT%frontend\dist\index.html" (
    echo Build finished but frontend\dist\index.html is missing. Aborting.
    exit /b 1
)
echo Frontend build complete.
echo.
goto :eof

:print_endpoints
set "LAN_IP="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1 -ExpandProperty IPAddress"`) do (
    set "LAN_IP=%%I"
)
echo Serving SPA + API on:
echo   Local:    http://127.0.0.1:%PORT%
if defined LAN_IP echo   Network:  http://%LAN_IP%:%PORT%
echo.
goto :eof

:print_security_notes
echo ------------------------------------------------------------
echo  SECURITY NOTES - read before exposing this publicly
echo ------------------------------------------------------------
echo   * Binds %BIND_HOST%:%PORT% so it is reachable from other machines.
echo     To keep it local-only, set BIND_HOST=127.0.0.1 at the top of this file.
echo   * There is NO built-in authentication. Anyone who can reach the port
echo     can submit prediction jobs ^(CDK / CASCADE, plus ORCA DFT if ORCA is
echo     installed - those spawn CPU-heavy subprocesses^).
echo   * To allow the port through Windows Firewall, run in an ADMIN terminal:
echo       netsh advfirewall firewall add rule name="NMR Predict %PORT%" dir=in action=allow protocol=TCP localport=%PORT%
echo   * For real public exposure, front it with a reverse proxy
echo     ^(nginx / Caddy / Cloudflare Tunnel^) for HTTPS + rate limiting, and
echo     restrict who can reach it ^(firewall rules or an auth layer^).
echo ------------------------------------------------------------
echo.
goto :eof
