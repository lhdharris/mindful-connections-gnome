#!/bin/bash
# /usr/lib/systemd/system-sleep/mindful-connections
# Runs as root before every suspend/hibernate/hybrid-sleep.
# Resets Mindful Connections to LOCKED so time doesn't silently pass.

TIMER_SCRIPT="__INSTALL_DIR__/mindful_timer.py"

case "$1" in
    pre)
        # System is going to sleep — lock down immediately
        /usr/bin/python3 "$TIMER_SCRIPT" --action lock
        ;;
    post)
        # System resumed — nothing extra needed; user must click the button
        ;;
esac
