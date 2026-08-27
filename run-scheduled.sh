#!/bin/bash
# Runs attendance marking unattended (launchd), for a specific class session,
# then relies on mark-attendance.mjs's own --unattended path (see there) to
# email a report via Gmail -- this script itself does nothing but invoke the
# script and log stdout/stderr.
#
# DEPLOYED COPY: launchd actually executes ~/.attendance-sync/run-scheduled.sh,
# not this file. macOS TCC blocks background (non-GUI-session) processes from
# executing a script that lives inside ~/Documents (see
# docs/background-automation.md, gotcha #1) -- so the runtime copy lives
# outside it. Re-run this after editing this file:
#   cp scripts/attendance/run-scheduled.sh ~/.attendance-sync/run-scheduled.sh
#
# This is a LaunchAgent (runs in your logged-in GUI session), not a
# LaunchDaemon -- it has to be, since ensureParticipantsPanelOpen()/
# joinMeeting()/leaveMeeting() drive Zoom's actual UI via System Events +
# cliclick, which needs a real, unlocked GUI session to do anything. If the
# screen is locked or the Mac is asleep when this fires, the run will fail
# (accessibility calls against a locked session don't work) -- there is no
# lid-closed wake workaround wired up for this tool, unlike zoom-recordings,
# because unlike that headless Chrome-based sync, this task fundamentally
# needs the Zoom app and its window visible on an active display.
#
# --apply --unattended: writes for real (no dry-run review step in the
# unattended path -- see mark-attendance.mjs's --unattended flag for exactly
# what "ambiguous" causes it to skip rather than guess) and never blocks on
# a readline prompt.

set -euo pipefail

RUN_LOG=~/.attendance-sync/last-scheduled-run.log
echo "===== $(date "+%Y-%m-%d %H:%M:%S %Z") — scheduled run start (slot: ${1:-unlabeled}) =====" >> "$RUN_LOG"

set +e
node /Users/n0tv1cky/Documents/Personal/masters/projects/attendance/mark-attendance.mjs --apply --unattended >> "$RUN_LOG" 2>&1
run_exit=$?
set -e

echo "===== $(date "+%Y-%m-%d %H:%M:%S %Z") — scheduled run end (exit $run_exit) =====" >> "$RUN_LOG"
exit $run_exit
