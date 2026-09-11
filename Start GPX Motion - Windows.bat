@echo off
setlocal
title GPX Motion
cd /d "%~dp0"

if not exist "app\server.py" goto missing_files

py -3 --version >nul 2>nul
if not errorlevel 1 goto run_py_launcher

python --version 2>&1 | findstr /B /C:"Python 3." >nul
if not errorlevel 1 goto run_python

goto missing_python

:run_py_launcher
py -3 -u app\server.py
set "APP_EXIT=%errorlevel%"
goto app_stopped

:run_python
python -u app\server.py
set "APP_EXIT=%errorlevel%"
goto app_stopped

:missing_files
echo GPX Motion cannot find app\server.py.
echo Extract the complete GPX_Motion folder before starting the application.
echo Do not run this file from inside a ZIP archive.
pause
exit /b 1

:missing_python
echo Python 3 was not found.
echo Install Python 3 from https://www.python.org/downloads/ and enable "Add Python to PATH".
pause
exit /b 1

:app_stopped
echo.
if "%APP_EXIT%"=="0" (
  echo GPX Motion has stopped.
) else (
  echo GPX Motion stopped because of the error shown above.
  echo You can copy that error message when asking for help.
)
pause
exit /b %APP_EXIT%
