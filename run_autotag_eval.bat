@echo off
title DM Auto-Tag — Eval Pass
cd /d "C:\Users\santo\Documents\Scott\Scott"
echo ============================================
echo  DM Auto-Tag EVAL — validating tag quality
echo ============================================
echo.
node tool_scripts/autotag_dms.js --eval
echo.
echo ============================================
echo  Eval complete. Results saved to:
echo  tool_scripts/autotag_dms_eval.json
echo ============================================
pause
