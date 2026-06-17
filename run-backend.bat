@echo off
setlocal EnableExtensions

REM ===========================================================================
REM  NMR Predict - backend-only launcher (Cloudflare Tunnel target)
REM
REM  Runs ONLY the FastAPI/uvicorn backend, bound to 127.0.0.1:7999, in
REM  production mode. No frontend build, no Vite dev server - nothing else.
REM  The static frontend is hosted separately on Cloudflare Pages
REM  (nmr.chembases.com); this process is what a `cloudflared` tunnel points at
REM  to publish the API at api.nmr.chembases.com.
REM
REM  Why 127.0.0.1 and not 0.0.0.0: cloudflared connects from THIS machine, so
REM  binding loopback keeps the API off the LAN and the public internet
REM  entirely - the only path in is through the authenticated Cloudflare tunnel.
REM
REM  Production mode (NMR_ENV=production) means:
REM    * Interactive API docs (/docs, /redoc, /openapi.json) are disabled.
REM    * ORCA is disabled - still listed but greyed out in the UI, and /predict
REM      refuses it, so only CDK and CASCADE actually run. ORCA's multi-minute
REM      DFT jobs are kept local-only (use run-nmr.bat for ORCA work); they
REM      would also blow past Cloudflare's ~100s proxy timeout anyway.
REM
REM  Foreground process: logs print here; Ctrl+C or closing the window stops it.
REM  It does not kill other processes or delete anything.
REM ===========================================================================

set "ROOT=%~dp0"
set "BIND_HOST=127.0.0.1"
set "PORT=7999"
REM Switches on the docs-disabling + ORCA-hiding branch in backend\app\main.py.
set "NMR_ENV=production"

REM CORS allow-list: the exact https origin(s) the browser loads the SPA from.
REM Comma-separate to allow more than one. NOTE: python-dotenv does NOT override
REM an already-set environment variable, so a value set here wins over .env -
REM to change the allowed origin, edit this line.
if not defined NMR_ALLOWED_ORIGINS set "NMR_ALLOWED_ORIGINS=https://nmr.chembases.com"

echo ============================================================
echo  NMR Predict - BACKEND ONLY (production)
echo  API on http://%BIND_HOST%:%PORT%
echo  CORS allow: %NMR_ALLOWED_ORIGINS%
echo ============================================================
echo.

call :detect_backend_python
if errorlevel 1 exit /b %errorlevel%
call :ensure_backend_dependencies
if errorlevel 1 exit /b %errorlevel%
call :ensure_port_free %PORT% "the backend"
if errorlevel 1 exit /b %errorlevel%
call :ensure_java_runtime
if errorlevel 1 exit /b %errorlevel%
call :ensure_cdk_bundle
if errorlevel 1 exit /b %errorlevel%

call :print_tunnel_notes

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

:load_port_owner
set "TARGET_PORT=%~1"
set "PORT_OWNER_PID="
set "PORT_OWNER_NAME="

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

:print_tunnel_notes
echo ------------------------------------------------------------
echo  Cloudflare Tunnel
echo ------------------------------------------------------------
echo   This process listens on http://127.0.0.1:%PORT% only (not the LAN).
echo   Start the tunnel in a SEPARATE window to publish the API:
echo       cloudflared tunnel run nmr-backend
echo   That maps api.nmr.chembases.com -^> http://localhost:%PORT%.
echo   See deploy\cloudflared\config.yml and DEPLOY.md for setup.
echo ------------------------------------------------------------
echo.
goto :eof
