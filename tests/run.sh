#!/bin/sh
# Runs the unit and replay tests. See tests/README.md for the optional browser tests.
set -e
cd "$(dirname "$0")/.."
node --test tests/
python3 -B tests/test_replay_bash.py
