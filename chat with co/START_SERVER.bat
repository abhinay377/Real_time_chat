@echo off
title Chat With Co — Server
color 0A

echo.
echo  ============================================
echo    Chat With Co — Starting Server
echo  ============================================
echo.

:: Check Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Python not found!
    echo.
    echo  Please install Python from https://www.python.org/downloads/
    echo  Make sure to tick "Add Python to PATH" during install.
    echo.
    pause
    exit /b 1
)

:: Install required packages silently
echo  Installing required packages...
pip install websockets aiofiles --quiet

echo.
echo  Starting server...
echo  Open your browser at:  http://localhost:8080
echo.
echo  Press Ctrl+C to stop the server.
echo.

:: Run the server from the same folder as this batch file
cd /d "%~dp0"
python server.py

pause
