@echo off
title DM Auto-Tag — Full Run
cd /d "C:\Users\santo\Documents\Scott\Scott"
echo ============================================
echo  DM Auto-Tag FULL RUN — all 4,016 messages
echo ============================================
echo.
echo  Run eval first (run_autotag_eval.bat) if
echo  you haven't already!
echo.
echo  Press any key to start, or Ctrl+C to abort
pause
node tool_scripts/autotag_dms.js
echo.
echo ============================================
echo  Done! Files written:
echo    data/dm_classified.json  (updated tags)
echo    data/dm_classified_backup_pre_autotag.json
echo    tool_scripts/autotag_dms_audit.json
echo ============================================
pause
