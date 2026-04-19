@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
set "MODE=%~1"

if not defined MODE set "MODE=all"

if /I "%MODE%"=="all" goto start_all
if /I "%MODE%"=="dev" goto start_all
if /I "%MODE%"=="backend" goto run_backend
if /I "%MODE%"=="frontend" goto run_frontend
if /I "%MODE%"=="serve" goto serve_combined
if /I "%MODE%"=="help" goto usage

echo Unknown mode: %MODE%
goto usage

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
set "PORT_OWNER_CMDLINE="

for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$ownerPid = Get-NetTCPConnection -LocalPort %TARGET_PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess; if ($null -ne $ownerPid) { $ownerPid }"`) do (
    set "PORT_OWNER_PID=%%P"
)
if not defined PORT_OWNER_PID goto :eof

for /f "usebackq delims=" %%N in (`powershell -NoProfile -Command "$proc = Get-CimInstance Win32_Process -Filter 'ProcessId = %PORT_OWNER_PID%' -ErrorAction SilentlyContinue; if ($null -ne $proc) { $proc.Name }"`) do (
    set "PORT_OWNER_NAME=%%N"
)

for /f "usebackq delims=" %%C in (`powershell -NoProfile -Command "$proc = Get-CimInstance Win32_Process -Filter 'ProcessId = %PORT_OWNER_PID%' -ErrorAction SilentlyContinue; if ($null -ne $proc) { $proc.CommandLine }"`) do (
    set "PORT_OWNER_CMDLINE=%%C"
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

call :show_port_conflict %TARGET_PORT% %TARGET_LABEL%
exit /b 1

:check_existing_backend
set "BACKEND_STATUS=free"
call :load_port_owner 8000
if not defined PORT_OWNER_PID goto :eof

set "BACKEND_STATUS=busy"
echo(%PORT_OWNER_CMDLINE%| findstr /I /C:"uvicorn app.main:app" >nul
if errorlevel 1 goto :eof

powershell -NoProfile -Command "try { $content = (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/health -TimeoutSec 2).Content; if ($content -match '\"status\"\s*:\s*\"ok\"') { exit 0 } } catch {}; exit 1" >nul 2>nul
if errorlevel 1 goto :eof

set "BACKEND_STATUS=reuse"
goto :eof

:check_existing_frontend
set "FRONTEND_STATUS=free"
call :load_port_owner 8080
if not defined PORT_OWNER_PID goto :eof

set "FRONTEND_STATUS=busy"
echo(%PORT_OWNER_CMDLINE%| findstr /I /C:"vite" >nul
if errorlevel 1 goto :eof

set "FRONTEND_STATUS=reuse"
goto :eof

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

:start_all
call :detect_backend_python
if errorlevel 1 exit /b %errorlevel%
call :ensure_backend_dependencies
if errorlevel 1 exit /b %errorlevel%
call :check_existing_backend
if /I "%BACKEND_STATUS%"=="busy" (
    call :show_port_conflict 8000 backend
    exit /b 1
)
call :check_existing_frontend
if /I "%FRONTEND_STATUS%"=="busy" (
    call :show_port_conflict 8080 frontend
    exit /b 1
)
if /I not "%BACKEND_STATUS%"=="reuse" (
    call :ensure_java_runtime
    if errorlevel 1 exit /b %errorlevel%
    call :ensure_cdk_bundle
    if errorlevel 1 exit /b %errorlevel%
    echo Using backend Python: %BACKEND_PY_CMD%
    start "NMR Backend" cmd /k "cd /d ""%ROOT%backend"" && %BACKEND_PY_CMD% -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000"
) else (
    echo Backend already running on http://127.0.0.1:8000
)
if /I not "%FRONTEND_STATUS%"=="reuse" (
    start "NMR Frontend" cmd /k "cd /d ""%ROOT%frontend"" && npm run dev -- --host 127.0.0.1 --port 8080"
) else (
    echo Frontend already running on http://127.0.0.1:8080
)
echo Backend:  http://127.0.0.1:8000
echo Frontend: http://127.0.0.1:8080
goto :eof

:run_backend
call :detect_backend_python
if errorlevel 1 exit /b %errorlevel%
call :ensure_backend_dependencies
if errorlevel 1 exit /b %errorlevel%
call :ensure_port_free 8000 backend
if errorlevel 1 exit /b %errorlevel%
call :ensure_java_runtime
if errorlevel 1 exit /b %errorlevel%
call :ensure_cdk_bundle
if errorlevel 1 exit /b %errorlevel%
echo Using backend Python: %BACKEND_PY_CMD%
cd /d "%ROOT%backend"
%BACKEND_PY_CMD% -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
goto :eof

:run_frontend
call :ensure_port_free 8080 frontend
if errorlevel 1 exit /b %errorlevel%
cd /d "%ROOT%frontend"
npm run dev -- --host 127.0.0.1 --port 8080
goto :eof

:serve_combined
call :detect_backend_python
if errorlevel 1 exit /b %errorlevel%
call :ensure_backend_dependencies
if errorlevel 1 exit /b %errorlevel%
call :ensure_port_free 8000 combined server
if errorlevel 1 exit /b %errorlevel%
call :ensure_java_runtime
if errorlevel 1 exit /b %errorlevel%
call :ensure_cdk_bundle
if errorlevel 1 exit /b %errorlevel%
echo Using backend Python: %BACKEND_PY_CMD%
cd /d "%ROOT%frontend"
call npm run build
if errorlevel 1 exit /b %errorlevel%
cd /d "%ROOT%backend"
echo Serving the built frontend and API from http://127.0.0.1:8000
%BACKEND_PY_CMD% -m uvicorn app.main:app --host 127.0.0.1 --port 8000
goto :eof

:usage
echo Usage:
echo   run-nmr.bat           ^(same as: run-nmr.bat all^)
echo   run-nmr.bat all       Start backend and frontend dev servers in separate windows
echo   run-nmr.bat backend   Start only the FastAPI backend on port 8000
echo   run-nmr.bat frontend  Start only the Vite frontend on port 8080
echo   run-nmr.bat serve     Build the frontend, then serve frontend + API from FastAPI on port 8000
exit /b 1
