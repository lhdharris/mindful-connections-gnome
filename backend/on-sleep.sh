#!/bin/bash
# /usr/lib/systemd/system-sleep/mindful-connections
# Runs as root before every suspend/hibernate/hybrid-sleep.
# On sleep: lock down. On wake: re-open if a routine slot is active.

TIMER_SCRIPT="__INSTALL_DIR__/mindful_timer.py"

case "$1" in
    pre)
        # System is going to sleep — lock down immediately
        /usr/bin/python3 "$TIMER_SCRIPT" --action lock
        ;;
    post)
        # System resumed — open internet if current time is a scheduled routine slot,
        # otherwise stay locked.
        /usr/bin/python3 "$TIMER_SCRIPT" --action routine-check
        ;;
esac
