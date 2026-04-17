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

:ensure_java_runtime
where java >nul 2>nul
if not errorlevel 1 goto :eof

dir /b /s "%ROOT%backend\vendor\java\jvm.dll" >nul 2>nul
if not errorlevel 1 goto :eof

echo No Java runtime found. Fetching portable Temurin 17...
%BACKEND_PY_CMD% "%ROOT%backend\scripts\fetch_java.py"
goto :eof

:ensure_cdk_bundle
set "CDK_DIR=%ROOT%backend\vendor\cdk"
if not exist "%CDK_DIR%" mkdir "%CDK_DIR%" >nul 2>nul
if not exist "%CDK_DIR%\cdk-2.9.jar" (
    echo CDK bundle missing. Fetching CDK jars...
    %BACKEND_PY_CMD% "%ROOT%backend\scripts\fetch_cdk.py"
    goto :eof
)

if not exist "%CDK_DIR%\predictorc.jar" if not exist "%CDK_DIR%\nmrshiftdb2.jar" (
    echo CDK predictor jar missing. Fetching CDK jars...
    %BACKEND_PY_CMD% "%ROOT%backend\scripts\fetch_cdk.py"
    goto :eof
)

if not exist "%CDK_DIR%\predictorh.jar" (
    echo CDK proton predictor jar missing. Fetching CDK jars...
    %BACKEND_PY_CMD% "%ROOT%backend\scripts\fetch_cdk.py"
)
goto :eof

:start_all
call :detect_backend_python
if errorlevel 1 exit /b %errorlevel%
call :ensure_backend_dependencies
if errorlevel 1 exit /b %errorlevel%
call :ensure_java_runtime
call :ensure_cdk_bundle
echo Using backend Python: %BACKEND_PY_CMD%
start "NMR Backend" cmd /k "cd /d ""%ROOT%backend"" && %BACKEND_PY_CMD% -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000"
start "NMR Frontend" cmd /k "cd /d ""%ROOT%frontend"" && npm run dev -- --host 127.0.0.1 --port 8080"
echo Backend:  http://127.0.0.1:8000
echo Frontend: http://127.0.0.1:8080
goto :eof

:run_backend
call :detect_backend_python
if errorlevel 1 exit /b %errorlevel%
call :ensure_backend_dependencies
if errorlevel 1 exit /b %errorlevel%
call :ensure_java_runtime
call :ensure_cdk_bundle
echo Using backend Python: %BACKEND_PY_CMD%
cd /d "%ROOT%backend"
%BACKEND_PY_CMD% -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
goto :eof

:run_frontend
cd /d "%ROOT%frontend"
npm run dev -- --host 127.0.0.1 --port 8080
goto :eof

:serve_combined
call :detect_backend_python
if errorlevel 1 exit /b %errorlevel%
call :ensure_backend_dependencies
if errorlevel 1 exit /b %errorlevel%
call :ensure_java_runtime
call :ensure_cdk_bundle
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
